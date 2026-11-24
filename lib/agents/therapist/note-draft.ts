// Flow B draft logic (pure). No DB, no network, no "@/" runtime imports, so
// scripts/check-flow-b.mts can test it with plain Node. See
// docs/superpowers/specs/2026-11-23-flow-b-design.md.

import type { SoapExtraction } from "../../ai/soap-schema";
import type { SoapObjective } from "../../db/types";
import { describeExercise } from "../patient/parse";
import { normalize } from "../patient/signals";

// ---------------------------------------------------------------- draft shape

export type SessionNoteStep =
  | "pick_patient"
  | "disambiguate"
  | "confirm_patient"
  | "recording"
  | "asking"
  | "review"
  | "editing";

export interface TranscriptEntry {
  text: string;
  audio_url: string | null;
  received_at: string; // ISO timestamp the message arrived
}

/** Stored in sessions.draft while the note is open. */
export interface NoteDraft {
  transcripts: TranscriptEntry[];
  extraction: SoapExtraction | null;
  questions_asked: number;
  skipped: MissingItem[];
  asking: MissingItem | null;
  step: SessionNoteStep;
  /** How many transcripts the current extraction was built from (unset before the first). */
  extracted_count?: number;
}

export const EMPTY_DRAFT: NoteDraft = {
  transcripts: [],
  extraction: null,
  questions_asked: 0,
  skipped: [],
  asking: null,
  step: "recording",
};

// ---------------------------------------------------------------- what is missing (T-5)

export type MissingItem = "subjective" | "pain_nprs" | "objective" | "assessment" | "plan";

export const MAX_QUESTIONS = 3;

export const QUESTIONS: Record<MissingItem, string> = {
  subjective: "¿Qué refirió el paciente hoy? (cómo se siente, qué le molesta)",
  pain_nprs: "¿Qué dolor reportó hoy, del 0 al 10?",
  objective: "¿Qué mediste o hiciste en la sesión? (arcos, fuerza, pruebas, tratamiento)",
  assessment: "¿Cuál es tu valoración de cómo va?",
  plan: "¿Qué ejercicios o actividades deja para casa? O dime «sin cambios» si sigue con el mismo plan.",
};

export const MISSING_LABELS: Record<MissingItem, string> = {
  subjective: "subjetivo",
  pain_nprs: "escala de dolor",
  objective: "objetivo",
  assessment: "valoración",
  plan: "plan en casa",
};

/** Required items still empty, in the order they are asked: S, pain, O, A, P. */
export function missingItems(x: SoapExtraction): MissingItem[] {
  const missing: MissingItem[] = [];
  if (!x.subjective.summary.trim()) missing.push("subjective");
  if (x.subjective.pain_nprs === null) missing.push("pain_nprs");
  const o = x.objective;
  if (!o.rom.length && !o.strength.length && !o.special_tests.length && !o.treatment_given.length) {
    missing.push("objective");
  }
  if (!x.assessment.trim()) missing.push("assessment");
  if (!x.plan.keep_current_plan && !x.plan.home_exercises.length && !x.plan.activities.length) missing.push("plan");
  return missing;
}

/** The next item to ask about, or null when complete, all skipped, or three questions asked. */
export function nextQuestion(d: NoteDraft): MissingItem | null {
  if (!d.extraction || d.questions_asked >= MAX_QUESTIONS) return null;
  return missingItems(d.extraction).find((item) => !d.skipped.includes(item)) ?? null;
}

/**
 * Fix contradictions in model output before anything else reads it: when the therapist dictated
 * exercises or activities, those are the plan, even if the model also flagged "sin cambios"
 * (it does so when the dictated plan equals the current one).
 */
export function cleanExtraction(x: SoapExtraction): SoapExtraction {
  const hasList = x.plan.home_exercises.length > 0 || x.plan.activities.length > 0;
  if (x.plan.keep_current_plan && hasList) return { ...x, plan: { ...x.plan, keep_current_plan: false } };
  return x;
}

// ---------------------------------------------------------------- short replies

const DONE_WORDS = new Set(
  ["listo", "ya", "ya es todo", "eso es todo", "es todo", "termine", "terminamos", "ya termine", "fin"].map(normalize),
);
const SKIP_WORDS = new Set(
  ["omitir", "omite", "saltar", "salta", "no se", "no lo se", "no lo tengo", "sin dato", "no tengo el dato"].map(normalize),
);

const CONFIRM_WORDS = new Set(
  ["si", "ok", "okay", "confirmo", "confirmar", "confirmado", "si confirmo", "guardala", "guardar", "si guardala"].map(normalize),
);

/** A whole-message yes at the review. "Sí, pero la flexión fue 120" is a correction, not a yes. */
export function isConfirmWord(text: string): boolean {
  return CONFIRM_WORDS.has(normalize(text));
}

/** Notes that arrived after the current extraction was made (they are not in the SOAP yet). */
export function lateNotes(d: NoteDraft): TranscriptEntry[] {
  if (d.extracted_count === undefined) return [];
  return d.transcripts.slice(d.extracted_count);
}

/** "Listo" / "eso es todo": the whole message, so "listo para correr" is a note, not a close. */
export function isDoneWord(text: string): boolean {
  return DONE_WORDS.has(normalize(text));
}

export function isSkipWord(text: string): boolean {
  return SKIP_WORDS.has(normalize(text));
}

/** A bare 0-10 answer ("3", "3/10"). Anything wordier goes to the model. */
export function parsePainAnswer(text: string): number | null {
  const m = /^(\d{1,2})(\/10)?$/.exec(normalize(text));
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 10 ? n : null;
}

// ---------------------------------------------------------------- applying a revision

type Seg = string | number;

/** "plan.home_exercises[1].sets" -> ["plan", "home_exercises", 1, "sets"]. */
function parsePath(path: string): Seg[] {
  const segs: Seg[] = [];
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (!part) continue;
    segs.push(/^\d+$/.test(part) ? Number(part) : part);
  }
  return segs;
}

function startsWith(path: Seg[], prefix: Seg[]): boolean {
  return prefix.length <= path.length && prefix.every((s, i) => s === path[i]);
}

/**
 * Keep only the changes the model declared. Every difference outside the `changed` paths takes
 * the value from `before`, so a correction cannot silently rewrite text the therapist already
 * approved. Items in plan lists are matched by name, so removing one keeps the others intact.
 */
export function mergeRevision(
  before: SoapExtraction,
  after: SoapExtraction,
  changed: string[],
): { note: SoapExtraction; applied: boolean } {
  const declared = changed.map(parsePath).filter((p) => p.length > 0);
  const note = mergeValue(before, after, [], declared) as SoapExtraction;
  return { note, applied: JSON.stringify(note) !== JSON.stringify(before) };
}

function mergeValue(b: unknown, a: unknown, path: Seg[], declared: Seg[][]): unknown {
  if (declared.some((d) => startsWith(path, d))) return a; // this path (or an ancestor) was declared
  if (!declared.some((d) => startsWith(d, path))) return b; // nothing declared under here
  if (Array.isArray(b) && Array.isArray(a)) return mergeArray(b, a, path, declared);
  if (isObject(b) && isObject(a)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(b)) out[key] = mergeValue(b[key], a[key], [...path, key], declared);
    return out;
  }
  return b;
}

function mergeArray(b: unknown[], a: unknown[], path: Seg[], declared: Seg[][]): unknown[] {
  // Plan items are matched by name, other lists (ROM, strength, tests) by their whole value,
  // so removing one item does not shift or duplicate the ones after it.
  const named = b.concat(a).every((x) => isObject(x) && typeof x.name === "string");
  const key = (x: unknown) => (named ? normalize((x as { name: string }).name) : JSON.stringify(x));
  const at = (i: number): Seg[] => [...path, i];
  const touched = (i: number) => declared.some((d) => startsWith(d, at(i)));
  const whole = (i: number) => declared.some((d) => d.length === path.length + 1 && startsWith(d, at(i)));
  const itemDecls = declared.filter((d) => d.length === path.length + 1 && startsWith(d, path));
  const additions = itemDecls.filter((d) => typeof d[path.length] === "number" && (d[path.length] as number) >= b.length).length;

  const matchOf = new Map<number, number>();
  const usedA = new Set<number>();
  b.forEach((item, i) => {
    const j = a.findIndex((x, k) => !usedA.has(k) && key(x) === key(item));
    if (j >= 0) {
      usedA.add(j);
      matchOf.set(i, j);
    }
  });
  const freeA = a.map((_, j) => j).filter((j) => !usedA.has(j));
  let removals = Math.max(0, b.length + additions - a.length);

  const out: unknown[] = [];
  b.forEach((item, i) => {
    const j = matchOf.get(i);
    if (j !== undefined) {
      out.push(touched(i) ? mergeValue(item, a[j], at(i), declared) : item);
      return;
    }
    if (!touched(i)) {
      out.push(item); // changed or dropped without being declared: keep the approved value
      return;
    }
    if (whole(i) && removals > 0) {
      removals--; // declared removal
      return;
    }
    // Declared change to an item whose value changed: its counterpart is at the same position
    // when free, otherwise the next unmatched item.
    const k = freeA.includes(i) ? i : freeA[0];
    if (k === undefined) {
      out.push(item);
      return;
    }
    freeA.splice(freeA.indexOf(k), 1);
    out.push(mergeValue(item, a[k], at(i), declared));
  });
  // Declared additions: the last unmatched items the model returned.
  if (additions > 0) out.push(...freeA.slice(-additions).map((j) => a[j]));
  return out;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------- mapping to the database

export interface PlanItemInput {
  type: "exercise" | "activity";
  name: string;
  sets: number | null;
  reps: number | null;
  hold_seconds: number | null;
  frequency_per_week: number | null;
  days_of_week: number[] | null;
  instructions: string | null;
}

export interface NoteColumns {
  subjective: string | null;
  objective: SoapObjective;
  assessment: string | null;
  plan_text: string;
  pain_nprs: number | null;
  missing_fields: string[];
  source_transcript: string;
  source_audio_url: string | null;
}

const REPORT_LABELS: Record<string, string> = {
  pain_nprs: "reportar dolor",
  location: "dónde duele",
  onset_min: "a qué minuto empezó",
};

const frequency = (n: number | null) => (n !== null && n >= 1 && n <= 14 ? n : null);

/** The rows for plan_items, in order. Empty when the therapist kept the current plan. */
export function toPlanItems(x: SoapExtraction): PlanItemInput[] {
  if (x.plan.keep_current_plan) return [];
  const exercises: PlanItemInput[] = x.plan.home_exercises.map((e) => ({
    type: "exercise",
    name: e.name,
    sets: e.sets,
    reps: e.reps,
    hold_seconds: e.hold_seconds,
    frequency_per_week: frequency(e.frequency_per_week),
    days_of_week: e.days_of_week,
    instructions: e.instructions,
  }));
  const activities: PlanItemInput[] = x.plan.activities.map((a) => {
    const parts = [a.target, ...a.report.map((r) => REPORT_LABELS[r]), a.instructions].filter(
      (p): p is string => !!p && !!p.trim(),
    );
    return {
      type: "activity",
      name: a.name,
      sets: null,
      reps: null,
      hold_seconds: null,
      frequency_per_week: frequency(a.frequency_per_week),
      days_of_week: a.days_of_week,
      instructions: parts.length ? parts.join("; ") : null,
    };
  });
  return [...exercises, ...activities];
}

/** One plan line: "Elevación de pierna recta 3×12, diario", "Correr, 2×/semana (20 min; reportar dolor)". */
export function describePlanItem(item: PlanItemInput): string {
  const name = item.name.charAt(0).toUpperCase() + item.name.slice(1);
  const base = item.type === "exercise" ? describeExercise({ ...item, name }) : name;
  const freq = item.frequency_per_week === 7 ? "diario" : item.frequency_per_week ? `${item.frequency_per_week}×/semana` : "";
  const text = freq ? `${base}, ${freq}` : base;
  return item.instructions ? `${text} (${item.instructions})` : text;
}

/** "2 visitas/semana. Próxima sesión: fuerza de cuádriceps." (empty when neither was said). */
export function planHeadline(x: SoapExtraction): string {
  const parts: string[] = [];
  const visits = x.plan.visits_per_week;
  if (visits) parts.push(`${visits} ${visits === 1 ? "visita" : "visitas"}/semana.`);
  if (x.plan.next_session_focus) parts.push(`Próxima sesión: ${x.plan.next_session_focus}.`);
  return parts.join(" ");
}

/** The sessions columns written on confirm. */
export function toNoteColumns(x: SoapExtraction, missing: MissingItem[], transcripts: TranscriptEntry[]): NoteColumns {
  const s = x.subjective;
  const subjective = [
    s.summary.trim(),
    s.aggravating.length ? `Agrava: ${s.aggravating.join(", ")}.` : "",
    s.functional_limits.length ? `Limitaciones: ${s.functional_limits.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  const items = toPlanItems(x);
  const planLines = [planHeadline(x)];
  if (x.plan.keep_current_plan) planLines.push("Plan en casa: sin cambios.");
  else if (items.length) planLines.push("Plan en casa:", ...items.map((it, i) => `${i + 1}. ${describePlanItem(it)}`));

  const ordered = [...transcripts].sort((a, b) => a.received_at.localeCompare(b.received_at));
  return {
    subjective: subjective || null,
    objective: x.objective,
    assessment: x.assessment.trim() || null,
    plan_text: planLines.filter(Boolean).join("\n"),
    pain_nprs: x.subjective.pain_nprs,
    missing_fields: missing,
    source_transcript: ordered.map((t) => t.text).join("\n\n"),
    source_audio_url: ordered.find((t) => t.audio_url)?.audio_url ?? null,
  };
}
