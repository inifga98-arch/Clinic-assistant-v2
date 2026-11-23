import "server-only";
import type { AgentResult, PatientContext } from "@/lib/agents/types";
import { matchOption, sendOptions, type Option } from "@/lib/whatsapp/send";
import { handleCheckin, startsCheckin } from "./checkin";
import { handleOptOut, handleRedFlag } from "./safety";
import { detectRedFlags, isOptOut } from "./signals";
import { handleWelcome, needsWelcome } from "./welcome";

// Patient agent. Owner: Person 3. Flows C (reminder check-in) and D (activity log), plus
// consent (P-1), opt-out "parar" (P-8) and red flags (P-6). See docs/prd.md.
// Rule X-4: never diagnose, change the plan or give clinical advice. Log, remind, escalate.
//
// Order on every message: red flags -> opt-out -> consent -> flow in progress -> new intent.

const MENU: Option[] = [{ id: "menu_checkin", title: "Mis ejercicios de hoy" }];

export async function handlePatientMessage(ctx: PatientContext): Promise<AgentResult> {
  const { patient, message, state } = ctx;

  // A check-in waiting for the pain score handles red flags itself, so the day's
  // exercise log is saved before escalating.
  const checkinPain = state?.flow === "checkin" && state.step === "awaiting_pain";

  // P-6 before anything else: a red flag mid-flow still gets escalated.
  // TODO(Person 3): voice notes have no text yet; check their transcript once P-5 transcribes.
  const flags = checkinPain ? [] : detectRedFlags(message.body);
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
  if (state?.flow === "menu") {
    const choice = matchOption(message.buttonPayload ?? message.body, MENU);
    // Start fresh: the "1" that picked the menu item must not count as "1. Todos".
    const blank = { ...message, body: "", buttonPayload: null };
    if (choice?.id === "menu_checkin") return handleCheckin({ ...ctx, state: null, message: blank });
  }

  if (startsCheckin(ctx)) return handleCheckin(ctx);

  // Nothing recognised: show what they can log.
  const firstName = patient.full_name.split(" ")[0];
  await sendOptions(message.phone, `Hola, ${firstName}. ¿Qué quieres registrar?`, MENU);
  return { nextState: { flow: "menu", step: "awaiting_choice", context: {} } };
}
