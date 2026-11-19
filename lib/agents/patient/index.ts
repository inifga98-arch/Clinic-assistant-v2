import "server-only";
import type { AgentResult, PatientContext } from "@/lib/agents/types";
import { sendText } from "@/lib/whatsapp/send";

// Patient agent. Owner: Person 3. Flows C (reminder check-in) and D (activity log), plus
// consent (P-1), opt-out "parar" (P-8) and red flags (P-6). See docs/prd.md.
// Rule X-4: never diagnose, change the plan or give clinical advice. Log, remind, escalate.
//
// Skeleton only: acknowledges the message so the router can be tested end to end.

export async function handlePatientMessage(ctx: PatientContext): Promise<AgentResult> {
  const firstName = ctx.patient.full_name.split(" ")[0];
  // TODO(Person 3): consent, check-ins, activity logs, red flags, opt-out.
  await sendText(
    ctx.message.phone,
    `Hola, ${firstName}. Recibí tu mensaje. Pronto podrás registrar aquí tus ejercicios y actividades.`,
  );
  return { nextState: null };
}
