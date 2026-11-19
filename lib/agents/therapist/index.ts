import "server-only";
import type { AgentResult, TherapistContext } from "@/lib/agents/types";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";

// Therapist agent. Owner: Person 1. Flows A (new patient), B (session note + plan),
// E (prep a session), F (handoff). See docs/prd.md "Happy flows" and "Therapist agent".
//
// Skeleton only: shows the menu (T-1) and acknowledges the choice. Each flow replaces its
// placeholder below with a real state machine (one file per flow in this folder).

export const MENU: Option[] = [
  { id: "new_patient", title: "Nuevo paciente" },
  { id: "session_note", title: "Nota de sesión" },
  { id: "prep", title: "Preparar sesión" },
  { id: "handoff", title: "Traspaso de paciente" },
];

export async function handleTherapistMessage(ctx: TherapistContext): Promise<AgentResult> {
  const { therapist, message, state } = ctx;

  if (state?.flow === "menu" && state.step === "awaiting_choice") {
    const choice = matchOption(message.buttonPayload ?? message.body, MENU);
    if (!choice) {
      await sendOptions(message.phone, "No entendí. ¿Qué quieres hacer?", MENU);
      return { nextState: state };
    }
    // TODO(Person 1): start the chosen flow instead of this placeholder.
    await sendText(message.phone, `«${choice.title}» todavía está en construcción.`);
    return { nextState: null };
  }

  if (state) {
    // TODO(Person 1): dispatch to the flow in state.flow.
    await sendText(message.phone, "Ese paso todavía está en construcción. Escribe *menu* para empezar de nuevo.");
    return { nextState: null };
  }

  const firstName = therapist.full_name.split(" ")[0];
  await sendOptions(message.phone, `Hola, ${firstName}. ¿Qué quieres hacer?`, MENU);
  return { nextState: { flow: "menu", step: "awaiting_choice", context: {} } };
}
