import "server-only";
import { formatTime, parseYesNo } from "@/lib/agents/patient/parse";
import { normalize } from "@/lib/agents/patient/signals";
import { clinicTimeToUtc, clinicToday } from "@/lib/agents/patient/time";
import type { AgentResult, ConversationState, IncomingMessage, TherapistContext } from "@/lib/agents/types";
import { extractSoap, reviseSoap, type NoteContext } from "@/lib/ai/soap-extract";
import type { SoapExtraction } from "@/lib/ai/soap-schema";
import { transcribeVoiceNote } from "@/lib/ai/transcribe";
import type { Patient, Therapist } from "@/lib/db/types";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import {
  QUESTIONS, cleanExtraction, isDoneWord, isSkipWord, mergeRevision, missingItems, nextQuestion, parsePainAnswer,
  toNoteColumns, toPlanItems, type MissingItem, type NoteDraft, type SessionNoteStep, type TranscriptEntry,
} from "./note-draft";
import { RECORDING_OPTIONS, REVIEW_OPTIONS, formatAck, formatReview } from "./note-format";
import {
  activePlanLines, appendTranscript, confirmNote, createDraft, deleteDraft, latestDraft, loadDraft, setDraftFields,
  type LoadedDraft,
} from "./note-store";
import { matchPatients, namesInText, patientLabel, type PatientRef } from "./patient-match";
import { clinicPatients, recentPatients } from "./patient-picker";

// Flow B: session note + home plan (T-3 to T-8). Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-23-flow-b-design.md. Code decides every step; the
// model only transcribes, extracts the note and applies one change at a time.

const FLOW = "session_note";
type Step = SessionNoteStep | "resume_offer";

interface NoteContextState {
  sessionId?: string;
  candidates?: PatientRef[];
  pending?: TranscriptEntry;
  resumeId?: string;
}

const RESUME_OPTIONS: Option[] = [
  { id: "resume", title: "Continuar" },
  { id: "discard_old", title: "Descartarla" },
  { id: "other", title: "Nota de otro paciente" },
];
const YES_NO: Option[] = [
  { id: "yes", title: "Sí" },
  { id: "no", title: "No" },
];
const GREETINGS = new Set(["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hi", "hello"].map(normalize));
/** Longer than this at the picker, a text is a note rather than a name. */
const NAME_MAX_CHARS = 40;
const MAX_SHOWN = 8;

const state = (step: Step, context: NoteContextState = {}): AgentResult => ({
  nextState: { flow: FLOW, step, context: context as Record<string, unknown> },
});
const done = (): AgentResult => ({ nextState: null });

// ---------------------------------------------------------------- entry points

/** "Nota de sesión" from the menu: offer an open draft first, otherwise the patient picker. */
export async function startSessionNote(ctx: TherapistContext): Promise<AgentResult> {
  const open = await latestDraft(ctx.therapist.id);
  if (open) {
    await sendOptions(
      ctx.message.phone,
      `Tienes una nota sin confirmar de *${open.patientName}* (${ago(open.createdAt)}).`,
      RESUME_OPTIONS,
    );
    return state("resume_offer", { resumeId: open.sessionId });
  }
  return showPicker(ctx.message.phone, ctx.therapist);
}

/** Every message while state.flow is "session_note". */
export async function handleSessionNote(ctx: TherapistContext): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const current = ctx.state as ConversationState;
  const step = current.step as Step;
  const c = current.context as NoteContextState;
  const phone = message.phone;
  const choice = (options: Option[]) => matchOption(message.buttonPayload ?? message.body, options);

  switch (step) {
    case "resume_offer": {
      const pick = choice(RESUME_OPTIONS);
      if (pick?.id === "resume" && c.resumeId) return resume(phone, c.resumeId);
      if (pick?.id === "discard_old" && c.resumeId) {
        await deleteDraft(c.resumeId);
        await sendText(phone, "Nota descartada.");
        return showPicker(phone, therapist);
      }
      if (pick?.id === "other") return showPicker(phone, therapist);
      await sendOptions(phone, "¿Qué hago con la nota sin confirmar?", RESUME_OPTIONS);
      return state(step, c);
    }

    case "pick_patient":
      return pickPatient(ctx, c);

    case "disambiguate": {
      const candidates = c.candidates ?? [];
      const byNumber = choice(candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })));
      const picked = byNumber
        ? candidates.find((p) => p.id === byNumber.id)
        : oneOrNull(matchPatients(message.body, candidates));
      if (picked) return beginDraft(phone, therapist, picked, c.pending);
      await askWhich(phone, candidates);
      return state(step, c);
    }

    case "confirm_patient": {
      const yn = choice(YES_NO)?.id ?? parseYesNo(message.body);
      const patient = c.candidates?.[0];
      if ((yn === "yes") && patient) return beginDraft(phone, therapist, patient, c.pending);
      if (yn === "no") return showPicker(phone, therapist, c.pending);
      await sendOptions(phone, `¿La nota es de *${patient?.full_name ?? "ese paciente"}*?`, YES_NO);
      return state(step, c);
    }

    case "recording":
    case "asking":
    case "review":
    case "editing": {
      if (!c.sessionId) return lost(phone);
      const loaded = await loadDraft(c.sessionId);
      if (!loaded) return lost(phone);
      if (step === "recording") return recording(message, loaded);
      if (step === "asking") return asking(message, loaded);
      return reviewOrEdit(message, loaded, step);
    }

    default:
      return lost(phone);
  }
}

// ---------------------------------------------------------------- choosing the patient

async function showPicker(phone: string, therapist: Therapist, pending?: TranscriptEntry): Promise<AgentResult> {
  const patients = await recentPatients(therapist.id, MAX_SHOWN);
  const intro = pending ? "Guardé tu nota. ¿De qué paciente es?" : "¿De qué paciente es la nota?";
  if (patients.length === 0) {
    await sendText(phone, `${intro} Escribe o di el nombre del paciente.`);
  } else {
    await sendOptions(
      phone,
      `${intro} Elige un número o escribe o di el nombre.`,
      patients.map((p) => ({ id: p.id, title: patientLabel(p, patients) })),
    );
  }
  return state("pick_patient", { candidates: patients, pending });
}

async function pickPatient(ctx: TherapistContext, c: NoteContextState): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const candidates = c.candidates ?? [];
  const hasAudio = message.media.some((m) => m.contentType.startsWith("audio/"));

  const byNumber = matchOption(
    message.buttonPayload ?? message.body,
    candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })),
  );
  if (byNumber && !hasAudio) {
    const picked = candidates.find((p) => p.id === byNumber.id)!;
    return beginDraft(phone, therapist, picked, c.pending);
  }

  if (!hasAudio && message.body.trim().length <= NAME_MAX_CHARS) {
    const query = message.body.trim();
    const hits = matchPatients(query, await clinicPatients(therapist.clinic_id));
    if (hits.length === 1) return beginDraft(phone, therapist, hits[0], c.pending);
    if (hits.length === 0) {
      await sendText(phone, `No encontré a «${query}». Escribe el nombre completo.`);
      return state("pick_patient", c);
    }
    if (hits.length > MAX_SHOWN) {
      await sendText(phone, `Hay muchos pacientes con «${query}». Escribe nombre y apellido.`);
      return state("pick_patient", c);
    }
    await askWhich(phone, hits);
    return state("disambiguate", { candidates: hits, pending: c.pending });
  }

  // A note sent straight away: keep it, and look for the patient's name in it.
  const note = await noteFrom(message);
  if (!note) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿La mandas otra vez o la escribes?");
    return state("pick_patient", c);
  }
  const named = namesInText(note.text, await clinicPatients(therapist.clinic_id));
  if (named.length === 1) {
    await sendOptions(phone, `¿La nota es de *${named[0].full_name}*?`, YES_NO);
    return state("confirm_patient", { candidates: named, pending: note });
  }
  return showPicker(phone, therapist, note);
}

async function askWhich(phone: string, candidates: PatientRef[]) {
  await sendOptions(phone, "¿Cuál de ellos?", candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })));
}

async function beginDraft(
  phone: string,
  therapist: Therapist,
  patient: PatientRef,
  pending?: TranscriptEntry,
): Promise<AgentResult> {
  const sessionId = await createDraft(therapist.id, patient.id);
  if (pending) {
    const count = await appendTranscript(sessionId, pending);
    await sendOptions(phone, formatAck(patient.full_name, count), RECORDING_OPTIONS);
  } else {
    await sendText(
      phone,
      `Adelante con *${patient.full_name}*. Cuéntame cómo está, qué mediste e hiciste, tu valoración y el plan. ` +
        "Puedes mandar varias notas.",
    );
  }
  return state("recording", { sessionId });
}

// ---------------------------------------------------------------- recording and processing

async function recording(message: IncomingMessage, loaded: LoadedDraft): Promise<AgentResult> {
  const phone = message.phone;
  const sessionId = loaded.session.id;
  const pick = matchOption(message.buttonPayload ?? message.body, RECORDING_OPTIONS);
  if (pick?.id === "more") {
    await sendText(phone, "Adelante.");
    return state("recording", { sessionId });
  }
  if (pick?.id === "done") return processNotes(phone, loaded);

  const note = await noteFrom(message);
  if (!note) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿La mandas otra vez o la escribes?");
    return state("recording", { sessionId });
  }
  if (isDoneWord(note.text)) return processNotes(phone, loaded);
  if (!note.text.trim()) return state("recording", { sessionId });

  const count = await appendTranscript(sessionId, note);
  await sendOptions(phone, formatAck(loaded.patient.full_name, count), RECORDING_OPTIONS);
  return state("recording", { sessionId });
}

async function processNotes(phone: string, loaded: LoadedDraft): Promise<AgentResult> {
  const sessionId = loaded.session.id;
  const fresh = (await loadDraft(sessionId)) ?? loaded; // notes may have landed since this message started
  if (fresh.draft.transcripts.length === 0) {
    await sendText(phone, "Aún no tengo ninguna nota. Mándala por voz o texto.");
    return state("recording", { sessionId });
  }
  await sendText(phone, "Un momento, preparo la nota…");
  let extraction: SoapExtraction;
  try {
    extraction = cleanExtraction(
      await extractSoap(
        fresh.draft.transcripts.map((t) => t.text),
        await noteContext(fresh.patient),
      ),
    );
  } catch (err) {
    console.error("[session-note] extraction failed", sessionId, err);
    await sendOptions(phone, "No pude procesar la nota. Responde *Listo* para intentarlo otra vez.", RECORDING_OPTIONS);
    return state("recording", { sessionId });
  }
  return askOrReview(phone, fresh, { ...fresh.draft, extraction, questions_asked: 0, skipped: [], asking: null });
}

/** Ask the next missing item, or show the note when nothing is left to ask. */
async function askOrReview(phone: string, loaded: LoadedDraft, draft: NoteDraft): Promise<AgentResult> {
  const sessionId = loaded.session.id;
  const item = nextQuestion(draft);
  if (item) {
    const next = { ...draft, asking: item, questions_asked: draft.questions_asked + 1, step: "asking" as const };
    await setDraftFields(sessionId, withoutTranscripts(next));
    await sendText(phone, `${QUESTIONS[item]}\n(o escribe *omitir*)`);
    return state("asking", { sessionId });
  }
  const next = { ...draft, asking: null, step: "review" as const };
  await setDraftFields(sessionId, withoutTranscripts(next));
  await sendReview(phone, { ...loaded, draft: next });
  return state("review", { sessionId });
}

// ---------------------------------------------------------------- follow-up questions (T-5)

async function asking(message: IncomingMessage, loaded: LoadedDraft): Promise<AgentResult> {
  const phone = message.phone;
  const { draft } = loaded;
  const item = draft.asking;
  if (!draft.extraction || !item) return askOrReview(phone, loaded, draft);

  const answer = await noteFrom(message);
  if (!answer) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me lo escribes?");
    return state("asking", { sessionId: loaded.session.id });
  }

  if (isSkipWord(answer.text)) {
    return askOrReview(phone, loaded, { ...draft, skipped: [...draft.skipped, item], asking: null });
  }

  const pain = item === "pain_nprs" ? parsePainAnswer(answer.text) : null;
  if (pain !== null) {
    const extraction = { ...draft.extraction, subjective: { ...draft.extraction.subjective, pain_nprs: pain } };
    return askOrReview(phone, loaded, { ...draft, extraction, asking: null });
  }

  try {
    const revised = await reviseSoap(
      draft.extraction,
      `Pregunta: ${QUESTIONS[item]} Respuesta: ${answer.text}`,
      await noteContext(loaded.patient),
    );
    const merged = mergeRevision(draft.extraction, revised.note, revised.changed);
    const extraction = cleanExtraction(merged.note);
    // An answer that did not fill the gap counts as skipped, so the flow cannot loop.
    const stillMissing = missingItems(extraction).includes(item);
    return askOrReview(phone, loaded, {
      ...draft,
      extraction,
      asking: null,
      skipped: stillMissing ? [...draft.skipped, item] : draft.skipped,
    });
  } catch (err) {
    console.error("[session-note] answer failed", loaded.session.id, err);
    await sendText(phone, "No pude procesar eso. ¿Me lo dices otra vez?");
    return state("asking", { sessionId: loaded.session.id });
  }
}

// ---------------------------------------------------------------- review, edit, confirm (T-7, T-8)

async function reviewOrEdit(message: IncomingMessage, loaded: LoadedDraft, step: "review" | "editing"): Promise<AgentResult> {
  const phone = message.phone;
  const sessionId = loaded.session.id;
  if (!loaded.draft.extraction) return processNotes(phone, loaded);

  if (step === "review") {
    const pick = matchOption(message.buttonPayload ?? message.body, REVIEW_OPTIONS);
    const yes = !pick && parseYesNo(message.body) === "yes";
    if (pick?.id === "confirm" || yes) return confirm(phone, loaded);
    if (pick?.id === "edit") {
      await setDraftFields(sessionId, { step: "editing" });
      await sendText(phone, "¿Qué cambio? Escríbelo o dilo, p. ej. «la flexión fue 120».");
      return state("editing", { sessionId });
    }
    if (pick?.id === "discard") {
      await deleteDraft(sessionId);
      await sendText(phone, "Nota descartada. No se guardó nada.");
      return done();
    }
    if (GREETINGS.has(normalize(message.body)) && !message.media.length) {
      await sendReview(phone, loaded);
      return state("review", { sessionId });
    }
  }

  // A correction, typed or spoken, from the review or after "Editar".
  const correction = await noteFrom(message);
  if (!correction || !correction.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes el cambio?");
    return state(step, { sessionId });
  }
  try {
    const revised = await reviseSoap(loaded.draft.extraction, correction.text, await noteContext(loaded.patient));
    const merged = mergeRevision(loaded.draft.extraction, revised.note, revised.changed);
    if (!merged.applied) {
      await sendText(phone, "No entendí qué cambiar. Dímelo de otra forma, p. ej. «la flexión fue 120».");
      return state(step, { sessionId });
    }
    const next = { ...loaded.draft, extraction: cleanExtraction(merged.note), step: "review" as const };
    await setDraftFields(sessionId, withoutTranscripts(next));
    await sendReview(phone, { ...loaded, draft: next });
    return state("review", { sessionId });
  } catch (err) {
    console.error("[session-note] correction failed", sessionId, err);
    await sendText(phone, "No pude aplicar el cambio. ¿Me lo dices otra vez?");
    return state(step, { sessionId });
  }
}

async function sendReview(phone: string, loaded: LoadedDraft): Promise<void> {
  const note = loaded.draft.extraction!;
  const parts = formatReview({
    patientName: loaded.patient.full_name,
    date: clinicToday().date,
    note,
    missing: missingItems(note),
    hasActivePlan: (await activePlanLines(loaded.patient.id)).length > 0,
  });
  for (const part of parts.slice(0, -1)) await sendText(phone, part);
  await sendOptions(phone, parts[parts.length - 1], REVIEW_OPTIONS);
}

async function confirm(phone: string, loaded: LoadedDraft): Promise<AgentResult> {
  const note = loaded.draft.extraction!;
  const items = toPlanItems(note);
  const result = await confirmNote(
    loaded.session.id,
    toNoteColumns(note, missingItems(note), loaded.draft.transcripts),
    items,
    !note.plan.keep_current_plan && items.length > 0,
  );
  if (result === "already_confirmed") await sendText(phone, "Esta nota ya estaba guardada.");
  else if (result === "not_found") await sendText(phone, "Esa nota ya no está abierta.");
  else await sendText(phone, `Guardado en el expediente de *${loaded.patient.full_name}*.${nextReminder(loaded.patient)}`);
  return done();
}

/** " Su próximo recordatorio es mañana a las 7:00 pm." when the patient gets reminders. */
function nextReminder(patient: Patient, now = new Date()): string {
  if (!patient.reminders_opt_in || !patient.consent_at || !patient.reminder_time) return "";
  const today = clinicTimeToUtc(clinicToday(now).date, patient.reminder_time) > now;
  return ` Su próximo recordatorio es ${today ? "hoy" : "mañana"} a las ${formatTime(patient.reminder_time)}.`;
}

// ---------------------------------------------------------------- helpers

/** Continue an open draft where it was left. */
async function resume(phone: string, sessionId: string): Promise<AgentResult> {
  const loaded = await loadDraft(sessionId);
  if (!loaded) return lost(phone);
  const { draft } = loaded;
  if (draft.step === "review" && draft.extraction) {
    await sendReview(phone, loaded);
    return state("review", { sessionId });
  }
  if (draft.step === "editing" && draft.extraction) {
    await sendText(phone, "¿Qué cambio? Escríbelo o dilo, p. ej. «la flexión fue 120».");
    return state("editing", { sessionId });
  }
  if (draft.step === "asking" && draft.extraction && draft.asking) {
    await sendText(phone, `${QUESTIONS[draft.asking as MissingItem]}\n(o escribe *omitir*)`);
    return state("asking", { sessionId });
  }
  await sendOptions(
    phone,
    `Sigue la nota de *${loaded.patient.full_name}* (${draft.transcripts.length} nota(s)). Manda otra o responde Listo.`,
    RECORDING_OPTIONS,
  );
  return state("recording", { sessionId });
}

async function lost(phone: string): Promise<AgentResult> {
  await sendText(phone, "Esa nota ya no está abierta. Escribe *menu* para empezar.");
  return done();
}

/** The message as a note: the transcript of a voice note, or the typed text. Null if audio failed. */
async function noteFrom(message: IncomingMessage): Promise<TranscriptEntry | null> {
  const audio = message.media.find((m) => m.contentType.startsWith("audio/"));
  const entry = (text: string, audio_url: string | null): TranscriptEntry => ({
    text,
    audio_url,
    received_at: message.receivedAt.toISOString(),
  });
  if (!audio) return entry(message.body.trim(), null);
  try {
    const text = await transcribeVoiceNote(audio.url);
    const full = [message.body.trim(), text].filter(Boolean).join("\n");
    return full ? entry(full, audio.url) : null;
  } catch (err) {
    console.error("[session-note] transcription failed", message.sid, err);
    return null;
  }
}

async function noteContext(patient: Patient): Promise<NoteContext> {
  return { patientName: patient.full_name, diagnosis: patient.diagnosis, activePlan: await activePlanLines(patient.id) };
}

function withoutTranscripts(d: NoteDraft): Omit<NoteDraft, "transcripts"> {
  const { transcripts: _transcripts, ...rest } = d;
  void _transcripts;
  return rest;
}

const oneOrNull = <T,>(xs: T[]): T | null => (xs.length === 1 ? xs[0] : null);

function ago(iso: string, now = new Date()): string {
  const min = Math.max(1, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
}
