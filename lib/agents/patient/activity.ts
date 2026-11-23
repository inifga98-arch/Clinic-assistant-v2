import "server-only";
import { zodResponseFormat } from "openai/helpers/zod";
import { openai } from "@/lib/ai/openai";
import { db } from "@/lib/db/server";
import { optionalEnv } from "@/lib/env";
import type { Patient } from "@/lib/db/types";
import type { AgentResult, ConversationState, PatientContext } from "@/lib/agents/types";
import { sendText } from "@/lib/whatsapp/send";
import { ACTIVITY_PROMPT, ActivityExtraction, type ActivityFields } from "./activity-schema";
import { parseDuration, parseOnset, parsePainReply } from "./parse";
import { handleRedFlag } from "./safety";
import { detectRedFlags, normalize, painScoreIn } from "./signals";

// P-5 activity log (Flow D). Owner: Person 3.
// "Fui a correr y me dolió la rodilla a los 20 min" -> the model extracts the fields, then we
// ask only for what is missing, one question at a time, at most MAX_QUESTIONS, and save.
// Follow-up answers are parsed with plain rules (no second model call).

const FLOW = "activity";
const MAX_QUESTIONS = 3;

type Field = "activity" | "duration_min" | "pain_nprs" | "pain_location" | "onset_min";

const QUESTIONS: Record<Field, string> = {
  activity: "¿Qué actividad hiciste?",
  duration_min: "¿Cuánto tiempo fue en total?",
  pain_nprs: "¿Te dolió? Del 0 al 10, donde 0 es nada de dolor.",
  pain_location: "¿Dónde exactamente te dolió?",
  onset_min: "¿En qué minuto empezó el dolor?",
};

interface ActivityContext {
  [key: string]: unknown;
  fields: ActivityFields;
  texts: string[]; // everything the patient said in this log, for the comment and red flags
  asked: Field[];
}

const state = (step: string, context: ActivityContext): ConversationState => ({ flow: FLOW, step, context });

/** Start a log from the patient's first description (text or a voice-note transcript). */
export async function startActivity(ctx: PatientContext, text: string): Promise<AgentResult> {
  const fields = await extract(text);
  return next(ctx.patient, ctx.message.phone, { fields, texts: [text], asked: [] });
}

/** Ask the patient to describe the activity (from the menu). */
export async function promptActivity(phone: string): Promise<AgentResult> {
  await sendText(phone, "Cuéntame qué hiciste y cómo te sentiste. Por ejemplo: *corrí 20 minutos y al final me dolió la rodilla*.");
  return { nextState: state("awaiting_description", { fields: emptyFields(), texts: [], asked: [] }) };
}

export async function handleActivity(ctx: PatientContext): Promise<AgentResult> {
  const { patient, message } = ctx;
  const context = ctx.state!.context as ActivityContext;
  const step = ctx.state!.step;
  const answer = message.body.trim();

  if (step === "awaiting_description") return startActivity(ctx, answer);

  const field = step.replace(/^awaiting_/, "") as Field;
  const fields = { ...context.fields };
  if (field === "activity") fields.activity = answer ? capitalize(answer.slice(0, 60)) : null;
  if (field === "duration_min") fields.duration_min = parseDuration(answer);
  if (field === "pain_nprs") {
    const { pain, comment } = parsePainReply(answer);
    fields.pain_nprs = pain;
    if (pain === 0) fields.no_pain = true;
    if (comment) fields.comment = [fields.comment, comment].filter(Boolean).join(". ");
  }
  if (field === "pain_location") fields.pain_location = answer ? answer.slice(0, 120) : null;
  if (field === "onset_min") fields.onset_min = parseOnset(answer);

  return next(patient, message.phone, { fields, texts: [...context.texts, answer], asked: [...context.asked, field] });
}

/** Ask the next missing field, or save when nothing is missing or we've asked enough. */
async function next(patient: Patient, phone: string, context: ActivityContext): Promise<AgentResult> {
  const allText = context.texts.join(". ");
  const urgent = detectRedFlags(allText, context.fields.pain_nprs).length > 0;
  const missing = urgent ? null : nextMissing(context);
  if (missing) {
    await sendText(phone, QUESTIONS[missing]);
    return { nextState: state(`awaiting_${missing}`, context) };
  }
  await save(patient, phone, context);
  return { nextState: null };
}

function nextMissing({ fields, asked }: ActivityContext): Field | null {
  if (asked.length >= MAX_QUESTIONS) return null;
  const hurt = (fields.pain_nprs ?? 0) > 0;
  const order: Array<[Field, boolean]> = [
    ["activity", fields.activity === null],
    ["duration_min", fields.duration_min === null],
    ["pain_nprs", fields.pain_nprs === null && !fields.no_pain],
    ["pain_location", hurt && fields.pain_location === null],
    ["onset_min", hurt && fields.onset_min === null],
  ];
  // Never ask the same thing twice: an answer we couldn't parse stays as text in the comment.
  return order.find(([field, isMissing]) => isMissing && !asked.includes(field))?.[0] ?? null;
}

async function save(patient: Patient, phone: string, { fields, texts }: ActivityContext): Promise<void> {
  const allText = texts.join(". ");
  const pain = fields.no_pain && fields.pain_nprs === null ? 0 : fields.pain_nprs;
  const flags = detectRedFlags(allText, pain);
  const activity = fields.activity ?? "Actividad";

  const { error } = await db().from("activity_logs").insert({
    patient_id: patient.id,
    plan_item_id: await matchPlanActivity(patient.id, activity),
    activity,
    duration_min: fields.duration_min,
    pain_nprs: pain,
    pain_location: fields.pain_location,
    onset_min: fields.onset_min,
    pain_duration: fields.pain_duration,
    comment: [fields.comment, `Paciente: «${allText.slice(0, 800)}»`].filter(Boolean).join("\n"),
    red_flag: flags.length > 0,
  });
  if (error) throw new Error(`activity: could not save log: ${error.message}`);

  if (flags.length > 0) {
    await handleRedFlag(patient, phone, `${activity}: ${allText}`, flags, { pain, record: false });
    return;
  }
  await sendText(phone, `Anotado: ${summary(activity, fields, pain)}. Tu terapeuta lo verá antes de tu próxima sesión.`);
}

function summary(activity: string, fields: ActivityFields, pain: number | null): string {
  const parts = [activity.toLowerCase() + (fields.duration_min !== null ? ` ${fields.duration_min} min` : "")];
  if (pain === 0) parts.push("sin dolor");
  else if (pain !== null) {
    let p = `dolor ${pain}/10`;
    if (fields.pain_location) p += ` en ${fields.pain_location}`;
    if (fields.onset_min !== null) p += fields.onset_min === 0 ? " desde el inicio" : ` desde el minuto ${fields.onset_min}`;
    parts.push(p);
  }
  return parts.join(", ");
}

/** Link the log to a plan activity ("Correr 20 min") when the names match. */
async function matchPlanActivity(patientId: string, activity: string): Promise<string | null> {
  const { data: plan } = await db().from("plans").select("id").eq("patient_id", patientId).eq("status", "active").maybeSingle<{ id: string }>();
  if (!plan) return null;
  const { data: items } = await db().from("plan_items").select("id, name").eq("plan_id", plan.id).eq("type", "activity");
  const a = normalize(activity);
  const hit = (items ?? []).find((i: { id: string; name: string }) => {
    const n = normalize(i.name);
    return n.startsWith(a) || a.startsWith(n.split(" ")[0]);
  });
  return hit?.id ?? null;
}

/** Model extraction, with a rules-only fallback so a model outage never loses the log. */
async function extract(text: string): Promise<ActivityFields> {
  try {
    const completion = await openai().chat.completions.parse({
      model: optionalEnv("OPENAI_EXTRACT_MODEL", "gpt-4.1"),
      messages: [
        { role: "system", content: ACTIVITY_PROMPT },
        { role: "user", content: text },
      ],
      response_format: zodResponseFormat(ActivityExtraction, "activity_log"),
    });
    const parsed = completion.choices[0]?.message.parsed;
    if (parsed) return parsed;
    console.error("[activity] model returned no parsed output");
  } catch (err) {
    console.error("[activity] extraction failed, using rules", err);
  }
  return { ...emptyFields(), duration_min: parseDuration(text), pain_nprs: painScoreIn(text) };
}

function emptyFields(): ActivityFields {
  return {
    activity: null,
    duration_min: null,
    pain_nprs: null,
    no_pain: false,
    pain_location: null,
    onset_min: null,
    pain_duration: null,
    comment: null,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
