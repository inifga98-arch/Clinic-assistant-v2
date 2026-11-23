import "server-only";
import { db } from "@/lib/db/server";
import type { Patient, Therapist } from "@/lib/db/types";
import type { IncomingMessage } from "@/lib/agents/types";
import { handleTherapistMessage } from "@/lib/agents/therapist";
import { handlePatientMessage } from "@/lib/agents/patient";
import { phoneVariants } from "@/lib/whatsapp/phone";
import { normalizeText, sendText } from "@/lib/whatsapp/send";
import { loadState, saveState } from "./state";

/** Words that drop the current flow from any step (X-3). Saved data is never touched. */
const RESET_WORDS = new Set(["menu", "menú", "cancelar", "cancel", "inicio"].map(normalizeText));

export type Sender =
  | { role: "therapist"; therapist: Therapist }
  | { role: "patient"; patient: Patient }
  | { role: "unknown" };

/** R-4: who is writing? A phone on an active therapist wins over a patient row. */
export async function findSender(phone: string): Promise<Sender> {
  const variants = phoneVariants(phone); // a hand-typed Mexican number may lack the "1"
  const { data: therapist, error: tErr } = await db()
    .from("therapists")
    .select("*")
    .in("phone", variants)
    .eq("active", true)
    .limit(1)
    .maybeSingle<Therapist>();
  if (tErr) throw new Error(`findSender(therapist): ${tErr.message}`);
  if (therapist) return { role: "therapist", therapist };

  const { data: patient, error: pErr } = await db()
    .from("patients")
    .select("*")
    .in("phone", variants)
    .limit(1)
    .maybeSingle<Patient>();
  if (pErr) throw new Error(`findSender(patient): ${pErr.message}`);
  if (patient) return { role: "patient", patient };

  return { role: "unknown" };
}

/**
 * Route a stored message and, if anything fails, tell the sender instead of going silent.
 * Never throws: the webhook calls it after replying to Twilio, so nobody would catch it.
 */
export async function processIncoming(message: IncomingMessage): Promise<void> {
  try {
    await routeMessage(message);
  } catch (err) {
    console.error("[router] routing failed", message.sid, err);
    try {
      await sendText(message.phone, "Algo salió mal de nuestro lado. Intenta de nuevo en un momento.");
    } catch (sendErr) {
      console.error("[router] could not send the error notice", message.sid, sendErr);
    }
  }
}

/** Route one incoming message to the right agent and persist the next state. */
export async function routeMessage(message: IncomingMessage): Promise<void> {
  const sender = await findSender(message.phone);

  if (sender.role === "unknown") {
    await sendText(
      message.phone,
      "Hola. Este número es para pacientes y terapeutas de la clínica. " +
        "Si eres paciente, pide a tu clínica que te registre.",
    );
    return;
  }

  const reset = RESET_WORDS.has(normalizeText(message.body));
  const state = reset ? null : await loadState(message.phone);

  if (sender.role === "therapist") {
    const result = await handleTherapistMessage({
      therapist: sender.therapist,
      message,
      state,
      reset,
    });
    await saveState(message.phone, "therapist", result.nextState);
  } else {
    const result = await handlePatientMessage({ patient: sender.patient, message, state, reset });
    await saveState(message.phone, "patient", result.nextState);
  }
}
