// Flow E messages (pure): the session brief and the numbered facts the AI is given.
// No runtime "@/" imports so scripts/check-flow-e.mts can test it.

import type { SoapObjective } from "../../db/types";
import type { ExerciseSummary } from "./prep-logic";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-20" → "20 nov". */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Everything the brief needs, already computed from confirmed rows and patient logs. */
export interface PrepData {
  patientName: string;
  diagnosis: string | null;
  intakeReason: string | null;
  lastSession: {
    date: string; // clinic date
    pain: number | null;
    text: string; // the whole note in one line (noteText), for the AI
    headline: string | null; // "2 visitas/semana. Próxima sesión: …" from the note's plan
  } | null;
  evaluationDate: string | null; // newest confirmed initial evaluation
  planLines: string[]; // active plan, describePlanItem each
  days: number; // full days since the last session (prepWindow)
  exercises: ExerciseSummary | null; // null when the active plan has no exercises
  activities: { lines: string[]; more: number; flags: string[] };
}

/** The AI's part, after the guards: null / [] when absent or dropped. */
export interface PrepAi {
  lastSession: string | null;
  suggestions: string[];
}

/** A confirmed note in one line: "S: … O: … A: … P: …". */
export function noteText(s: {
  subjective: string | null;
  objective: SoapObjective | null;
  assessment: string | null;
  plan_text: string | null;
}): string {
  const o = s.objective;
  const objective = o
    ? [
        ...o.rom.map((r) => `${r.joint} ${r.movement} ${r.degrees}°`),
        ...o.strength.map((m) => `${m.muscle} ${m.grade_0_5}/5`),
        ...o.special_tests,
        o.treatment_given.length ? `tratamiento: ${o.treatment_given.join(", ")}` : "",
      ].filter(Boolean).join("; ")
    : "";
  const oneLine = (t: string | null) => (t ?? "").replace(/\s*\n\s*/g, " ").trim();
  return [
    oneLine(s.subjective) && `S: ${oneLine(s.subjective)}`,
    objective && `O: ${objective}.`,
    oneLine(s.assessment) && `A: ${oneLine(s.assessment)}`,
    oneLine(s.plan_text) && `P: ${oneLine(s.plan_text)}`,
  ].filter(Boolean).join(" ");
}

/** The first line of a note's plan_text when it is the headline (not the home-plan list). */
export function planHeadlineOf(planText: string | null): string | null {
  const first = planText?.split("\n")[0]?.trim();
  return first && !/^plan en casa|^sin cambios/i.test(first) ? first : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sentence = (t: string) => {
  const s = t.trim().replace(/[.;\s]+$/, "");
  return s ? `${s}.` : "";
};
const clip = (t: string, max = 100) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

function adherence(x: ExerciseSummary, days: number): { line: string; extra: string[] } {
  const did = x.complete + x.partial;
  const kinds = [
    x.complete ? plural(x.complete, "completo", "completos") : "",
    x.partial ? plural(x.partial, "parcial", "parciales") : "",
  ].filter(Boolean);
  const extra = [x.none ? `${x.none} sin hacer` : "", x.noReply ? `${x.noReply} sin respuesta` : ""].filter(Boolean);
  const line = `ejercicios ${did} de ${plural(days, "día", "días")}${kinds.length ? ` (${kinds.join(", ")})` : ""}`;
  return { line, extra };
}

/** The brief: one message, facts rendered by code, the AI's lines only where given. */
export function formatPrepBrief(d: PrepData, ai: PrepAi): string {
  const lines = [`📋 *${d.patientName} · preparar sesión*`, ""];

  if (!d.lastSession) {
    if (d.diagnosis) lines.push(`*Diagnóstico:* ${d.diagnosis}`);
    else if (d.intakeReason) lines.push(`*Motivo:* ${d.intakeReason}`);
    const evaluation = d.evaluationDate ? `Valoración inicial: ${shortDate(d.evaluationDate)}.` : "Sin valoración inicial.";
    lines.push(`*Última sesión:* ninguna todavía. ${evaluation}`);
  } else {
    const s = d.lastSession;
    const pain = s.pain != null ? `dolor ${s.pain}/10` : "";
    const body = ai.lastSession
      ? sentence([pain, ai.lastSession.replace(/^[A-ZÁÉÍÓÚÑ]/, (c) => (pain ? c.toLowerCase() : c))].filter(Boolean).join("; "))
      : [pain && `${pain}.`, s.headline ? sentence(s.headline) : ""].filter(Boolean).join(" ") || "sin dolor ni plan registrados.";
    lines.push(`*Última sesión (${shortDate(s.date)}):* ${body}`);

    if (d.days === 0) {
      lines.push("*Desde entonces:* aún no hay un día completo desde la última sesión.");
    } else {
      const parts: string[] = [];
      if (!d.planLines.length) parts.push("sin plan de casa.");
      else if (!d.exercises) parts.push("sin ejercicios en el plan de casa.");
      else {
        const { line, extra } = adherence(d.exercises, d.days);
        parts.push(`${line}${extra.length ? `; ${extra.join(", ")}` : ""}.`);
        for (const sk of d.exercises.skipped.slice(0, 2)) {
          const comment = sk.comment ? ` («${clip(sk.comment, 60)}»)` : "";
          parts.push(`${sk.name}: no la hizo ${plural(sk.times, "vez", "veces")}${comment}.`);
        }
        const shown = new Set(d.exercises.skipped.slice(0, 2).map((sk) => sk.comment));
        const other = d.exercises.comments.find((c) => !shown.has(c));
        if (other) parts.push(`Comentó: «${clip(other)}».`);
      }
      if (!d.activities.lines.length) parts.push("Sin actividades registradas.");
      lines.push(`*Desde entonces (${plural(d.days, "día", "días")}):* ${parts.join(" ")}`);
    }
  }

  if (d.activities.lines.length) {
    const more = d.activities.more ? ` (+${d.activities.more} más)` : "";
    lines.push(`*Actividad:* ${d.activities.lines.join("; ")}${more}.`);
  }
  if (d.activities.flags.length) lines.push(`⚠️ *Alerta:* ${sentence(d.activities.flags.join("; "))}`);
  if (ai.suggestions.length) {
    // One sentence: "revalorar …; bajar …". Lowercase a leading capital unless it starts an acronym (TENS).
    const items = ai.suggestions.map((s) => s.trim().replace(/[.;]+$/, "").replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase()));
    lines.push(`*Sugerencia para hoy:* ${sentence(items.join("; "))}`);
  }
  return lines.join("\n");
}

/** The facts the AI may use, one per entry (numbered 1… when sent). */
export function factList(d: PrepData): string[] {
  const f: string[] = [];
  if (d.lastSession) {
    f.push(`Última nota (${shortDate(d.lastSession.date)}): ${d.lastSession.text}`);
    if (d.lastSession.pain != null) f.push(`Dolor en la última sesión: ${d.lastSession.pain}/10`);
  } else {
    f.push("Sin notas de sesión todavía");
  }
  f.push(d.evaluationDate ? `Valoración inicial: ${shortDate(d.evaluationDate)}` : "Sin valoración inicial");
  if (d.diagnosis) f.push(`Diagnóstico: ${d.diagnosis}`);
  else if (d.intakeReason) f.push(`Motivo de consulta: ${d.intakeReason}`);
  f.push(d.planLines.length ? `Plan de casa actual: ${d.planLines.join("; ")}` : "Sin plan de casa");

  const x = d.exercises;
  if (x && d.days > 0) {
    f.push(
      `Ejercicios desde la última sesión (${plural(d.days, "día", "días")}): ${x.complete + x.partial} de ${plural(d.days, "día", "días")} ` +
        `(${x.complete} completos, ${x.partial} parcial${x.partial === 1 ? "" : "es"}, ${x.none} sin hacer, ${x.noReply} sin respuesta)`,
    );
    for (const sk of x.skipped) {
      f.push(`No hizo ${sk.name} ${plural(sk.times, "vez", "veces")}${sk.comment ? ` (comentario: ${sk.comment})` : ""}`);
    }
    for (const c of x.comments) if (!x.skipped.some((sk) => sk.comment === c)) f.push(`Comentario del paciente: ${c}`);
  }
  for (const a of d.activities.lines) f.push(`Actividad: ${a}`);
  if (d.activities.more) f.push(`Otras ${d.activities.more} actividades registradas`);
  for (const a of d.activities.flags) f.push(`Alerta: ${a}`);
  return f;
}
