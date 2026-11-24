import "server-only";
import { startWelcome } from "@/lib/agents/patient/welcome";
import type { AgentResult, ConversationState, TherapistContext } from "@/lib/agents/types";
import { extractRegistration } from "@/lib/ai/intake-extract";
import type { RegistrationExtraction } from "@/lib/ai/intake-schema";
import type { Patient, Therapist } from "@/lib/db/types";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import { startEvaluationFor, offerEvaluation } from "./initial-eval";
import { classifyNumber, parsePatientPhone } from "./intake-logic";
import { REGISTRATION_OPTIONS, REGISTRATION_PROMPT, formatRegistrationCard } from "./intake-format";
import { isConfirmWord } from "./note-draft";
import { createPatient, getPatient, numberOwners, reactivatePatient, sameNamePatient } from "./patient-store";
import { noteFrom, startSessionNoteFor } from "./session-note";

// Flow A, piece 1: register a patient with name and WhatsApp only (T-2). Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-24-flow-a-design.md. The model only extracts the name,
// number and reason; code checks the number, duplicates, and saves on Guardar.

const FLOW = "new_patient";
type Step = "details" | "missing" | "card" | "fixing" | "existing" | "discharged";

interface Ctx {
  reg?: RegistrationExtraction; // phone is E.164 once valid
  sameName?: { full_name: string; dob: string | null } | null;
  ownerId?: string;
  ownerName?: string;
}

const EXISTING_OPTIONS: Option[] = [
  { id: "note", title: "Nota de sesión", icon: "📝" },
  { id: "eval", title: "Valoración inicial", icon: "🩺" },
  { id: "cancel", title: "Cancelar", icon: "🗑️" },
];
const REACTIVATE_OPTIONS: Option[] = [
  { id: "reactivate", title: "Reactivar", icon: "✅" },
  { id: "cancel", title: "Cancelar", icon: "🗑️" },
];

const state = (step: Step, context: Ctx = {}): AgentResult => ({
  nextState: { flow: FLOW, step, context: context as Record<string, unknown> },
});
const done = (): AgentResult => ({ nextState: null });

export async function startNewPatient(ctx: TherapistContext): Promise<AgentResult> {
  await sendText(ctx.message.phone, REGISTRATION_PROMPT);
  return state("details");
}

export async function handleNewPatient(ctx: TherapistContext): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const current = ctx.state as ConversationState;
  const step = current.step as Step;
  const c = current.context as Ctx;
  const pick = (options: Option[]) => matchOption(message.buttonPayload ?? message.body, options);

  switch (step) {
    case "card": {
      const choice = pick(REGISTRATION_OPTIONS);
      if (choice?.id === "save" || (!choice && isConfirmWord(message.body))) return save(ctx, c);
      if (choice?.id === "cancel") {
        await sendText(phone, "Cancelado. No se guardó nada.");
        return done();
      }
      if (choice?.id === "fix") {
        await sendText(phone, "✏️ ¿Qué corrijo? Escríbelo o dilo, p. ej. «el número termina en 79».");
        return state("fixing", c);
      }
      return understand(ctx, c, true); // a correction typed straight away
    }

    case "existing": {
      const choice = pick(EXISTING_OPTIONS);
      const patient = c.ownerId ? await getPatient(c.ownerId) : null;
      if (choice?.id === "cancel" || !patient) {
        await sendText(phone, "Cancelado. No se guardó nada.");
        return done();
      }
      if (choice?.id === "note") return startSessionNoteFor(ctx, patient);
      if (choice?.id === "eval") return startEvaluationFor(phone, therapist, patient);
      await sendOptions(phone, `Ese número ya es de *${c.ownerName}*. ¿Qué hacemos?`, EXISTING_OPTIONS);
      return state(step, c);
    }

    case "discharged": {
      const choice = pick(REACTIVATE_OPTIONS);
      if (choice?.id === "reactivate" || (!choice && isConfirmWord(message.body))) {
        if (!c.ownerId) return done();
        const patient = await reactivatePatient(c.ownerId, therapist.id);
        await sendText(phone, `✅ El expediente de *${patient.full_name}* está activo otra vez y asignado a ti.`);
        if (!patient.consent_at) await sendWelcome(phone, patient);
        return offerEvaluation(phone, patient);
      }
      if (choice?.id === "cancel") {
        await sendText(phone, "Cancelado. No se cambió nada.");
        return done();
      }
      await sendOptions(phone, `*${c.ownerName}* tenía el alta. ¿Reactivo su expediente?`, REACTIVATE_OPTIONS);
      return state(step, c);
    }

    case "details":
      return understand(ctx, c, false);
    case "missing":
    case "fixing":
      return understand(ctx, c, true);
    default:
      return done();
  }
}

/** Read the therapist's message (voice or text), update the card and decide the next step. */
async function understand(ctx: TherapistContext, c: Ctx, isCorrection: boolean): Promise<AgentResult> {
  const { message, therapist } = ctx;
  const phone = message.phone;
  const step = (ctx.state?.step as Step) ?? "details";

  const note = await noteFrom(message);
  if (!note || !note.text.trim()) {
    await sendText(phone, "No pude escuchar tu nota de voz. ¿Me lo escribes?");
    return state(step, c);
  }
  if (note.audio_url) await sendText(phone, `🎙️ Esto entendí: «${note.text.trim()}»`);

  let reg: RegistrationExtraction;
  try {
    reg = isCorrection && c.reg ? await extractRegistration(note.text, c.reg) : await extractRegistration(note.text);
  } catch (err) {
    console.error("[new-patient] extraction failed", message.sid, err);
    await sendText(phone, "No pude procesar eso. ¿Me lo dices otra vez?");
    return state(step, c);
  }
  // Keep what we already had when the new message only filled in the missing piece.
  if (c.reg && isCorrection) {
    reg = { full_name: reg.full_name ?? c.reg.full_name, phone: reg.phone ?? c.reg.phone, reason: reg.reason ?? c.reg.reason };
  }
  return decide(ctx, { ...c, reg }, therapist);
}

async function decide(ctx: TherapistContext, c: Ctx, therapist: Therapist): Promise<AgentResult> {
  const phone = ctx.message.phone;
  const reg = c.reg!;
  const name = reg.full_name?.trim();
  if (!name) {
    await sendText(phone, "¿Cuál es su *nombre completo*?");
    return state("missing", c);
  }
  const e164 = parsePatientPhone(reg.phone);
  if (!e164) {
    await sendText(
      phone,
      reg.phone ? `No entendí el número «${reg.phone}». ¿Cuál es su *WhatsApp*? (10 dígitos)` : "¿Cuál es su *WhatsApp*?",
    );
    return state("missing", { ...c, reg: { ...reg, phone: null } });
  }
  const card = { ...reg, full_name: name, phone: e164 };

  const owner = classifyNumber(await numberOwners(e164), therapist.clinic_id);
  switch (owner.kind) {
    case "therapist":
      await sendText(phone, "Ese número es de un terapeuta. ¿Cuál es el *WhatsApp* del paciente?");
      return state("missing", { reg: { ...card, phone: null } });
    case "other_clinic":
      await sendText(phone, "Ese número ya está registrado en otra clínica. No guardé nada.");
      return done();
    case "existing":
      await sendOptions(phone, `Ese número ya es de *${owner.patient.full_name}*. ¿Qué hacemos?`, EXISTING_OPTIONS);
      return state("existing", { ownerId: owner.patient.id, ownerName: owner.patient.full_name });
    case "discharged":
      await sendOptions(phone, `*${owner.patient.full_name}* tenía el alta. ¿Reactivo su expediente?`, REACTIVATE_OPTIONS);
      return state("discharged", { ownerId: owner.patient.id, ownerName: owner.patient.full_name });
    case "new": {
      const sameName = await sameNamePatient(therapist.clinic_id, name);
      await sendOptions(
        phone,
        formatRegistrationCard({ full_name: name, phone: e164, reason: reg.reason }, sameName ?? undefined),
        REGISTRATION_OPTIONS,
      );
      return state("card", { reg: card, sameName });
    }
  }
}

async function save(ctx: TherapistContext, c: Ctx): Promise<AgentResult> {
  const phone = ctx.message.phone;
  const reg = c.reg;
  if (!reg?.full_name || !reg.phone) return decide(ctx, c, ctx.therapist);
  const patient = await createPatient(ctx.therapist, { full_name: reg.full_name, phone: reg.phone, reason: reg.reason });
  if (patient === "duplicate") return decide(ctx, c, ctx.therapist); // taken meanwhile: show who has it
  await sendText(phone, `✅ *${patient.full_name}* ya está en el expediente.`);
  await sendWelcome(phone, patient);
  return offerEvaluation(phone, patient);
}

/** Cherub's welcome (privacy notice + reminders). Twilio reports delivery later, so say how it works. */
async function sendWelcome(therapistPhone: string, patient: Patient): Promise<void> {
  let note = "📨 Le envié la bienvenida para que acepte el aviso de privacidad y elija sus recordatorios.";
  try {
    await startWelcome(patient);
  } catch (err) {
    console.error("[new-patient] welcome failed", patient.id, err);
    note = "📨 No pude enviarle la bienvenida. Le llegará en cuanto escriba «hola» a este número.";
  }
  if (!process.env.TWILIO_TEMPLATE_WELCOME) {
    note += "\nMientras usemos el número de prueba, solo le llega si antes mandó *join east-people* al +1 415 523 8886.";
  }
  await sendText(therapistPhone, note);
}
