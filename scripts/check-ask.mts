// "Ask about a patient" pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { AskAnswerSchema } from "../lib/ai/ask-schema.ts";
import { ASK_OPTIONS, askIntro, formatAnswer, groundedStatements, isQuestion } from "../lib/agents/therapist/ask-format.ts";
import { buildRecord, recordText, weeklyAdherence, type RecordData } from "../lib/agents/therapist/record-format.ts";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(pass ? "ok  " : "FAIL", label, pass ? "" : `got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- weekly adherence
const items = [
  { id: "a", name: "Sentadilla en pared" },
  { id: "b", name: "Elevación de pierna recta" },
];
const logs = [
  { plan_item_id: "a", log_date: "2026-11-17", done: true, comment: null }, // Tue (weeks start Mon 16)
  { plan_item_id: "b", log_date: "2026-11-17", done: true, comment: null },
  { plan_item_id: "a", log_date: "2026-11-18", done: false, comment: null },
  { plan_item_id: "b", log_date: "2026-11-18", done: true, comment: "me costó" },
  { plan_item_id: "a", log_date: "2026-11-24", done: true, comment: null }, // next week
];
eq(
  weeklyAdherence(logs, items, "2026-11-17", "2026-11-25").map((w) => [w.weekStart, w.days, w.summary.complete, w.summary.partial, w.summary.noReply]),
  [["2026-11-16", 6, 1, 1, 4], ["2026-11-23", 2, 1, 0, 1]],
  "weeks: Monday start, from the plan start to yesterday",
);
eq(weeklyAdherence(logs, items, "2026-11-19", "2026-11-25")[0].days, 4, "weeks: the first week starts at the plan start");
eq(weeklyAdherence([], [], null, "2026-11-25"), [], "weeks: no plan");
eq(weeklyAdherence([], items, "2026-06-01", "2026-12-31").length, 12, "weeks: at most the last 12");

// ---------------------------------------------------------------- record
const data: RecordData = {
  today: "2026-11-26",
  patient: { full_name: "Laura Méndez Ruiz", diagnosis: "Síndrome patelofemoral derecho", intake_reason: null, referring_doctor: "Dr. Ruiz", dob: "1991-03-14", sex: "female" },
  evaluation: { date: "2026-11-03", data: { diagnosis: { physio: "Síndrome patelofemoral" }, pain: { nprs: 6, location: null }, empty: [], form_region: "lower_limb" } },
  notes: [
    { date: "2026-11-20", pain: 3, text: "S: Menos dolor. O: rodilla flexión 115°." },
    { date: "2026-11-06", pain: 5, text: "S: Dolor al subir escaleras. O: rodilla flexión 95°." },
  ],
  plans: [
    { start: "2026-11-20", end: null, lines: ["Sentadilla en pared 3×10, diario"] },
    { start: "2026-11-06", end: "2026-11-20", lines: ["Sentadilla en pared 3×8, diario"] },
  ],
  exerciseLogs: logs,
  items,
  activities: [
    { activity: "correr", duration_min: 25, pain_nprs: 5, pain_location: "rodilla", onset_min: 20, red_flag: false, comment: null, logged_at: "2026-11-18T19:00:00-06:00" },
    { activity: "correr", duration_min: 10, pain_nprs: 8, pain_location: "rodilla", onset_min: null, red_flag: true, comment: "se inflamó", logged_at: "2026-11-23T19:00:00-06:00" },
  ],
};
const entries = buildRecord(data);
eq(entries.map((e) => e.label), [
  "paciente",
  "valoración 3 nov",
  "nota 6 nov",
  "nota 20 nov",
  "plan 6 nov–20 nov",
  "plan desde 20 nov",
  "semana del 2 nov",
  "semana del 9 nov",
  "semana del 16 nov",
  "semana del 23 nov",
  "registro 18 nov",
  "registro 23 nov",
], "record: patient, evaluation, notes, plans, weeks, logs, oldest first");
eq(entries[0].text, "Laura Méndez Ruiz. Diagnóstico: Síndrome patelofemoral derecho. Médico: Dr. Ruiz. Nacimiento: 14/03/1991. Sexo: femenino.", "record: patient entry");
eq(entries[1].text.includes('"nprs":6') && !entries[1].text.includes("empty") && !entries[1].text.includes("null"), true, "record: evaluation without empty fields");
eq(entries[3].text, "Dolor 3/10. S: Menos dolor. O: rodilla flexión 115°.", "record: note with its pain");
eq(entries[5].text, "Sentadilla en pared 3×10, diario", "record: plan lines");
eq(entries[11].text, "⚠️ Alerta: correr 10 min, dolor 8/10 rodilla. Comentario: se inflamó", "record: red flag log");
eq(entries[8].text.startsWith("Ejercicios 2 de 7 días"), true, `record: weekly adherence text (${entries[8].text})`);
eq(recordText(entries.slice(2, 4)), "1. [nota 6 nov] Dolor 5/10. S: Dolor al subir escaleras. O: rodilla flexión 95°.\n2. [nota 20 nov] Dolor 3/10. S: Menos dolor. O: rodilla flexión 115°.", "record: numbered text for the model");

const many: RecordData = {
  ...data,
  notes: Array.from({ length: 40 }, (_, i) => ({ date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, pain: 2, text: `nota ${i}` })),
  activities: Array.from({ length: 300 }, (_, i) => ({ ...data.activities[0], logged_at: `2026-11-${String((i % 25) + 1).padStart(2, "0")}T10:${String(i % 60).padStart(2, "0")}:00-06:00` })),
};
const big = buildRecord(many);
eq([big.filter((e) => e.label.startsWith("nota")).length, big.filter((e) => e.label.startsWith("registro")).length], [25, 60], "record: newest 25 notes and 60 logs");
eq(buildRecord({ ...data, evaluation: null, notes: [], plans: [], exerciseLogs: [], items: [], activities: [] }).map((e) => e.label), ["paciente"], "record: a new patient");

// ---------------------------------------------------------------- answers
const small = buildRecord({ ...data, evaluation: null, plans: [], exerciseLogs: [], items: [], activities: [] });
// 1 paciente, 2 nota 6 nov, 3 nota 20 nov
const kept = groundedStatements(
  [
    { text: "La flexión pasó de 95° a 115°.", sources: [2, 3] },
    { text: "La flexión fue 120°.", sources: [3] },
    { text: "El dolor bajó de 5/10 a 3/10.", sources: [3] }, // 5/10 is only in entry 2
    { text: "Tiene diagnóstico de síndrome patelofemoral.", sources: [9] },
    { text: "Sin fuente.", sources: [] },
    { text: "Mejoró desde el 6 nov.", sources: [2] },
  ],
  small,
);
eq(kept, [
  { text: "La flexión pasó de 95° a 115°.", sources: ["nota 6 nov", "nota 20 nov"] },
  { text: "Mejoró desde el 6 nov.", sources: ["nota 6 nov"] },
], "answers: only statements whose numbers are in the cited entries, sources from labels");

const answer = formatAnswer(kept, "si hoy tolera la sentadilla sin dolor, progresar a 4 series");
eq(answer.split("\n"), [
  "📂 *Según el expediente:*",
  "• La flexión pasó de 95° a 115°. (nota 6 nov; nota 20 nov)",
  "• Mejoró desde el 6 nov. (nota 6 nov)",
  "",
  "💡 *Sugerencia de la IA (no es del expediente):* si hoy tolera la sentadilla sin dolor, progresar a 4 series.",
], "answers: record and suggestion apart");
eq(formatAnswer([], null), "📂 No lo encuentro en el expediente.", "answers: nothing grounded");
eq(formatAnswer([], "Revisar la marcha.").includes("📂 No lo encuentro en el expediente.\n\n💡 *Sugerencia de la IA (no es del expediente):* revisar la marcha."), true, "answers: a suggestion alone still says the record has nothing");

const long = "texto muy largo del expediente ".repeat(40);
const huge = formatAnswer(Array.from({ length: 10 }, () => ({ text: long, sources: ["nota 20 nov", "nota 6 nov", "registro 18 nov"] })), long);
const withOptions = [huge, "", "Escribe o di otra pregunta, o:", ...ASK_OPTIONS.map((o, i) => `${i + 1}. ${o.icon} ${o.title}`)].join("\n");
eq(withOptions.length <= 1600, true, `answers: the longest answer and options fit one message (${withOptions.length})`);

eq(askIntro("Laura Méndez Ruiz"), "💬 Pregúntame lo que quieras sobre *Laura Méndez Ruiz*: sesiones, plan, dolor, ejercicios… por texto o nota de voz.", "intro");
eq(ASK_OPTIONS.map((o) => `${o.icon} ${o.title}`), ["📝 Nota de esta sesión", "🏠 Menú principal"], "options while asking");

eq([isQuestion("¿desde cuándo le duele?"), isQuestion("cómo iba la flexión al principio"), isQuestion("hola"), isQuestion("ok"), isQuestion("gracias")], [true, true, false, false, false], "a typed question vs a greeting or a word");

let schemaOk = true;
try { zodResponseFormat(AskAnswerSchema, "ask_answer"); } catch { schemaOk = false; }
eq(schemaOk, true, "AI schema is valid for Structured Outputs");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nask: all checks passed");
