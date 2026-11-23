import "server-only";
import { db } from "@/lib/db/server";
import type { Patient, PlanItem } from "@/lib/db/types";
import type { AgentResult, ConversationState, PatientContext } from "@/lib/agents/types";
import { matchOption, sendOptions, sendText, type Option } from "@/lib/whatsapp/send";
import { CHECKIN_PAYLOADS, describeExercise, parseCheckinStatus, parseNumberList, parsePainReply, type CheckinStatus } from "./parse";
import { handleRedFlag } from "./safety";
import { detectRedFlags } from "./signals";
import { clinicTimeToUtc, clinicToday } from "./time";

// P-3 / P-4 exercise check-in (Flow C). Owner: Person 3.
// Starts from a reminder reply (Done / Some / Not today) or from the patient ("hice mis
// ejercicios"), then asks which exercises (for "Some") and the pain during them.
//
//   awaiting_status -> awaiting_items -> awaiting_pain -> saved

const FLOW = "checkin";

export const STATUS_OPTIONS: Option[] = [
  { id: "checkin_all", title: "Todos" },
  { id: "checkin_some", title: "Algunos" },
  { id: "checkin_none", title: "Hoy no" },
];

export interface CheckinContext {
  [key: string]: unknown;
  date: string;
  items: { id: string; label: string }[];
  done?: string[];
}

const state = (step: string, context: CheckinContext): ConversationState => ({ flow: FLOW, step, context });

/** Today's exercises from the patient's active plan, in the order the therapist set. */
export async function todaysExercises(patientId: string, now = new Date()): Promise<PlanItem[]> {
  const { weekday } = clinicToday(now);
  const { data: plan, error: planErr } = await db()
    .from("plans")
    .select("id")
    .eq("patient_id", patientId)
    .eq("status", "active")
    .maybeSingle<{ id: string }>();
  if (planErr) throw new Error(`todaysExercises(plan): ${planErr.message}`);
  if (!plan) return [];
  const { data, error } = await db()
    .from("plan_items")
    .select("*")
    .eq("plan_id", plan.id)
    .eq("type", "exercise")
    .order("position");
  if (error) throw new Error(`todaysExercises(items): ${error.message}`);
  return (data as PlanItem[]).filter((i) => !i.days_of_week || i.days_of_week.includes(weekday));
}

/** Should this message (with no flow in progress) start a check-in? */
export function startsCheckin(ctx: PatientContext): boolean {
  const reply = ctx.message.buttonPayload ?? ctx.message.body;
  return parseCheckinStatus(reply, true) !== null || /\bejercicio/i.test(ctx.message.body);
}

export async function handleCheckin(ctx: PatientContext): Promise<AgentResult> {
  const { patient, message } = ctx;
  const reply = message.buttonPayload ?? message.body;
  const inFlow = ctx.state?.flow === FLOW;
  const context = inFlow ? (ctx.state!.context as CheckinContext) : await freshContext(patient);

  if (context.items.length === 0) {
    await sendText(
      message.phone,
      "Hoy no tienes ejercicios en tu plan. Si hiciste alguna actividad, cuéntame cómo te fue.",
    );
    return { nextState: null };
  }

  const step = inFlow ? ctx.state!.step : "awaiting_status";

  if (step === "awaiting_status") {
    const option = matchOption(reply, STATUS_OPTIONS);
    const status: CheckinStatus | null = option
      ? CHECKIN_PAYLOADS[option.id]
      : parseCheckinStatus(reply, !inFlow);
    if (status === "all") return askPain(message.phone, { ...context, done: context.items.map((i) => i.id) });
    if (status === "some") {
      await sendText(
        message.phone,
        `¿Cuáles hiciste? Responde con los números, por ejemplo *1* o *1 y 3*.\n\n${numbered(context)}`,
      );
      return { nextState: state("awaiting_items", context) };
    }
    if (status === "none") {
      await saveLogs(patient, context, [], null, null);
      await sendText(
        message.phone,
        patient.reminders_opt_in
          ? "Gracias por avisarme. Mañana te vuelvo a recordar."
          : "Gracias por avisarme. Escríbeme cuando los hagas.",
      );
      return { nextState: null };
    }
    await sendOptions(message.phone, `¿Cómo te fue hoy con tus ejercicios?\n\n${bulleted(context)}`, STATUS_OPTIONS);
    return { nextState: state("awaiting_status", context) };
  }

  if (step === "awaiting_items") {
    const picked = parseNumberList(reply, context.items.length);
    if (picked.length === 0) {
      await sendText(message.phone, `Responde con los números de los que hiciste, por ejemplo *1*.\n\n${numbered(context)}`);
      return { nextState: state("awaiting_items", context) };
    }
    return askPain(message.phone, { ...context, done: picked.map((n) => context.items[n - 1].id) });
  }

  if (step === "awaiting_pain") {
    const { pain, comment } = parsePainReply(reply);
    if (pain === null) {
      await sendText(message.phone, "Del 0 al 10, ¿cuánto dolor sentiste? 0 es nada de dolor.");
      return { nextState: state("awaiting_pain", context) };
    }
    await saveLogs(patient, context, context.done ?? [], pain, comment);

    const flags = detectRedFlags(reply, pain);
    if (flags.length > 0) {
      const summary = `Check-in de ejercicios: dolor ${pain}/10${comment ? `. ${comment}` : ""}`;
      await handleRedFlag(patient, message.phone, summary, flags, { pain });
      return { nextState: null };
    }
    await sendText(message.phone, "Gracias, lo anoté para tu terapeuta. ¡Sigue así!");
    return { nextState: null };
  }

  return handleCheckin({ ...ctx, state: null });
}

/** Today's check-in context for a patient (also used by the reminder scheduler). */
export async function freshContext(patient: Patient): Promise<CheckinContext> {
  const items = await todaysExercises(patient.id);
  return { date: clinicToday().date, items: items.map((i) => ({ id: i.id, label: describeExercise(i) })) };
}

function numbered(context: CheckinContext): string {
  return context.items.map((item, i) => `${i + 1}. ${item.label}`).join("\n");
}

function bulleted(context: CheckinContext): string {
  return context.items.map((item) => `• ${item.label}`).join("\n");
}

async function askPain(phone: string, context: CheckinContext): Promise<AgentResult> {
  await sendText(phone, "¿Sentiste dolor al hacerlos? Del 0 al 10, y si quieres, un comentario.");
  return { nextState: state("awaiting_pain", context) };
}

/** One row per exercise for the day (re-answering the same day overwrites it). */
async function saveLogs(
  patient: Patient,
  context: CheckinContext,
  doneIds: string[],
  pain: number | null,
  comment: string | null,
): Promise<void> {
  const rows = context.items.map((item) => {
    const done = doneIds.includes(item.id);
    return {
      patient_id: patient.id,
      plan_item_id: item.id,
      log_date: context.date,
      done,
      pain_nprs: done ? pain : null,
      comment: done ? comment : null,
    };
  });
  const { error } = await db().from("exercise_logs").upsert(rows, { onConflict: "plan_item_id,log_date" });
  if (error) throw new Error(`checkin: could not save logs: ${error.message}`);
  await markReminderAnswered(patient.id, context.date);
}

/** The reminder sent today has been answered (feeds the H3 response-rate metric). */
async function markReminderAnswered(patientId: string, date: string): Promise<void> {
  const { error } = await db()
    .from("reminders")
    .update({ status: "answered" })
    .eq("patient_id", patientId)
    .eq("status", "sent")
    .gte("due_at", clinicTimeToUtc(date, "00:00").toISOString());
  if (error) console.error("[checkin] could not mark reminder answered", patientId, error.message);
}
