import "server-only";
import type { AgentResult, PatientContext } from "@/lib/agents/types";
import { sendText } from "@/lib/whatsapp/send";
import { handleOptOut, handleRedFlag } from "./safety";
import { detectRedFlags, isOptOut } from "./signals";

// Patient agent. Owner: Person 3. Flows C (reminder check-in) and D (activity log), plus
// consent (P-1), opt-out "parar" (P-8) and red flags (P-6). See docs/prd.md.
// Rule X-4: never diagnose, change the plan or give clinical advice. Log, remind, escalate.
//
// Safety checks run first on every message, whatever flow the patient is in.

export async function handlePatientMessage(ctx: PatientContext): Promise<AgentResult> {
  const { patient, message } = ctx;

  // P-6 before anything else: a red flag mid-flow still gets escalated.
  // TODO(Person 3): voice notes have no text yet; check their transcript once P-5 transcribes.
  const flags = detectRedFlags(message.body);
  if (flags.length > 0) {
    await handleRedFlag(patient, message.phone, message.body, flags);
    return { nextState: null };
  }

  if (isOptOut(message.body)) {
    await handleOptOut(patient, message.phone);
    return { nextState: null };
  }

  const firstName = patient.full_name.split(" ")[0];
  // TODO(Person 3): consent, check-ins, activity logs.
  await sendText(
    message.phone,
    `Hola, ${firstName}. Recibí tu mensaje. Pronto podrás registrar aquí tus ejercicios y actividades.`,
  );
  return { nextState: null };
}
