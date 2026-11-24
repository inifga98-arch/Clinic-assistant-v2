import "server-only";
import type { AgentResult, TherapistContext } from "@/lib/agents/types";
import { matchOption, normalizeText, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import { handleInitialEval, startInitialEval } from "./initial-eval";
import { handleNewPatient, startNewPatient } from "./new-patient";
import { NEXT_FLOW } from "./next-step";
import { DONE_TEXT, NEXT_OPTIONS, type NextStepKind } from "./next-step-format";
import { getPatient } from "./patient-store";
import { handleSessionNote, startSessionNote, startSessionNoteFor } from "./session-note";

// Therapist agent. Owner: Person 1. Flows A (new patient), B (session note + plan),
// E (prep a session), F (handoff). See docs/prd.md "Happy flows" and "Therapist agent".
//
// Shows the menu (T-1) and hands each choice to its flow (one file per flow in this folder).
// Built: Flow A (new-patient.ts, initial-eval.ts), Flow B (session-note.ts). Still placeholders: E, F.

export const MENU: Option[] = [
  { id: "new_patient", title: "Nuevo paciente", icon: "🆕" },
  { id: "session_note", title: "Nota de sesión", icon: "📝" },
  { id: "prep", title: "Preparar sesión", icon: "📋" },
  { id: "handoff", title: "Traspaso de paciente", icon: "🔄" },
  { id: "initial_eval", title: "Valoración inicial", icon: "🩺" },
];

/** A greeting while the menu is open repeats the menu instead of "No entendí". */
const GREETINGS = new Set(
  ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hi", "hello", "hey"].map(normalizeText),
);

export async function handleTherapistMessage(ctx: TherapistContext): Promise<AgentResult> {
  const { therapist, message, state } = ctx;

  const firstName = therapist.full_name.split(" ")[0];

  if (state?.flow === "menu" && state.step === "awaiting_choice") {
    const choice = matchOption(message.buttonPayload ?? message.body, MENU);
    if (!choice) {
      const greeting = GREETINGS.has(normalizeText(message.body));
      const intro = greeting ? `Hola, ${firstName}. ¿Qué quieres hacer?` : "No entendí. ¿Qué quieres hacer?";
      await sendOptions(message.phone, intro, MENU);
      return { nextState: state };
    }
    if (choice.id === "session_note") return startSessionNote(ctx);
    if (choice.id === "new_patient") return startNewPatient(ctx);
    if (choice.id === "initial_eval") return startInitialEval(ctx);
    // TODO(Person 1): flows E and F.
    await sendText(message.phone, `«${choice.title}» todavía está en construcción.`);
    return { nextState: null };
  }

  if (state?.flow === NEXT_FLOW) {
    // The follow-up offered after a save. Anything that isn't one of its options is handled as
    // if no flow were open (a greeting shows the menu).
    const kind = state.step as NextStepKind;
    const pick = matchOption(message.buttonPayload ?? message.body, NEXT_OPTIONS[kind] ?? []);
    if (pick?.id === "done") {
      await sendText(message.phone, DONE_TEXT);
      return { nextState: null };
    }
    if (pick?.id === "menu") return showMenu(ctx, `¿Qué quieres hacer, ${firstName}?`);
    if (pick?.id === "note_same") {
      const patient = await getPatient(String(state.context.patientId ?? ""));
      if (patient) return startSessionNoteFor(ctx, patient);
    }
    if (pick) return startSessionNote(ctx);
    return handleTherapistMessage({ ...ctx, state: null });
  }

  if (state?.flow === "session_note") return handleSessionNote(ctx);
  if (state?.flow === "new_patient") return handleNewPatient(ctx);
  if (state?.flow === "initial_eval") return handleInitialEval(ctx);

  if (state) {
    await sendText(message.phone, "Ese paso todavía está en construcción. Escribe *menu* para empezar de nuevo.");
    return { nextState: null };
  }

  return showMenu(ctx, `Hola, ${firstName}. ¿Qué quieres hacer?`);
}

async function showMenu(ctx: TherapistContext, intro: string): Promise<AgentResult> {
  await sendOptions(ctx.message.phone, intro, MENU);
  return { nextState: { flow: "menu", step: "awaiting_choice", context: {} } };
}
