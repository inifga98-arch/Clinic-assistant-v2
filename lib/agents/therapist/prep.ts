import "server-only";
import type { AgentResult, ConversationState, TherapistContext } from "@/lib/agents/types";
import { numberedFacts, writePrepBrief } from "@/lib/ai/prep-brief";
import { transcribeVoiceNote } from "@/lib/ai/transcribe";
import { deleteTwilioMedia } from "@/lib/whatsapp/media";
import { matchOption, sendOptions, sendText } from "@/lib/whatsapp/send";
import { offerNextStep } from "./next-step";
import { looksLikeName, matchPatients, namesInText, patientLabel, type PatientRef } from "./patient-match";
import { clinicPatients, recentPatients } from "./patient-picker";
import { getPatient } from "./patient-store";
import { factList, formatPrepBrief, type PrepAi } from "./prep-format";
import { groundedLine, groundedSuggestions } from "./prep-logic";
import { loadPrepData } from "./prep-store";

// Flow E: prepare a session (T-10). Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-24-flow-e-design.md. Pick the patient, send one brief
// built from confirmed notes and the patient's logs, then offer the next step. Writes nothing.

const FLOW = "prep";
const MAX_SHOWN = 8;

interface PrepState {
  candidates?: PatientRef[];
}

const state = (step: "pick_patient" | "disambiguate", context: PrepState): AgentResult => ({
  nextState: { flow: FLOW, step, context: context as Record<string, unknown> },
});

/** "Preparar sesión" from the menu (or "Preparar otra" after a brief). */
export async function startPrep(ctx: TherapistContext): Promise<AgentResult> {
  const patients = await recentPatients(ctx.therapist.id, MAX_SHOWN);
  if (!patients.length) {
    await sendText(ctx.message.phone, "📋 ¿Qué sesión preparamos? Escribe o di el nombre del paciente.");
  } else {
    await sendOptions(
      ctx.message.phone,
      "📋 ¿Qué sesión preparamos? Elige un número o escribe o di el nombre.",
      patients.map((p) => ({ id: p.id, title: patientLabel(p, patients) })),
    );
  }
  return state("pick_patient", { candidates: patients });
}

/** Every message while state.flow is "prep". */
export async function handlePrep(ctx: TherapistContext): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const current = ctx.state as ConversationState;
  const candidates = ((current.context as PrepState).candidates ?? []) as PatientRef[];

  // No flow here uses photos: delete them from Twilio and say so.
  const images = message.media.filter((m) => m.contentType.startsWith("image/"));
  for (const image of images) await deleteTwilioMedia(image.url).catch(() => undefined);
  if (images.length) {
    const onlyPhotos = !message.body.trim() && !message.media.some((m) => m.contentType.startsWith("audio/"));
    await sendText(
      phone,
      onlyPhotos
        ? "No uso fotos para preparar la sesión; la borré. Escribe o di el nombre del paciente."
        : "No uso fotos para preparar la sesión; la borré.",
    );
    if (onlyPhotos) return state(current.step as "pick_patient", { candidates });
  }

  const byNumber = matchOption(
    message.buttonPayload ?? message.body,
    candidates.map((p) => ({ id: p.id, title: patientLabel(p, candidates) })),
  );
  if (byNumber) return sendPrep(phone, byNumber.id);

  const audio = message.media.find((m) => m.contentType.startsWith("audio/"));
  let query = message.body.trim();
  if (audio) {
    try {
      query = (await transcribeVoiceNote(audio.url, { timeoutMs: 20_000 })).trim();
    } catch (err) {
      console.error("[prep] transcription failed", message.sid, err);
      await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes el nombre del paciente?");
      return state(current.step as "pick_patient", { candidates });
    }
  } else if (!looksLikeName(query)) {
    await sendText(phone, "Escribe el nombre del paciente o elige un número.");
    return state(current.step as "pick_patient", { candidates });
  }

  const spoken = query.replace(/[.,!?¿¡]/g, " ");
  const search = (pool: PatientRef[]) => {
    const found = matchPatients(spoken, pool);
    return found.length || !audio ? found : namesInText(spoken, pool); // "prepara la sesión de Laura"
  };
  // While asking "which one?", look among those first; another name searches the whole clinic.
  let hits = current.step === "disambiguate" ? search(candidates) : [];
  if (!hits.length) hits = search(await clinicPatients(therapist.clinic_id));
  if (hits.length === 1) return sendPrep(phone, hits[0].id);
  if (!hits.length) {
    await sendText(phone, `No encontré a «${query.slice(0, 60)}». Escribe el nombre completo.`);
    return state(current.step as "pick_patient", { candidates });
  }
  if (hits.length > MAX_SHOWN) {
    await sendText(phone, `Hay muchos pacientes con «${query.slice(0, 60)}». Escribe nombre y apellido.`);
    return state("pick_patient", { candidates });
  }
  await sendOptions(phone, "¿Cuál de ellos?", hits.map((p) => ({ id: p.id, title: patientLabel(p, hits) })));
  return state("disambiguate", { candidates: hits });
}

/** Build and send the brief, then the next step. The AI part is optional: on failure the facts still go. */
async function sendPrep(phone: string, patientId: string): Promise<AgentResult> {
  const patient = await getPatient(patientId);
  if (!patient) {
    await sendText(phone, "No encontré a ese paciente. Escribe *menu* para empezar de nuevo.");
    return { nextState: null };
  }
  const data = await loadPrepData(patient);
  const facts = factList(data);
  const factsText = numberedFacts(facts);
  let ai: PrepAi = { lastSession: null, suggestions: [] };
  try {
    const raw = await writePrepBrief(facts);
    ai = {
      lastSession: data.lastSession ? groundedLine(raw.last_session, factsText) : null,
      suggestions: groundedSuggestions(raw.suggestions, facts.length, factsText).slice(0, 3),
    };
    const dropped = raw.suggestions.length - ai.suggestions.length;
    if (dropped > 0 || (raw.last_session && data.lastSession && !ai.lastSession)) {
      console.warn("[prep] dropped ungrounded AI lines", patient.id, { dropped, lastSession: raw.last_session });
    }
  } catch (err) {
    console.error("[prep] brief AI failed; sending the facts only", patient.id, err);
  }
  return offerNextStep(phone, "after_prep", formatPrepBrief(data, ai), patient);
}
