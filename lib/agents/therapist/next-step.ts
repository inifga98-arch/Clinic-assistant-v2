import "server-only";
import type { AgentResult } from "@/lib/agents/types";
import { sendOptions } from "@/lib/whatsapp/send";
import { NEXT_OPTIONS, nextStepText, type NextStepKind } from "./next-step-format";

// After a save, offer the likely next step instead of ending the conversation. The answer is
// handled in index.ts (it needs the menu and the flows' entry points).

export const NEXT_FLOW = "next_step";

export async function offerNextStep(
  phone: string,
  kind: NextStepKind,
  lead: string,
  patient: { id: string; full_name: string } | null,
): Promise<AgentResult> {
  await sendOptions(phone, nextStepText(kind, lead, patient?.full_name ?? null), NEXT_OPTIONS[kind]);
  return { nextState: { flow: NEXT_FLOW, step: kind, context: patient ? { patientId: patient.id } : {} } };
}
