import "server-only";
import { db } from "@/lib/db/server";
import type { Patient } from "@/lib/db/types";
import type { AgentResult, ConversationState, PatientContext } from "@/lib/agents/types";
import { saveState } from "@/lib/router/state";
import { matchOption, sendOptions, sendTemplate, sendText, type Option } from "@/lib/whatsapp/send";
import { formatTime, parseTime, parseYesNo } from "./parse";

// P-1 welcome + consent. Owner: Person 3.
// A patient must accept the privacy notice before anything is logged for them. Then they
// choose whether to get reminders, and at what time.
//
//   awaiting_consent -> awaiting_opt_in -> awaiting_time -> done
//
// Replies are understood without saved state too (the welcome template may be answered
// hours later, after the 30-minute state has expired).

const FLOW = "welcome";

const CONSENT: Option[] = [
  { id: "consent_yes", title: "Acepto" },
  { id: "consent_no", title: "No acepto" },
];
const OPT_IN: Option[] = [
  { id: "optin_yes", title: "Sí, recuérdame" },
  { id: "optin_no", title: "No, gracias" },
];
const TIMES: Option[] = [
  { id: "08:00", title: "Mañana (8:00 am)" },
  { id: "14:00", title: "Tarde (2:00 pm)" },
  { id: "19:00", title: "Noche (7:00 pm)" },
];

const state = (step: string): ConversationState => ({ flow: FLOW, step, context: {} });

function privacyLine(): string {
  const url = process.env.PRIVACY_NOTICE_URL;
  return url
    ? `Puedes leer el aviso de privacidad aquí: ${url}`
    : "Puedes pedir el aviso de privacidad completo en la clínica.";
}

async function clinicName(patient: Patient): Promise<string> {
  const { data } = await db().from("clinics").select("name").eq("id", patient.clinic_id).maybeSingle<{ name: string }>();
  return data?.name ?? "tu clínica";
}

function welcomeText(firstName: string, clinic: string): string {
  return (
    `Hola, ${firstName}. Soy el asistente de ${clinic}. Entre sesiones te ayudo a registrar ` +
    "tus ejercicios y cómo te sientes, y tu terapeuta lo ve antes de tu próxima cita.\n\n" +
    `Para eso guardo tus respuestas en tu expediente. ${privacyLine()}\n\n¿Aceptas?`
  );
}

/**
 * Send the welcome to a newly registered patient and wait for their consent.
 * For Person 1 to call after Flow A saves the patient (T-2 / P-1).
 *
 * Outside the 24 h window only an approved template can start the conversation. Set
 * TWILIO_TEMPLATE_WELCOME to its HX... id; until then this sends plain text, which only
 * arrives if the patient wrote to us in the last 24 h.
 */
export async function startWelcome(patient: Patient): Promise<void> {
  if (!patient.phone) return;
  const firstName = patient.full_name.split(" ")[0];
  const clinic = await clinicName(patient);
  const template = process.env.TWILIO_TEMPLATE_WELCOME;
  if (template) await sendTemplate(patient.phone, template, { "1": firstName, "2": clinic });
  else await sendOptions(patient.phone, welcomeText(firstName, clinic), CONSENT);
  await saveState(patient.phone, "patient", state("awaiting_consent"));
}

/** True when this message belongs to the welcome flow and should go to handleWelcome. */
export function needsWelcome(ctx: PatientContext): boolean {
  return ctx.state?.flow === FLOW || !ctx.patient.consent_at;
}

export async function handleWelcome(ctx: PatientContext): Promise<AgentResult> {
  const { patient, message } = ctx;
  const reply = message.buttonPayload ?? message.body;
  const firstName = patient.full_name.split(" ")[0];
  const step = ctx.state?.flow === FLOW ? ctx.state.step : patient.consent_at ? "awaiting_opt_in" : "awaiting_consent";

  if (step === "awaiting_consent") {
    const answer = matchOption(reply, CONSENT)?.id ?? yesNoId(reply, "consent");
    if (answer === "consent_yes") {
      await update(patient, { consent_at: new Date().toISOString() });
      await sendOptions(
        message.phone,
        "¡Gracias! ¿Quieres que te mande un recordatorio diario de tus ejercicios?",
        OPT_IN,
      );
      return { nextState: state("awaiting_opt_in") };
    }
    if (answer === "consent_no") {
      await sendText(
        message.phone,
        "Entendido, no guardaré nada. Si cambias de opinión, escríbeme *acepto* cuando quieras.",
      );
      return { nextState: null };
    }
    // First contact, or an unclear answer: (re)send the welcome.
    await sendOptions(message.phone, welcomeText(firstName, await clinicName(patient)), CONSENT);
    return { nextState: state("awaiting_consent") };
  }

  if (step === "awaiting_opt_in") {
    const answer = matchOption(reply, OPT_IN)?.id ?? yesNoId(reply, "optin");
    if (answer === "optin_yes") {
      await sendOptions(message.phone, "¿A qué hora te escribo? También puedes poner otra hora, como *6:30 pm*.", TIMES);
      return { nextState: state("awaiting_time") };
    }
    if (answer === "optin_no") {
      await update(patient, { reminders_opt_in: false });
      await sendText(
        message.phone,
        "Listo, sin recordatorios. Escríbeme cuando hagas tus ejercicios o una actividad y lo anoto.",
      );
      return { nextState: null };
    }
    await sendOptions(message.phone, "¿Quieres un recordatorio diario de tus ejercicios?", OPT_IN);
    return { nextState: state("awaiting_opt_in") };
  }

  if (step === "awaiting_time") {
    const time = matchOption(reply, TIMES)?.id ?? parseTime(reply);
    if (!time) {
      await sendOptions(message.phone, "No entendí la hora. ¿A qué hora te escribo? Por ejemplo *8:00 am* o *7:30 pm*.", TIMES);
      return { nextState: state("awaiting_time") };
    }
    await update(patient, { reminder_time: time, reminders_opt_in: true });
    await sendText(
      message.phone,
      `Perfecto, te escribiré a las ${formatTime(time)} los días que tengas ejercicios. ` +
        "Si algún día quieres dejar de recibirlos, escribe *parar*.",
    );
    return { nextState: null };
  }

  // Unknown step (e.g. an old state shape): start over.
  return handleWelcome({ ...ctx, state: null });
}

function yesNoId(reply: string, prefix: "consent" | "optin"): string | null {
  const yn = parseYesNo(reply);
  return yn ? `${prefix}_${yn}` : null;
}

async function update(patient: Patient, fields: Partial<Patient>): Promise<void> {
  const { error } = await db().from("patients").update(fields).eq("id", patient.id);
  if (error) throw new Error(`welcome: could not update patient ${patient.id}: ${error.message}`);
}
