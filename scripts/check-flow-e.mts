// Flow E pure-logic checks (no network, no DB). Run: npm run check
import {
  activityLines, exerciseSummary, groundedLine, groundedSuggestions, numbersIn, prepWindow,
} from "../lib/agents/therapist/prep-logic.ts";
import { factList, formatPrepBrief, noteText, shortDate, type PrepData } from "../lib/agents/therapist/prep-format.ts";
import { NEXT_OPTIONS, nextStepText } from "../lib/agents/therapist/next-step-format.ts";
import { PrepBriefSchema } from "../lib/ai/prep-schema.ts";
import { zodResponseFormat } from "openai/helpers/zod";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(pass ? "ok  " : "FAIL", label, pass ? "" : `got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- window
eq(prepWindow("2026-11-20", "2026-11-24").days, ["2026-11-21", "2026-11-22", "2026-11-23"], "window: days after the session through yesterday");
eq(prepWindow("2026-11-24", "2026-11-24").days, [], "window: session today → no days");
eq(prepWindow(null, "2026-11-24").days, [], "window: no session → no days");
eq(prepWindow("2026-11-30", "2026-12-02").days, ["2026-12-01"], "window: across a month end");

// ---------------------------------------------------------------- exercises
const items = [
  { id: "a", name: "Sentadilla en pared" },
  { id: "b", name: "Elevación de pierna recta" },
];
const days = ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"];
const logs = [
  { plan_item_id: "a", log_date: "2026-11-21", done: true, comment: null },
  { plan_item_id: "b", log_date: "2026-11-21", done: true, comment: null },
  { plan_item_id: "a", log_date: "2026-11-22", done: false, comment: null },
  { plan_item_id: "b", log_date: "2026-11-22", done: true, comment: "muy difícil la sentadilla" },
  { plan_item_id: "a", log_date: "2026-11-23", done: false, comment: null },
  { plan_item_id: "b", log_date: "2026-11-23", done: false, comment: null },
  { plan_item_id: "a", log_date: "2026-11-19", done: false, comment: null }, // before the window
  { plan_item_id: "zz", log_date: "2026-11-21", done: true, comment: null }, // an item of an older plan
];
const ex = exerciseSummary(days, logs, items);
eq([ex.complete, ex.partial, ex.none, ex.noReply], [1, 1, 1, 1], "exercises: complete / partial / none / no reply");
eq(ex.skipped, [
  { name: "Sentadilla en pared", times: 2, comment: null },
  { name: "Elevación de pierna recta", times: 1, comment: null },
], "exercises: skipped items, most skipped first");
eq(ex.comments, ["muy difícil la sentadilla"], "exercises: the patient's comments in the window");
eq(exerciseSummary([], logs, items).noReply, 0, "exercises: empty window");
eq(exerciseSummary(days, [], []).noReply, 4, "exercises: no plan, no logs → all days without reply");
eq(
  exerciseSummary(["2026-11-22"], [{ plan_item_id: "a", log_date: "2026-11-22", done: false, comment: "me dolió" }], items).skipped,
  [{ name: "Sentadilla en pared", times: 1, comment: "me dolió" }],
  "exercises: the patient's comment on a skipped day is kept",
);

// ---------------------------------------------------------------- activities
const acts = [
  { activity: "correr", duration_min: 25, pain_nprs: 5, pain_location: "frente de la rodilla", onset_min: 20, red_flag: false, comment: null, logged_at: "2026-11-23T01:00:00Z" },
  { activity: "subir escaleras", duration_min: null, pain_nprs: 2, pain_location: null, onset_min: null, red_flag: false, comment: null, logged_at: "2026-11-22T01:00:00Z" },
  { activity: "caminar", duration_min: 40, pain_nprs: 0, pain_location: null, onset_min: null, red_flag: false, comment: null, logged_at: "2026-11-21T01:00:00Z" },
  { activity: "bicicleta", duration_min: 30, pain_nprs: null, pain_location: null, onset_min: null, red_flag: false, comment: null, logged_at: "2026-11-20T23:00:00Z" },
  { activity: "correr", duration_min: 10, pain_nprs: 8, pain_location: "rodilla", onset_min: null, red_flag: true, comment: "la rodilla se inflamó y no puede apoyar", logged_at: "2026-11-21T03:00:00Z" },
];
const al = activityLines(acts);
eq(al.lines, [
  "correr 25 min, dolor 5/10 frente de la rodilla desde el min 20",
  "subir escaleras, dolor 2/10",
  "caminar 40 min, sin dolor",
], "activities: newest three, compact (red flags only in the alert)");
eq(al.more, 1, "activities: count beyond three");
eq(al.flags, ["correr 10 min, dolor 8/10 rodilla: la rodilla se inflamó y no puede apoyar"], "activities: red flags listed apart");
eq(activityLines([]).lines, [], "activities: none");

// ---------------------------------------------------------------- guards
eq(numbersIn("Flexión 115°, cuádriceps 4/5, dolor 3/10"), ["115", "4", "5", "3", "10"], "numbers: every number in a text");
const facts = "1. Última sesión: dolor 3/10. Flexión 115°.\n2. Sentadilla en pared: no la hizo 2 veces.";
eq(groundedLine("Flexión 115°, dolor 3/10.", facts), "Flexión 115°, dolor 3/10.", "guard: a line with known numbers stays");
eq(groundedLine("Flexión 120°.", facts), null, "guard: an invented number drops the line");
eq(groundedLine("   ", facts), null, "guard: an empty line is dropped");
eq(
  groundedSuggestions(
    [
      { focus: "Bajar la sentadilla en pared", facts: [2] },
      { focus: "Revisar marcha", facts: [] },
      { focus: "Repetir goniometría", facts: [7] },
      { focus: "Subir a 4 series", facts: [1] },
    ],
    2,
    facts,
  ),
  ["Bajar la sentadilla en pared"],
  "guard: suggestions need a valid fact and no invented numbers",
);

eq(groundedLine("Cuádriceps 3/5.", "1. Dolor 3/10. Cuádriceps 4/5."), null, "guard: a score must match a score in the facts, not just its digits");
eq(groundedLine("Dolor 4/10.", "1. Dolor 3/10. Cuádriceps 4/5."), null, "guard: pain must match the pain in the facts");
eq(groundedLine("Subir a quince minutos.", "1. Correr 25 min."), null, "guard: numbers written as words are dropped");
eq(groundedLine("Volver a 20 nov.", "1. Última nota (20 nov): dolor 3/10."), null, "guard: the date's day is not an allowed number");
eq(groundedLine("Revisar dolor al correr más de 20 minutos.", "1. Actividad: correr 25 min, dolor 5/10 desde el min 20"), "Revisar dolor al correr más de 20 minutos.", "guard: a plain number in the facts stays");
eq(groundedLine("Mantener 3×10.", "1. Plan: Sentadilla en pared 3×10, diario"), "Mantener 3×10.", "guard: sets × reps that match stay");
eq(groundedLine("Subir a 4×10.", "1. Plan: Sentadilla en pared 3×10, diario. 2. 4 días"), null, "guard: changed sets × reps are dropped");

// ---------------------------------------------------------------- the brief
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
eq(shortDate("2026-11-20"), "20 nov", "date: short");
eq(
  noteText({
    subjective: "Refiere menos dolor al subir escaleras.",
    objective: { rom: [{ joint: "rodilla", movement: "flexión", degrees: 115 }], strength: [{ muscle: "cuádriceps", grade_0_5: 4 }], special_tests: [], treatment_given: ["TENS"] },
    assessment: "Mejora de arcos.",
    plan_text: "2 visitas/semana. Próxima sesión: fuerza de cuádriceps.\nPlan en casa:\n1. Sentadilla en pared 3×10, diario",
  }),
  "S: Refiere menos dolor al subir escaleras. O: rodilla flexión 115°; cuádriceps 4/5; tratamiento: TENS. A: Mejora de arcos. P: 2 visitas/semana. Próxima sesión: fuerza de cuádriceps. Plan en casa: 1. Sentadilla en pared 3×10, diario",
  "note text: the last note in one line for the AI",
);

const full: PrepData = {
  patientName: "Laura Méndez Ruiz",
  diagnosis: "Síndrome patelofemoral derecho",
  intakeReason: null,
  lastSession: {
    date: "2026-11-20",
    pain: 3,
    text: "S: Menos dolor. O: rodilla flexión 115°; cuádriceps 4/5. A: Mejora. P: Próxima sesión: fuerza de cuádriceps.",
    headline: "Próxima sesión: fuerza de cuádriceps.",
  },
  evaluationDate: "2026-11-10",
  planLines: ["Sentadilla en pared 3×10, diario", "Elevación de pierna recta 3×12, diario"],
  days: 4,
  exercises: { complete: 2, partial: 1, none: 0, noReply: 1, skipped: [{ name: "Sentadilla en pared", times: 2, comment: "muy difícil" }], comments: ["muy difícil", "me sentí bien"] },
  activities: { lines: ["correr 25 min, dolor 5/10 frente de la rodilla desde el min 20"], more: 0, flags: [] },
};
const brief = formatPrepBrief(full, {
  lastSession: "flexión de rodilla 115°, cuádriceps 4/5; se acordó trabajar fuerza de cuádriceps.",
  suggestions: ["revalorar fuerza de cuádriceps", "bajar la sentadilla en pared", "hablar del volumen de carrera"],
});
eq(brief.split("\n"), [
  "📋 *Laura Méndez Ruiz · preparar sesión*",
  "",
  "*Última sesión (20 nov):* dolor 3/10; flexión de rodilla 115°, cuádriceps 4/5; se acordó trabajar fuerza de cuádriceps.",
  "*Desde entonces (4 días):* ejercicios 3 de 4 días (2 completos, 1 parcial); 1 sin respuesta. Sentadilla en pared: no la hizo 2 veces («muy difícil»). Comentó: «me sentí bien».",
  "*Actividad:* correr 25 min, dolor 5/10 frente de la rodilla desde el min 20.",
  "*Sugerencia para hoy:* revalorar fuerza de cuádriceps; bajar la sentadilla en pared; hablar del volumen de carrera.",
], "brief: the spec's layout");
eq(words(brief) <= 120, true, `brief: under 120 words (${words(brief)})`);

const capitals = formatPrepBrief(full, { lastSession: null, suggestions: ["Revalorar fuerza", "TENS si hay dolor", "Bajar la sentadilla."] });
eq(capitals.includes("*Sugerencia para hoy:* revalorar fuerza; TENS si hay dolor; bajar la sentadilla."), true, "brief: suggestions read as one sentence (acronyms kept)");

const acronym = formatPrepBrief(full, { lastSession: "ROM de rodilla 115°.", suggestions: [] });
eq(acronym.includes("dolor 3/10; ROM de rodilla 115°."), true, "brief: an acronym after the pain keeps its capitals");

const longText = "la rodilla se inflamó mucho después de correr y ahora no puede apoyar el pie, le duele al caminar y al subir escaleras y siente que se le va ".repeat(8);
const worst = formatPrepBrief(
  {
    ...full,
    patientName: "María Fernanda de los Ángeles Gutiérrez Hernández",
    lastSession: { ...full.lastSession!, headline: longText },
    exercises: { complete: 2, partial: 1, none: 0, noReply: 1, skipped: [{ name: longText, times: 2, comment: longText }, { name: longText, times: 1, comment: longText }], comments: [longText + "x"] },
    activities: {
      lines: [longText, longText, longText],
      more: 9,
      flags: [longText, longText + "a", longText + "b", longText + "c"],
    },
  },
  { lastSession: longText, suggestions: [longText, longText, longText] },
);
const optionLines = NEXT_OPTIONS.after_prep.map((o, i) => `${i + 1}. ${o.icon} ${o.title}`);
const sent = [nextStepText("after_prep", worst, "María Fernanda de los Ángeles Gutiérrez Hernández"), "", ...optionLines].join(String.fromCharCode(10));
eq(sent.length <= 1600, true, `brief: the longest brief and its options fit one WhatsApp message (${sent.length})`);
eq(worst.includes("(+2 más)") && (worst.match(/⚠️/g) ?? []).length === 1, true, "brief: two alerts shown, the rest counted");

const noAi = formatPrepBrief(full, { lastSession: null, suggestions: [] });
eq(noAi.includes("*Última sesión (20 nov):* dolor 3/10. Próxima sesión: fuerza de cuádriceps."), true, "brief without AI: last session falls back to pain and the agreed focus");
eq(noAi.includes("Sugerencia"), false, "brief without AI: no suggestion line");

const flagged = formatPrepBrief(
  { ...full, activities: { lines: ["correr 10 min, dolor 8/10 rodilla"], more: 2, flags: ["correr 10 min, dolor 8/10 rodilla: se inflamó"] } },
  { lastSession: null, suggestions: [] },
);
eq(flagged.includes("*Actividad:* correr 10 min, dolor 8/10 rodilla (+2 más)."), true, "brief: activities beyond three are counted");
eq(flagged.includes("⚠️ *Alerta:* correr 10 min, dolor 8/10 rodilla: se inflamó."), true, "brief: red flags get their own line");

const sameDay = formatPrepBrief({ ...full, days: 0, exercises: null, activities: { lines: [], more: 0, flags: [] } }, { lastSession: null, suggestions: [] });
eq(sameDay.includes("*Desde entonces:* aún no hay un día completo desde la última sesión."), true, "brief: last session today or yesterday");
eq(sameDay.includes("*Actividad:*"), false, "brief: no activity line when the window is empty and nothing was logged");

const noPlan = formatPrepBrief({ ...full, planLines: [], exercises: null, activities: { lines: [], more: 0, flags: [] } }, { lastSession: null, suggestions: [] });
eq(noPlan.includes("*Desde entonces (4 días):* sin plan de casa. Sin actividades registradas."), true, "brief: no plan and no logs");

const fresh = formatPrepBrief(
  { ...full, diagnosis: null, intakeReason: "rodilla derecha", lastSession: null, evaluationDate: null, planLines: [], days: 0, exercises: null, activities: { lines: [], more: 0, flags: [] } },
  { lastSession: null, suggestions: ["hacer la valoración inicial"] },
);
eq(fresh.split("\n"), [
  "📋 *Laura Méndez Ruiz · preparar sesión*",
  "",
  "*Motivo:* rodilla derecha",
  "*Última sesión:* ninguna todavía. Sin valoración inicial.",
  "*Sugerencia para hoy:* hacer la valoración inicial.",
], "brief: a patient with no notes yet");

const prepFacts = factList(full);
eq(prepFacts[0].startsWith("Última nota (20 nov): S: Menos dolor."), true, "facts: the last note first");
eq(prepFacts.includes("Dolor en la última sesión: 3/10"), true, "facts: pain");
eq(prepFacts.includes("Ejercicios desde la última sesión (4 días): 3 de 4 días (2 completos, 1 parcial, 0 sin hacer, 1 sin respuesta)"), true, "facts: adherence");
eq(prepFacts.includes("No hizo Sentadilla en pared 2 veces (comentario: muy difícil)"), true, "facts: skipped exercise");
eq(prepFacts.includes("Actividad: correr 25 min, dolor 5/10 frente de la rodilla desde el min 20"), true, "facts: activity");
eq(prepFacts.includes("Plan de casa actual: Sentadilla en pared 3×10, diario; Elevación de pierna recta 3×12, diario"), true, "facts: plan");
eq(prepFacts.includes("Diagnóstico: Síndrome patelofemoral derecho"), true, "facts: diagnosis");

// ---------------------------------------------------------------- next step and schema
eq(NEXT_OPTIONS.after_prep.map((o) => `${o.icon} ${o.title}`), ["📝 Nota de esta sesión", "📋 Preparar otra", "🏠 Menú principal", "✅ Es todo"], "next step after prep");
eq(nextStepText("after_prep", "brief", "Laura Méndez Ruiz"), "brief\n\n¿Algo más con *Laura Méndez Ruiz*?", "next step names the patient");
let schemaOk = true;
try { zodResponseFormat(PrepBriefSchema, "prep_brief"); } catch { schemaOk = false; }
eq(schemaOk, true, "AI schema is valid for Structured Outputs");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nflow E: all checks passed");
