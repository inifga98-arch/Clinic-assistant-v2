// A patient's whole record as numbered entries for the model (pure). Used by "ask about a
// patient" after the prep brief, and meant for Flow F (handoff). Each entry has a label made by
// code ("nota 20 nov") so the sources shown to the therapist can't be invented.
// No runtime "@/" imports so scripts/check-ask.mts can test it.

import { describeActivity, exerciseSummary, type ActivityLogLite, type ExerciseLogLite, type ExerciseSummary } from "./prep-logic";
import { shortDate } from "./prep-format";

export interface RecordEntry {
  label: string;
  text: string;
}

export interface RecordData {
  today: string; // clinic date
  patient: {
    full_name: string;
    diagnosis: string | null;
    intake_reason: string | null;
    referring_doctor: string | null;
    dob: string | null;
    sex: string | null;
  };
  evaluation: { date: string; data: Record<string, unknown> } | null; // newest confirmed
  notes: { date: string; pain: number | null; text: string }[]; // confirmed, any order
  plans: { start: string; end: string | null; lines: string[] }[]; // any order
  exerciseLogs: ExerciseLogLite[];
  items: { id: string; name: string }[]; // every plan item the logs can point to
  activities: ActivityLogLite[];
}

const MAX_NOTES = 25;
const MAX_ACTIVITIES = 60;
const MAX_WEEKS = 12;
const EVAL_MAX = 3000;

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (date: string): string => {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
};
/** A log's clinic date from its timestamp (America/Mexico_City). */
const clinicDateOf = (ts: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(ts));

/** Exercise adherence per week (Monday start) from the first plan's start through yesterday; the last 12 weeks. */
export function weeklyAdherence(
  logs: ExerciseLogLite[],
  items: { id: string; name: string }[],
  from: string | null,
  today: string,
): { weekStart: string; days: number; summary: ExerciseSummary }[] {
  if (!from || !items.length) return [];
  const weeks: { weekStart: string; days: number; summary: ExerciseSummary }[] = [];
  for (let start = mondayOf(from); start < today; start = addDays(start, 7)) {
    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      if (d >= from && d < today) days.push(d);
    }
    if (days.length) weeks.push({ weekStart: start, days: days.length, summary: exerciseSummary(days, logs, items) });
  }
  return weeks.slice(-MAX_WEEKS);
}

/** Drop null, empty strings and empty arrays/objects, so the evaluation reads compactly. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k, compact(v)] as const).filter(([, v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === "") return undefined;
  return value;
}

const fmtDob = (dob: string) => {
  const [y, m, d] = dob.split("-");
  return `${d}/${m}/${y}`;
};
const SEX: Record<string, string> = { female: "femenino", male: "masculino" };

function weekText(s: ExerciseSummary, days: number): string {
  const did = s.complete + s.partial;
  const parts = [
    `Ejercicios ${did} de ${days} ${days === 1 ? "día" : "días"} (${s.complete} ${s.complete === 1 ? "completo" : "completos"}, ` +
      `${s.partial} ${s.partial === 1 ? "parcial" : "parciales"}, ${s.none} sin hacer, ${s.noReply} sin respuesta).`,
    ...s.skipped.map((k) => `No hizo ${k.name} ${k.times} ${k.times === 1 ? "vez" : "veces"}.`),
    s.comments.length ? `Comentarios: ${s.comments.map((c) => `«${c}»`).join(" ")}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** The record, oldest first within each kind: patient, evaluation, notes, plans, weeks, logs. */
export function buildRecord(r: RecordData): RecordEntry[] {
  const out: RecordEntry[] = [];
  const p = r.patient;
  out.push({
    label: "paciente",
    text: [
      `${p.full_name}.`,
      p.diagnosis ? `Diagnóstico: ${p.diagnosis}.` : p.intake_reason ? `Motivo: ${p.intake_reason}.` : "",
      p.referring_doctor ? `Médico: ${p.referring_doctor}.` : "",
      p.dob ? `Nacimiento: ${fmtDob(p.dob)}.` : "",
      p.sex && SEX[p.sex] ? `Sexo: ${SEX[p.sex]}.` : "",
    ].filter(Boolean).join(" "),
  });

  if (r.evaluation) {
    const json = JSON.stringify(compact(r.evaluation.data) ?? {});
    out.push({ label: `valoración ${shortDate(r.evaluation.date)}`, text: json.length > EVAL_MAX ? `${json.slice(0, EVAL_MAX)}…` : json });
  }

  const notes = [...r.notes].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_NOTES).reverse();
  for (const n of notes) {
    out.push({ label: `nota ${shortDate(n.date)}`, text: [n.pain != null ? `Dolor ${n.pain}/10.` : "", n.text].filter(Boolean).join(" ") });
  }

  const plans = [...r.plans].sort((a, b) => a.start.localeCompare(b.start));
  for (const pl of plans) {
    const label = pl.end ? `plan ${shortDate(pl.start)}–${shortDate(pl.end)}` : `plan desde ${shortDate(pl.start)}`;
    out.push({ label, text: pl.lines.join("; ") || "Sin ejercicios ni actividades." });
  }

  // Adherence runs while there is a plan: through yesterday, or until the last plan ended
  // (a discharged patient shouldn't read as weeks of "sin respuesta").
  const from = plans[0]?.start ?? null;
  const active = plans.some((pl) => !pl.end);
  const lastEnd = plans.reduce<string | null>((m, pl) => (pl.end && (!m || pl.end > m) ? pl.end : m), null);
  const until = active || !lastEnd ? r.today : lastEnd < r.today ? lastEnd : r.today;
  for (const w of weeklyAdherence(r.exerciseLogs, r.items, from, until)) {
    out.push({ label: `semana del ${shortDate(w.weekStart)}`, text: weekText(w.summary, w.days) });
  }

  const acts = [...r.activities].sort((a, b) => b.logged_at.localeCompare(a.logged_at)).slice(0, MAX_ACTIVITIES).reverse();
  for (const a of acts) {
    const comment = a.comment?.trim() ? ` Comentario: ${a.comment.trim().slice(0, 200)}` : "";
    out.push({
      label: `registro ${shortDate(clinicDateOf(a.logged_at))}`,
      text: `${a.red_flag ? "⚠️ Alerta: " : ""}${describeActivity(a)}.${comment}`,
    });
  }
  return out;
}

/** "1. [nota 20 nov] …": what the model reads and what the guards check against. */
export function recordText(entries: RecordEntry[]): string {
  return entries.map((e, i) => `${i + 1}. [${e.label}] ${e.text}`).join("\n");
}
