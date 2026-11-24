import "server-only";
import type { AgentResult, ConversationState, IncomingMessage, TherapistContext } from "@/lib/agents/types";
import { extractEvaluation, reviseEvaluation } from "@/lib/ai/intake-extract";
import type { Therapist } from "@/lib/db/types";
import { deleteTwilioMedia, downloadMedia } from "@/lib/whatsapp/media";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import {
  appendEvalInput, confirmEvaluation, createEvalDraft, deleteEvalDraft, evalStatus, loadEvalDraft, setEvalFields,
  setEvalSource, type EvalDraft, type LoadedEval,
} from "./eval-store";
import {
  EVAL_REVIEW_OPTIONS, EVAL_SOURCE_OPTIONS, PAGES_OPTIONS, PHOTO_PROMPT, evalVoiceGuide, formatEvaluationReview,
  formatPageAck,
} from "./intake-format";
import { isConfirmWord, isDoneWord, mergeRevision } from "./note-draft";
import { RECORDING_OPTIONS, VOICE_OPTIONS, formatAck, formatCorrectionAck } from "./note-format";
import { getPatient } from "./patient-store";
import { looksLikeName, matchPatients, patientLabel, type PatientRef } from "./patient-match";
import { clinicPatients, recentPatients } from "./patient-picker";
import { noteFrom } from "./session-note";

// Flow A, piece 3: the initial evaluation ("Valoración inicial") from photos of the clinic's
// paper Historia Clínica or from voice notes. Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-24-flow-a-design.md. Photos are read in memory and
// deleted from Twilio once read; only the structured fields are saved, on Confirmar.

const FLOW = "initial_eval";
const MAX_PAGES = 6;
type Step = "pick_patient" | "disambiguate" | "choose_source" | "pages" | "recording" | "fixing" | "review" | "editing";

interface Ctx {
  patientId?: string;
  evalId?: string;
  candidates?: PatientRef[];
  fixOf?: number;
}

const state = (step: Step, context: Ctx = {}): AgentResult => ({
  nextState: { flow: FLOW, step, context: context as Record<string, unknown> },
});
const done = (): AgentResult => ({ nextState: null });
const isImage = (m: IncomingMessage) => m.media.find((x) => x.contentType.startsWith("image/"));
const isAudio = (m: IncomingMessage) => m.media.some((x) => x.contentType.startsWith("audio/"));

// ---------------------------------------------------------------- entry points

/** Menu 🩺 Valoración inicial: pick the patient first. */
export async function startInitialEval(ctx: TherapistContext): Promise<AgentResult> {
  const patients = await recentPatients(ctx.therapist.id);
  const intro = "🩺 ¿De qué paciente es la valoración inicial?";
  if (!patients.length) await sendText(ctx.message.phone, `${intro} Escribe su nombre.`);
  else
    await sendOptions(
      ctx.message.phone,
      `${intro} Elige un número o escribe el nombre.`,
      patients.map((p) => ({ id: p.id, title: patientLabel(p, patients) })),
    );
  return state("pick_patient", { candidates: patients });
}

/** After registering a patient: offer the evaluation now or later. No draft until they choose. */
export async function offerEvaluation(phone: string, patient: { id: string; full_name: string }): Promise<AgentResult> {
  await sendOptions(phone, `¿Agregamos la valoración inicial de *${patient.full_name}*?`, EVAL_SOURCE_OPTIONS);
  return state("choose_source", { patientId: patient.id });
}

/** Straight to the evaluation for a known patient (from a duplicate number in Flow A). */
export async function startEvaluationFor(
  phone: string,
  _therapist: Therapist,
  patient: { id: string; full_name: string },
): Promise<AgentResult> {
  await sendOptions(phone, `🩺 Valoración inicial de *${patient.full_name}*. ¿Cómo me la pasas?`, EVAL_SOURCE_OPTIONS);
  return state("choose_source", { patientId: patient.id });
}

export async function handleInitialEval(ctx: TherapistContext): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const current = ctx.state as ConversationState;
  const step = current.step as Step;
  const c = current.context as Ctx;
  const pick = (options: Option[]) => matchOption(message.buttonPayload ?? message.body, options);

  switch (step) {
    case "pick_patient":
    case "disambiguate": {
      const candidates = c.candidates ?? [];
      const byNumber = pick(candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })));
      if (byNumber) return chosen(phone, candidates.find((p) => p.id === byNumber.id)!);
      if (!looksLikeName(message.body)) {
        await sendText(phone, "Elige un número de la lista o escribe el nombre del paciente.");
        return state(step, c);
      }
      const pool = step === "disambiguate" ? candidates : await clinicPatients(therapist.clinic_id);
      const hits = matchPatients(message.body, pool);
      if (hits.length === 1) return chosen(phone, hits[0]);
      if (!hits.length) {
        await sendText(phone, `No encontré a «${message.body.trim()}». Escribe el nombre completo.`);
        return state(step, c);
      }
      await sendOptions(phone, "¿Cuál de ellos?", hits.slice(0, 8).map((p) => ({ id: p.id, title: patientLabel(p, hits) })));
      return state("disambiguate", { candidates: hits.slice(0, 8) });
    }

    case "choose_source":
      return chooseSource(ctx, c);

    default: {
      if (!c.evalId) return gone(phone, null);
      const loaded = await loadEvalDraft(c.evalId);
      if (!loaded) return gone(phone, c.evalId);
      if (step === "pages") return pages(message, loaded);
      if (step === "recording") return recording(message, loaded);
      if (step === "fixing") return fixing(message, loaded, c.fixOf ?? noteCount(loaded.draft));
      return reviewOrEdit(message, loaded, step === "editing" ? "editing" : "review");
    }
  }
}

async function chosen(phone: string, patient: PatientRef): Promise<AgentResult> {
  await sendOptions(phone, `🩺 Valoración inicial de *${patient.full_name}*. ¿Cómo me la pasas?`, EVAL_SOURCE_OPTIONS);
  return state("choose_source", { patientId: patient.id });
}

// ---------------------------------------------------------------- choosing photo or voice

async function chooseSource(ctx: TherapistContext, c: Ctx): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const patient = c.patientId ? await getPatient(c.patientId) : null;
  if (!patient) return gone(phone, null);
  const choice = matchOption(message.buttonPayload ?? message.body, EVAL_SOURCE_OPTIONS);

  if (choice?.id === "later") {
    await sendText(phone, "Va. Puedes hacerla después desde el menú: 🩺 Valoración inicial.");
    return done();
  }
  const photo = choice?.id === "photo" || !!isImage(message);
  const voice = choice?.id === "voice" || isAudio(message);
  if (!photo && !voice) {
    await sendOptions(phone, `¿Cómo me pasas la valoración inicial de *${patient.full_name}*?`, EVAL_SOURCE_OPTIONS);
    return state("choose_source", c);
  }

  const evalId = await createEvalDraft(therapist.id, patient.id);
  await setEvalSource(evalId, photo ? "photo" : "voice");
  await setEvalFields(evalId, { step: photo ? "pages" : "recording" });
  const loaded = (await loadEvalDraft(evalId))!;
  if (photo) {
    if (isImage(message)) return pages(message, loaded); // the first page came straight away
    await sendText(phone, PHOTO_PROMPT);
    return state("pages", { evalId });
  }
  if (isAudio(message)) return recording(message, loaded);
  await sendText(phone, evalVoiceGuide(patient.full_name));
  return state("recording", { evalId });
}

// ---------------------------------------------------------------- photo path

async function pages(message: IncomingMessage, loaded: LoadedEval): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const image = isImage(message);
  if (image) {
    if (pageInputs(loaded.draft).length >= MAX_PAGES) {
      await sendOptions(phone, `Ya tengo ${MAX_PAGES} páginas, el máximo. Responde *Listo* para leerlas.`, PAGES_OPTIONS);
      return state("pages", { evalId });
    }
    const count = await appendEvalInput(evalId, {
      kind: "page",
      media_url: image.url,
      content_type: image.contentType,
      received_at: message.receivedAt.toISOString(),
    });
    await sendOptions(phone, formatPageAck(count), PAGES_OPTIONS);
    return state("pages", { evalId });
  }
  const choice = matchOption(message.buttonPayload ?? message.body, PAGES_OPTIONS);
  if (choice?.id === "more") {
    await sendText(phone, "📷 Adelante, manda la siguiente página.");
    return state("pages", { evalId });
  }
  if (choice?.id === "done" || isDoneWord(message.body)) return readPages(phone, loaded);
  await sendOptions(phone, "Manda la foto de la siguiente página o responde *Listo*.", PAGES_OPTIONS);
  return state("pages", { evalId });
}

async function readPages(phone: string, loaded: LoadedEval): Promise<AgentResult> {
  const evalId = loaded.row.id;
  const fresh = (await loadEvalDraft(evalId)) ?? loaded; // pages may have landed since this message started
  const list = pageInputs(fresh.draft);
  if (!list.length) {
    await sendText(phone, "Aún no tengo fotos. Manda la primera hoja de la historia clínica.");
    return state("pages", { evalId });
  }
  await sendText(phone, "Un momento, leo el formato…");
  try {
    const images = await Promise.all(list.map((p) => downloadMedia(p.media_url)));
    const extraction = await extractEvaluation({ images }, fresh.patient.full_name);
    // Read: the photos are not needed again (corrections work on the fields), so delete them.
    await Promise.all(list.map((p) => deleteTwilioMedia(p.media_url)));
    const draft: EvalDraft = { ...fresh.draft, extraction, step: "review", pages_deleted: true };
    await setEvalFields(evalId, { extraction, step: "review", pages_deleted: true });
    await sendReview(phone, { ...fresh, draft });
    return state("review", { evalId });
  } catch (err) {
    console.error("[initial-eval] reading pages failed", evalId, err);
    await sendOptions(phone, "No pude leer las fotos. Responde *Listo* para intentarlo otra vez, o mándalas de nuevo.", PAGES_OPTIONS);
    return state("pages", { evalId });
  }
}

// ---------------------------------------------------------------- voice path

async function recording(message: IncomingMessage, loaded: LoadedEval): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const choice = matchOption(message.buttonPayload ?? message.body, VOICE_OPTIONS);
  if (choice?.id === "more") {
    await sendText(phone, "Adelante.");
    return state("recording", { evalId });
  }
  if (choice?.id === "fix") {
    const last = noteCount(loaded.draft);
    if (!last) {
      await sendText(phone, "Aún no tengo ninguna nota que corregir.");
      return state("recording", { evalId });
    }
    await sendText(phone, `✏️ ¿Qué dijiste en realidad en la nota ${last}? Escríbelo o mándalo otra vez por voz.`);
    return state("fixing", { evalId, fixOf: last });
  }
  if (choice?.id === "done") return processNotes(phone, loaded);
  if (isImage(message)) {
    await sendText(phone, "Esta valoración va por voz. Si prefieres fotos, descártala y elige 📷 desde el menú.");
    return state("recording", { evalId });
  }
  const note = await noteFrom(message);
  if (!note || !note.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿La mandas otra vez o la escribes?");
    return state("recording", { evalId });
  }
  if (isDoneWord(note.text)) return processNotes(phone, loaded);
  await appendEvalInput(evalId, { kind: "note", ...note });
  const parts = formatAck(loaded.patient.full_name, noteCount(loaded.draft) + 1, note.audio_url ? note.text : undefined);
  for (const part of parts.slice(0, -1)) await sendText(phone, part);
  await sendOptions(phone, parts[parts.length - 1], note.audio_url ? VOICE_OPTIONS : RECORDING_OPTIONS);
  return state("recording", { evalId });
}

async function fixing(message: IncomingMessage, loaded: LoadedEval, fixOf: number): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const note = await noteFrom(message);
  if (!note || !note.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes la corrección?");
    return state("fixing", { evalId, fixOf });
  }
  if (isDoneWord(note.text)) return processNotes(phone, loaded);
  await appendEvalInput(evalId, { kind: "note", ...note, text: `Corrección de la nota ${fixOf}: ${note.text}` });
  const echo = note.audio_url ? `\n«${note.text.trim()}»` : "";
  await sendOptions(phone, `${formatCorrectionAck(fixOf)}${echo}`, RECORDING_OPTIONS);
  return state("recording", { evalId });
}

async function processNotes(phone: string, loaded: LoadedEval): Promise<AgentResult> {
  const evalId = loaded.row.id;
  const fresh = (await loadEvalDraft(evalId)) ?? loaded;
  const transcripts = notes(fresh.draft).map((n) => n.text);
  if (!transcripts.length) {
    await sendText(phone, "Aún no tengo ninguna nota. Mándala por voz o texto.");
    return state("recording", { evalId });
  }
  await sendText(phone, "Un momento, preparo la valoración…");
  try {
    const extraction = await extractEvaluation({ transcripts }, fresh.patient.full_name);
    const draft: EvalDraft = { ...fresh.draft, extraction, step: "review" };
    await setEvalFields(evalId, { extraction, step: "review" });
    await sendReview(phone, { ...fresh, draft });
    return state("review", { evalId });
  } catch (err) {
    console.error("[initial-eval] extraction failed", evalId, err);
    await sendOptions(phone, "No pude preparar la valoración. Responde *Listo* para intentarlo otra vez.", RECORDING_OPTIONS);
    return state("recording", { evalId });
  }
}

// ---------------------------------------------------------------- review, corrections, confirm

async function reviewOrEdit(message: IncomingMessage, loaded: LoadedEval, step: "review" | "editing"): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const e = loaded.draft.extraction;
  if (!e) return loaded.draft.source === "photo" ? readPages(phone, loaded) : processNotes(phone, loaded);

  const choice = matchOption(message.buttonPayload ?? message.body, EVAL_REVIEW_OPTIONS);
  if (choice?.id === "confirm" || (!choice && isConfirmWord(message.body))) return confirm(phone, loaded);
  if (choice?.id === "discard") {
    if (loaded.draft.source === "photo" && !loaded.draft.pages_deleted) {
      await Promise.all(pageInputs(loaded.draft).map((p) => deleteTwilioMedia(p.media_url)));
    }
    await deleteEvalDraft(evalId);
    await sendText(phone, "Valoración descartada. No se guardó nada.");
    return done();
  }
  if (choice?.id === "fix") {
    await setEvalFields(evalId, { step: "editing" });
    await sendText(phone, "✏️ ¿Qué corrijo? Escríbelo o dilo, p. ej. «la flexión de rodilla izquierda fue 120».");
    return state("editing", { evalId });
  }

  const correction = await noteFrom(message);
  if (!correction || !correction.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes el cambio?");
    return state(step, { evalId });
  }
  try {
    const revised = await reviseEvaluation(e, correction.text, loaded.patient.full_name);
    const merged = mergeRevision(e, revised.evaluation, revised.changed);
    if (!merged.applied) {
      await sendText(phone, "No entendí qué cambiar. Dímelo de otra forma, p. ej. «la flexión de rodilla izquierda fue 120».");
      await setEvalFields(evalId, { step: "review" });
      await sendReview(phone, loaded);
      return state("review", { evalId });
    }
    const draft: EvalDraft = { ...loaded.draft, extraction: merged.note, step: "review" };
    await setEvalFields(evalId, { extraction: merged.note, step: "review" });
    await sendReview(phone, { ...loaded, draft });
    return state("review", { evalId });
  } catch (err) {
    console.error("[initial-eval] correction failed", evalId, err);
    await sendText(phone, "No pude aplicar el cambio. ¿Me lo dices otra vez?");
    return state(step, { evalId });
  }
}

async function sendReview(phone: string, loaded: LoadedEval): Promise<void> {
  const parts = formatEvaluationReview(loaded.patient.full_name, loaded.draft.extraction!, {
    fromPhoto: loaded.draft.source === "photo",
  });
  for (const part of parts.slice(0, -1)) await sendText(phone, part);
  await sendOptions(phone, parts[parts.length - 1], EVAL_REVIEW_OPTIONS);
}

async function confirm(phone: string, loaded: LoadedEval): Promise<AgentResult> {
  const transcripts = notes(loaded.draft).map((n) => n.text);
  const result = await confirmEvaluation(loaded.row.id, loaded.draft.extraction!, {
    source_transcript: transcripts.length ? transcripts.join("\n\n") : null,
    page_count: loaded.draft.source === "photo" ? pageInputs(loaded.draft).length : null,
  });
  if (result === "already_confirmed") await sendText(phone, "Esta valoración ya estaba guardada.");
  else if (result === "not_found") await sendText(phone, "Esa valoración ya no está abierta.");
  else await sendText(phone, `✅ Valoración inicial guardada en el expediente de *${loaded.patient.full_name}*.`);
  return done();
}

// ---------------------------------------------------------------- helpers

async function gone(phone: string, evalId: string | null): Promise<AgentResult> {
  if (evalId && (await evalStatus(evalId)) === "confirmed") await sendText(phone, "Esta valoración ya estaba guardada.");
  else await sendText(phone, "Esa valoración ya no está abierta. Escribe *menu* para empezar.");
  return done();
}

const pageInputs = (d: EvalDraft) =>
  d.inputs.filter((i): i is Extract<EvalDraft["inputs"][number], { kind: "page" }> => i.kind === "page");
const notes = (d: EvalDraft) =>
  d.inputs.filter((i): i is Extract<EvalDraft["inputs"][number], { kind: "note" }> => i.kind === "note");
/** Notes the therapist sent (corrections excluded), for "nota N". */
const noteCount = (d: EvalDraft) => notes(d).filter((n) => !n.text.startsWith("Corrección de la nota ")).length;
