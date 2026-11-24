import "server-only";
import type { AgentResult, TherapistContext } from "@/lib/agents/types";
import { matchOption, normalizeText, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import { handleInitialEval, startInitialEval } from "./initial-eval";
import { handleNewPatient, startNewPatient } from "./new-patient";
import { handleSessionNote, startSessionNote } from "./session-note";

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

  if (state?.flow === "session_note") return handleSessionNote(ctx);
  if (state?.flow === "new_patient") return handleNewPatient(ctx);
  if (state?.flow === "initial_eval") return handleInitialEval(ctx);

  if (state) {
    await sendText(message.phone, "Ese paso todavía está en construcción. Escribe *menu* para empezar de nuevo.");
    return { nextState: null };
  }

  await sendOptions(message.phone, `Hola, ${firstName}. ¿Qué quieres hacer?`, MENU);
  return { nextState: { flow: "menu", step: "awaiting_choice", context: {} } };
}
