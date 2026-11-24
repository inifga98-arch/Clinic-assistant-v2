import "server-only";
import type { AgentResult, ConversationState, IncomingMessage, TherapistContext } from "@/lib/agents/types";
import { extractEvaluation, reviseEvaluation } from "@/lib/ai/intake-extract";
import type { EvaluationExtraction } from "@/lib/ai/intake-schema";
import type { Therapist } from "@/lib/db/types";
import { deleteTwilioMedia, downloadMedia } from "@/lib/whatsapp/media";
import { matchOption, sendOptions, sendText } from "@/lib/whatsapp/send";
import {
  appendEvalInput, confirmEvaluation, createEvalDraft, deleteEvalDraft, evalStatus, loadEvalDraft, openEvalDrafts,
  setEvalFields, setEvalSource, type LoadedEval,
} from "./eval-store";
import {
  EVAL_CONFIRM_QUESTION, EVAL_REVIEW_OPTIONS, EVAL_SOURCE_OPTIONS, PAGES_OPTIONS, PHOTO_PROMPT, evalVoiceGuide, formatEvaluationReview,
  formatPageAck,
} from "./intake-format";
import { evaluationGaps, lateInputs, type EvalDraft, type EvalInput } from "./intake-logic";
import { isConfirmWord, isDoneWord, mergeRevision } from "./note-draft";
import { RECORDING_OPTIONS, VOICE_OPTIONS, formatAck, formatCorrectionAck } from "./note-format";
import { looksLikeName, matchPatients, patientLabel, type PatientRef } from "./patient-match";
import { clinicPatients, recentPatients } from "./patient-picker";
import { offerNextStep } from "./next-step";
import { noteFrom } from "./session-note";

// Flow A, piece 3: the initial evaluation ("Valoración inicial") from photos of the clinic's
// paper Historia Clínica or from voice notes. Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-24-flow-a-design.md.
//
// Concurrency (each WhatsApp message runs on its own, with no lock per phone):
// - The draft is created when the evaluation is offered, so photos sent together (a
//   multi-select) all land in the same draft.
// - The draft's step is "reading" while an extraction runs; anything that arrives then is late.
//   Late notes are added to the evaluation before saving; late pages are deleted and the
//   therapist is told.
// Privacy: no form photo is kept. Pages are deleted from Twilio once their reading is saved,
// on Descartar, when a new evaluation starts (abandoned drafts), and a photo sent where it
// isn't used is deleted at once.

const FLOW = "initial_eval";
const MAX_PAGES = 6;
/** How long a page waits for more photos of the same multi-select before acknowledging. */
const ACK_SETTLE_MS = 2500;
type Step = "pick_patient" | "disambiguate" | "choose_source" | "pages" | "recording" | "fixing" | "review" | "editing";

interface Ctx {
  evalId?: string;
  candidates?: PatientRef[];
  fixOf?: number;
}

const state = (step: Step, context: Ctx = {}): AgentResult => ({
  nextState: { flow: FLOW, step, context: context as Record<string, unknown> },
});
const done = (): AgentResult => ({ nextState: null });
const imageOf = (m: IncomingMessage) => m.media.find((x) => x.contentType.startsWith("image/"));
const hasAudio = (m: IncomingMessage) => m.media.some((x) => x.contentType.startsWith("audio/"));
const pageInputs = (d: EvalDraft) => d.inputs.filter((i): i is Extract<EvalInput, { kind: "page" }> => i.kind === "page");
const noteInputs = (d: EvalDraft) => d.inputs.filter((i): i is Extract<EvalInput, { kind: "note" }> => i.kind === "note");
/** Notes the therapist sent (corrections excluded), for "nota N". */
const noteCount = (d: EvalDraft) => noteInputs(d).filter((n) => !n.text.startsWith("Corrección de la nota ")).length;

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

/** After registering a patient: offer the evaluation now or later. */
export async function offerEvaluation(phone: string, therapist: Therapist, patient: { id: string; full_name: string }) {
  return openDraft(phone, therapist, patient, `¿Agregamos la valoración inicial de *${patient.full_name}*?`);
}

/** Straight to the evaluation for a known patient (from a duplicate number in Flow A). */
export async function startEvaluationFor(phone: string, therapist: Therapist, patient: { id: string; full_name: string }) {
  return openDraft(phone, therapist, patient, `🩺 Valoración inicial de *${patient.full_name}*. ¿Cómo me la pasas?`);
}

/** Clean up the therapist's abandoned drafts (and their photos), then open a fresh one. */
async function openDraft(phone: string, therapist: Therapist, patient: { id: string }, question: string): Promise<AgentResult> {
  for (const old of await openEvalDrafts(therapist.id)) {
    await Promise.all(pageInputs(old.draft).map((p) => deleteTwilioMedia(p.media_url)));
    await deleteEvalDraft(old.id);
  }
  const evalId = await createEvalDraft(therapist.id, patient.id);
  await sendOptions(phone, question, EVAL_SOURCE_OPTIONS);
  return state("choose_source", { evalId });
}

export async function handleInitialEval(ctx: TherapistContext): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const current = ctx.state as ConversationState;
  const step = current.step as Step;
  const c = current.context as Ctx;

  if (step === "pick_patient" || step === "disambiguate") {
    if (await dropStrayImage(message)) return state(step, c);
    const candidates = c.candidates ?? [];
    const byNumber = matchOption(message.buttonPayload ?? message.body, candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })));
    if (byNumber) return chosen(phone, therapist, candidates.find((p) => p.id === byNumber.id)!);
    if (!looksLikeName(message.body)) {
      await sendText(phone, "Elige un número de la lista o escribe el nombre del paciente.");
      return state(step, c);
    }
    const pool = step === "disambiguate" ? candidates : await clinicPatients(therapist.clinic_id);
    const hits = matchPatients(message.body, pool);
    if (hits.length === 1) return chosen(phone, therapist, hits[0]);
    if (!hits.length) {
      await sendText(phone, `No encontré a «${message.body.trim()}». Escribe el nombre completo.`);
      return state(step, c);
    }
    await sendOptions(phone, "¿Cuál de ellos?", hits.slice(0, 8).map((p) => ({ id: p.id, title: patientLabel(p, hits) })));
    return state("disambiguate", { candidates: hits.slice(0, 8) });
  }

  if (!c.evalId) return gone(phone, null);
  const loaded = await loadEvalDraft(c.evalId);
  if (!loaded) {
    await dropStrayImage(message);
    return gone(phone, c.evalId);
  }
  switch (step) {
    case "choose_source":
      return chooseSource(message, loaded);
    case "pages":
      return pages(message, loaded);
    case "recording":
      return recording(message, loaded);
    case "fixing":
      return fixing(message, loaded, c.fixOf ?? noteCount(loaded.draft));
    default:
      return reviewOrEdit(message, loaded, step === "editing" ? "editing" : "review");
  }
}

async function chosen(phone: string, therapist: Therapist, patient: PatientRef): Promise<AgentResult> {
  return openDraft(phone, therapist, patient, `🩺 Valoración inicial de *${patient.full_name}*. ¿Cómo me la pasas?`);
}

// ---------------------------------------------------------------- choosing photo or voice

async function chooseSource(message: IncomingMessage, loaded: LoadedEval): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const choice = matchOption(message.buttonPayload ?? message.body, EVAL_SOURCE_OPTIONS);

  if (choice?.id === "later") {
    await deleteEvalDraft(evalId);
    return offerNextStep(phone, "after_later", "Va. Puedes hacerla después desde el menú: 🩺 Valoración inicial.", null);
  }
  const photo = choice?.id === "photo" || !!imageOf(message);
  const voice = choice?.id === "voice" || hasAudio(message);
  if (!photo && !voice) {
    await sendOptions(phone, `¿Cómo me pasas la valoración inicial de *${loaded.patient.full_name}*?`, EVAL_SOURCE_OPTIONS);
    return state("choose_source", { evalId });
  }
  // Idempotent: photos sent together each get here; they all set the same source on the same draft.
  await setEvalSource(evalId, photo ? "photo" : "voice");
  if (loaded.draft.step === "choose_source") await setEvalFields(evalId, { step: photo ? "pages" : "recording" });
  const fresh = (await loadEvalDraft(evalId))!;
  if (photo) {
    if (imageOf(message)) return pages(message, fresh); // the first page came straight away
    await sendText(phone, PHOTO_PROMPT);
    return state("pages", { evalId });
  }
  if (hasAudio(message)) return recording(message, fresh);
  await sendText(phone, evalVoiceGuide(loaded.patient.full_name));
  return state("recording", { evalId });
}

// ---------------------------------------------------------------- photo path

const LATE_PAGE =
  "📷 Esa página llegó cuando ya estaba leyendo el formato; no la incluí y la borré. " +
  "Si falta algo, corrígelo con ✏️ cuando veas la valoración.";

async function pages(message: IncomingMessage, loaded: LoadedEval): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  const image = imageOf(message);
  const reading = loaded.draft.step !== "pages" && loaded.draft.step !== "choose_source";

  if (image) {
    if (reading) {
      await deleteTwilioMedia(image.url);
      await sendText(phone, LATE_PAGE);
      return state(loaded.draft.step === "review" || loaded.draft.step === "editing" ? loaded.draft.step : "pages", { evalId });
    }
    if (pageInputs(loaded.draft).length >= MAX_PAGES) {
      await deleteTwilioMedia(image.url);
      await sendOptions(phone, `Ya tengo ${MAX_PAGES} páginas, el máximo; esa no la guardé. Responde *Listo* para leerlas.`, PAGES_OPTIONS);
      return state("pages", { evalId });
    }
    const count = await appendEvalInput(evalId, {
      kind: "page",
      media_url: image.url,
      content_type: image.contentType,
      received_at: message.receivedAt.toISOString(),
    });
    const now = await loadEvalDraft(evalId);
    if (now && now.draft.step !== "pages") {
      await deleteTwilioMedia(image.url); // reading started meanwhile: this page won't be read
      await sendText(phone, LATE_PAGE);
      return state("pages", { evalId });
    }
    // Photos sent together arrive as separate messages: wait a moment, and only the last one to
    // arrive answers, with the total, so the therapist gets one acknowledgement, not one per photo.
    await new Promise((r) => setTimeout(r, ACK_SETTLE_MS));
    const settled = await loadEvalDraft(evalId);
    const latest = settled ? pageInputs(settled.draft).at(-1) : undefined;
    if (latest && latest.media_url !== image.url) return state("pages", { evalId });
    await sendOptions(phone, formatPageAck(settled ? pageInputs(settled.draft).length : count), PAGES_OPTIONS);
    return state("pages", { evalId });
  }

  const choice = matchOption(message.buttonPayload ?? message.body, PAGES_OPTIONS);
  if (choice?.id === "discard") return discard(phone, loaded);
  if (choice?.id === "more") {
    await sendText(phone, "📷 Adelante, manda la siguiente página.");
    return state("pages", { evalId });
  }
  if (choice?.id === "done" || isDoneWord(message.body)) return readPages(phone, evalId);
  await sendOptions(phone, "Manda la foto de la siguiente página o responde *Listo*.", PAGES_OPTIONS);
  return state("pages", { evalId });
}

async function readPages(phone: string, evalId: string): Promise<AgentResult> {
  const fresh = await loadEvalDraft(evalId);
  if (!fresh) return gone(phone, evalId);
  if (fresh.draft.extraction) {
    await sendReview(phone, fresh); // already read (e.g. a retry after the review failed to send)
    return state("review", { evalId });
  }
  if (fresh.draft.step === "reading") {
    await sendText(phone, "Ya estoy leyendo el formato, un momento…");
    return state("pages", { evalId });
  }
  const list = pageInputs(fresh.draft);
  if (!list.length) {
    await sendText(phone, "Aún no tengo fotos. Manda la primera hoja de la historia clínica.");
    return state("pages", { evalId });
  }
  await setEvalFields(evalId, { step: "reading" });
  await sendText(phone, "Un momento, leo el formato…");
  let extraction: EvaluationExtraction;
  try {
    const images = await Promise.all(list.map((p) => downloadMedia(p.media_url)));
    extraction = await extractEvaluation({ images }, fresh.patient.full_name);
  } catch (err) {
    console.error("[initial-eval] reading pages failed", evalId, err);
    await setEvalFields(evalId, { step: "pages" });
    await sendOptions(phone, "No pude leer las fotos. Responde *Listo* para intentarlo otra vez, o mándalas de nuevo.", PAGES_OPTIONS);
    return state("pages", { evalId });
  }
  // Save the reading first; only then delete the photos (a retry can show the saved review).
  await setEvalFields(evalId, { extraction, step: "review", extracted_count: fresh.draft.inputs.length });
  await Promise.all(list.map((p) => deleteTwilioMedia(p.media_url)));
  await setEvalFields(evalId, { pages_deleted: true });
  const now = (await loadEvalDraft(evalId)) ?? fresh;
  const latePages = lateInputs(now.draft).filter((i): i is Extract<EvalInput, { kind: "page" }> => i.kind === "page");
  if (latePages.length) {
    await Promise.all(latePages.map((p) => deleteTwilioMedia(p.media_url)));
    await sendText(phone, LATE_PAGE);
  }
  await sendReview(phone, now);
  return state("review", { evalId });
}

// ---------------------------------------------------------------- voice path

async function recording(message: IncomingMessage, loaded: LoadedEval): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  if (await dropStrayImage(message)) return state("recording", { evalId });
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
  if (choice?.id === "done") return processNotes(phone, evalId);
  const note = await noteFrom(message);
  if (!note || !note.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿La mandas otra vez o la escribes?");
    return state("recording", { evalId });
  }
  if (isDoneWord(note.text)) return processNotes(phone, evalId);
  await appendEvalInput(evalId, { kind: "note", ...note });
  const now = await loadEvalDraft(evalId);
  if (now && now.draft.step !== "recording") {
    // "Listo" was processed meanwhile: the note goes in before saving (see confirm).
    await sendText(phone, "Recibí otra nota; la agrego a la valoración antes de guardar.");
    return state(now.draft.step === "editing" ? "editing" : "review", { evalId });
  }
  const parts = formatAck(loaded.patient.full_name, noteCount(loaded.draft) + 1, note.audio_url ? note.text : undefined);
  for (const part of parts.slice(0, -1)) await sendText(phone, part);
  await sendOptions(phone, parts[parts.length - 1], note.audio_url ? VOICE_OPTIONS : RECORDING_OPTIONS);
  return state("recording", { evalId });
}

async function fixing(message: IncomingMessage, loaded: LoadedEval, fixOf: number): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  if (await dropStrayImage(message)) return state("fixing", { evalId, fixOf });
  const note = await noteFrom(message);
  if (!note || !note.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes la corrección?");
    return state("fixing", { evalId, fixOf });
  }
  if (isDoneWord(note.text)) return processNotes(phone, evalId);
  await appendEvalInput(evalId, { kind: "note", ...note, text: `Corrección de la nota ${fixOf}: ${note.text}` });
  const echo = note.audio_url ? `\n«${note.text.trim()}»` : "";
  await sendOptions(phone, `${formatCorrectionAck(fixOf)}${echo}`, RECORDING_OPTIONS);
  return state("recording", { evalId });
}

async function processNotes(phone: string, evalId: string): Promise<AgentResult> {
  const fresh = await loadEvalDraft(evalId);
  if (!fresh) return gone(phone, evalId);
  if (fresh.draft.extraction) {
    await sendReview(phone, fresh);
    return state("review", { evalId });
  }
  if (fresh.draft.step === "reading") {
    await sendText(phone, "Ya estoy preparando la valoración, un momento…");
    return state("recording", { evalId });
  }
  const transcripts = noteInputs(fresh.draft).map((n) => n.text);
  if (!transcripts.length) {
    await sendText(phone, "Aún no tengo ninguna nota. Mándala por voz o texto.");
    return state("recording", { evalId });
  }
  await setEvalFields(evalId, { step: "reading" });
  await sendText(phone, "Un momento, preparo la valoración…");
  try {
    const extraction = await extractEvaluation({ transcripts }, fresh.patient.full_name);
    await setEvalFields(evalId, { extraction, step: "review", extracted_count: fresh.draft.inputs.length });
    await sendReview(phone, { ...fresh, draft: { ...fresh.draft, extraction, step: "review" } });
    return state("review", { evalId });
  } catch (err) {
    console.error("[initial-eval] extraction failed", evalId, err);
    await setEvalFields(evalId, { step: "recording" });
    await sendOptions(phone, "No pude preparar la valoración. Responde *Listo* para intentarlo otra vez.", RECORDING_OPTIONS);
    return state("recording", { evalId });
  }
}

// ---------------------------------------------------------------- review, corrections, confirm

async function reviewOrEdit(message: IncomingMessage, loaded: LoadedEval, step: "review" | "editing"): Promise<AgentResult> {
  const phone = message.phone;
  const evalId = loaded.row.id;
  if (imageOf(message)) {
    await dropStrayImage(message);
    return state(step, { evalId });
  }
  const e = loaded.draft.extraction;
  if (!e) return loaded.draft.source === "photo" ? readPages(phone, evalId) : processNotes(phone, evalId);

  // After "Corregir", a bare number is a correction ("3" = pain 3/10), never an option number.
  const bareNumber = /^\d+$/.test(message.body.trim()) && !message.buttonPayload;
  const choice = step === "editing" && bareNumber ? null : matchOption(message.buttonPayload ?? message.body, EVAL_REVIEW_OPTIONS);
  if (choice?.id === "confirm" || (!choice && isConfirmWord(message.body))) return confirm(phone, loaded);
  if (choice?.id === "discard") return discard(phone, loaded);
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
  const n = Number(correction.text.trim());
  const instruction =
    bareNumber && n >= 0 && n <= 10 && evaluationGaps(e).includes("pain")
      ? `La intensidad del dolor es ${n}/10.`
      : correction.text;
  try {
    const revised = await reviseEvaluation(e, instruction, loaded.patient.full_name);
    const merged = mergeRevision(e, revised.evaluation, revised.changed);
    if (!merged.applied) {
      await sendText(phone, "No entendí qué cambiar. Dímelo de otra forma, p. ej. «la flexión de rodilla izquierda fue 120».");
      await setEvalFields(evalId, { step: "review" });
      await sendReview(phone, loaded);
      return state("review", { evalId });
    }
    await setEvalFields(evalId, { extraction: merged.note, step: "review" });
    await sendReview(phone, { ...loaded, draft: { ...loaded.draft, extraction: merged.note, step: "review" } });
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
  for (const part of parts) await sendText(phone, part);
  // The options in their own short message: never hidden behind WhatsApp's "Leer más".
  await sendOptions(phone, EVAL_CONFIRM_QUESTION(loaded.patient.full_name), EVAL_REVIEW_OPTIONS);
}

async function confirm(phone: string, loaded: LoadedEval): Promise<AgentResult> {
  const evalId = loaded.row.id;
  const lateNotes = lateInputs(loaded.draft).filter((i): i is Extract<EvalInput, { kind: "note" }> => i.kind === "note");
  if (lateNotes.length && loaded.draft.extraction) return absorbLateNotes(phone, loaded, lateNotes);

  const used = loaded.draft.inputs.slice(0, loaded.draft.extracted_count ?? loaded.draft.inputs.length);
  const notes = used.filter((i): i is Extract<EvalInput, { kind: "note" }> => i.kind === "note").map((n) => n.text);
  const pageCount = used.filter((i) => i.kind === "page").length;
  const result = await confirmEvaluation(evalId, loaded.draft.extraction!, {
    source_transcript: notes.length ? notes.join("\n\n") : null,
    page_count: loaded.draft.source === "photo" ? pageCount : null,
    patient_name: loaded.patient.full_name,
  });
  if (result === "already_confirmed") await sendText(phone, "Esta valoración ya estaba guardada.");
  else if (result === "not_found") await sendText(phone, "Esa valoración ya no está abierta.");
  else {
    const lead = `✅ Valoración inicial guardada en el expediente de *${loaded.patient.full_name}*.`;
    return offerNextStep(phone, "after_eval", lead, loaded.patient);
  }
  return done();
}

/** Notes that arrived after the evaluation was prepared go in before saving; the therapist sees it again. */
async function absorbLateNotes(
  phone: string,
  loaded: LoadedEval,
  late: Extract<EvalInput, { kind: "note" }>[],
): Promise<AgentResult> {
  const evalId = loaded.row.id;
  let e = loaded.draft.extraction!;
  try {
    for (const note of late) {
      const revised = await reviseEvaluation(e, `Nota adicional del terapeuta, agrégala: ${note.text}`, loaded.patient.full_name);
      e = mergeRevision(e, revised.evaluation, revised.changed).note;
    }
  } catch (err) {
    console.error("[initial-eval] late note failed", evalId, err);
    await sendText(phone, "Llegó otra nota y no pude agregarla. Responde *Confirmar* otra vez para intentarlo.");
    return state("review", { evalId });
  }
  await setEvalFields(evalId, { extraction: e, step: "review", extracted_count: loaded.draft.inputs.length });
  await sendText(phone, "Agregué la nota que llegó después. Revísala antes de guardar:");
  await sendReview(phone, { ...loaded, draft: { ...loaded.draft, extraction: e, step: "review" } });
  return state("review", { evalId });
}

async function discard(phone: string, loaded: LoadedEval): Promise<AgentResult> {
  await Promise.all(pageInputs(loaded.draft).map((p) => deleteTwilioMedia(p.media_url)));
  await deleteEvalDraft(loaded.row.id);
  await sendText(phone, "Valoración descartada. No se guardó nada.");
  return done();
}

// ---------------------------------------------------------------- helpers

/** A photo sent where none is used: delete it from Twilio right away. Returns true if there was one. */
async function dropStrayImage(message: IncomingMessage): Promise<boolean> {
  const image = imageOf(message);
  if (!image) return false;
  await deleteTwilioMedia(image.url);
  await sendText(message.phone, "📷 En este paso no uso fotos; la borré.");
  return true;
}

async function gone(phone: string, evalId: string | null): Promise<AgentResult> {
  if (evalId && (await evalStatus(evalId)) === "confirmed") await sendText(phone, "Esta valoración ya estaba guardada.");
  else await sendText(phone, "Esa valoración ya no está abierta. Escribe *menu* para empezar.");
  return done();
}
