import "server-only";
import { transcribeVoiceNote } from "@/lib/ai/transcribe";
import type { AgentResult, IncomingMessage, PatientContext } from "@/lib/agents/types";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import { handleActivity, promptActivity, startActivity } from "./activity";
import { handleCheckin, startsCheckin } from "./checkin";
import { looksLikeActivity } from "./parse";
import { handleOptOut, handleRedFlag } from "./safety";
import { detectRedFlags, isOptOut } from "./signals";
import { handleWelcome, needsWelcome } from "./welcome";

// Patient agent. Owner: Person 3. Flows C (reminder check-in) and D (activity log), plus
// consent (P-1), opt-out "parar" (P-8) and red flags (P-6). See docs/prd.md.
// Rule X-4: never diagnose, change the plan or give clinical advice. Log, remind, escalate.
//
// Order on every message: voice -> red flags -> opt-out -> consent -> flow in progress ->
// new intent (check-in, activity) -> menu.

const MENU: Option[] = [
  { id: "menu_checkin", title: "Mis ejercicios de hoy" },
  { id: "menu_activity", title: "Una actividad" },
];

export async function handlePatientMessage(input: PatientContext): Promise<AgentResult> {
  // Voice notes become text first, so every check below works the same for them.
  const message = await withTranscript(input.message);
  if (message === null) {
    await sendText(input.message.phone, "No pude escuchar tu nota de voz. ¿Me lo puedes escribir?");
    return { nextState: input.state };
  }
  const ctx: PatientContext = { ...input, message };
  const { patient, state } = ctx;

  // Flows that save a log handle red flags themselves, so the log is saved before escalating.
  const flowHandlesFlags =
    (state?.flow === "checkin" && state.step === "awaiting_pain") || state?.flow === "activity";

  // P-6 before anything else: a red flag mid-flow still gets escalated.
  const flags = flowHandlesFlags ? [] : detectRedFlags(message.body);
  if (flags.length > 0 && patient.consent_at && looksLikeActivity(message.body)) {
    // "Me caí corriendo": save it as a flagged activity log; startActivity escalates at once.
    return startActivity(ctx, message.body);
  }
  if (flags.length > 0) {
    await handleRedFlag(patient, message.phone, message.body, flags);
    return { nextState: null };
  }

  if (isOptOut(message.body)) {
    await handleOptOut(patient, message.phone);
    return { nextState: null };
  }

  // P-1: nothing is logged until the patient accepts the privacy notice.
  if (needsWelcome(ctx)) return handleWelcome(ctx);

  if (state?.flow === "checkin") return handleCheckin(ctx);
  if (state?.flow === "activity") return handleActivity(ctx);
  if (state?.flow === "menu") {
    const choice = matchOption(message.buttonPayload ?? message.body, MENU);
    // Start fresh: the "1" that picked the menu item must not count as "1. Todos".
    const blank = { ...message, body: "", buttonPayload: null };
    if (choice?.id === "menu_checkin") return handleCheckin({ ...ctx, state: null, message: blank });
    if (choice?.id === "menu_activity") return promptActivity(message.phone);
  }

  // P-4 / P-5: the patient logs on their own, any time.
  if (looksLikeActivity(message.body)) return startActivity(ctx, message.body);
  if (startsCheckin(ctx)) return handleCheckin(ctx);

  // Nothing recognised: show what they can log.
  const firstName = patient.full_name.split(" ")[0];
  await sendOptions(message.phone, `Hola, ${firstName}. ¿Qué quieres registrar?`, MENU);
  return { nextState: { flow: "menu", step: "awaiting_choice", context: {} } };
}

/**
 * A voice note with no caption gets its transcript as the body. Returns null when the
 * audio could not be transcribed.
 */
async function withTranscript(message: IncomingMessage): Promise<IncomingMessage | null> {
  const audio = message.media.find((m) => m.contentType.startsWith("audio/"));
  if (!audio || message.body) return message;
  try {
    const transcript = await transcribeVoiceNote(audio.url);
    return transcript ? { ...message, body: transcript } : null;
  } catch (err) {
    console.error("[patient] transcription failed", message.sid, err);
    return null;
  }
}
