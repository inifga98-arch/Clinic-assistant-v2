// Flow B pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { SoapExtraction, SoapRevision } from "../lib/ai/soap-schema.ts";
import {
  QUESTIONS, cleanExtraction, describePlanItem, isConfirmWord, lateNotes, planHeadline, isDoneWord, isSkipWord, mergeRevision, missingItems, nextQuestion, parsePainAnswer, toNoteColumns,
  toPlanItems, type NoteDraft,
} from "../lib/agents/therapist/note-draft.ts";
import { MAX_MESSAGE, SOAP_GUIDE, formatAck, formatReview, formatCorrectionAck } from "../lib/agents/therapist/note-format.ts";
import { formatOptions } from "../lib/whatsapp/options.ts";
import { looksLikeName, matchPatients, namesInText, patientLabel, type PatientRef } from "../lib/agents/therapist/patient-match.ts";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(pass ? "ok  " : "FAIL", label, pass ? "" : `got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- shared sample
const sampleNote: SoapExtraction = {
  subjective: { summary: "Dolor 3/10", pain_nprs: 3, aggravating: [], functional_limits: [] },
  objective: { rom: [], strength: [], special_tests: [], treatment_given: ["Terapia manual"] },
  assessment: "Progresa",
  plan: {
    visits_per_week: 2,
    next_session_focus: null,
    keep_current_plan: false,
    home_exercises: [
      {
        name: "Elevación de pierna recta",
        sets: 3,
        reps: 12,
        hold_seconds: null,
        frequency_per_week: 7,
        days_of_week: null,
        instructions: null,
      },
    ],
    activities: [],
  },
};

// ---------------------------------------------------------------- Task 1: schema
eq(SoapExtraction.safeParse(sampleNote).success, true, "schema: note with keep_current_plan parses");
eq(
  SoapExtraction.safeParse({ ...sampleNote, plan: { ...sampleNote.plan, keep_current_plan: undefined } }).success,
  false,
  "schema: keep_current_plan required",
);
eq(SoapRevision.safeParse({ note: sampleNote, changed: ["subjective.pain_nprs"] }).success, true, "schema: revision parses");
eq(zodResponseFormat(SoapRevision, "soap_revision").type, "json_schema", "schema: revision converts to response format");

// ---------------------------------------------------------------- Task 2: draft logic
eq(missingItems(sampleNote), [], "missing: complete note");
const bare: SoapExtraction = {
  ...sampleNote,
  subjective: { ...sampleNote.subjective, pain_nprs: null },
  assessment: "",
  plan: { ...sampleNote.plan, home_exercises: [], activities: [], keep_current_plan: false },
};
eq(missingItems(bare), ["pain_nprs", "assessment", "plan"], "missing: order is S, pain, O, A, P");
eq(missingItems({ ...bare, plan: { ...bare.plan, keep_current_plan: true } }), ["pain_nprs", "assessment"],
  "missing: 'sin cambios' counts as a plan");
eq(missingItems({ ...bare, subjective: { ...bare.subjective, summary: " " },
  objective: { rom: [], strength: [], special_tests: [], treatment_given: [] } }),
  ["subjective", "pain_nprs", "objective", "assessment", "plan"], "missing: all five");
const d: NoteDraft = { transcripts: [], extraction: bare, questions_asked: 0, skipped: [], asking: null, step: "asking" };
eq(nextQuestion(d), "pain_nprs", "question: first gap");
eq(nextQuestion({ ...d, skipped: ["pain_nprs"] }), "assessment", "question: skipped gap passed over");
eq(nextQuestion({ ...d, questions_asked: 3 }), null, "question: max three");
eq(nextQuestion({ ...d, extraction: sampleNote }), null, "question: none when complete");
eq(QUESTIONS.pain_nprs, "¿Qué dolor reportó hoy, del 0 al 10?", "question: pain copy");
for (const t of ["listo", "Listo.", "eso es todo", "ya es todo", "terminé"]) eq(isDoneWord(t), true, `done: ${t}`);
for (const t of ["listo para correr el sábado", "la rodilla está lista"]) eq(isDoneWord(t), false, `not done: ${t}`);
eq(isSkipWord("omitir"), true, "skip: omitir");
eq(isSkipWord("Omitir."), true, "skip: case and punctuation");
eq(isSkipWord("dolor 3"), false, "skip: not an answer");
eq(parsePainAnswer("3"), 3, "pain: bare number");
eq(parsePainAnswer("3/10"), 3, "pain: x/10");
eq(parsePainAnswer("0"), 0, "pain: zero");
eq(parsePainAnswer("11"), null, "pain: out of range");
eq(parsePainAnswer("como 3 o 4"), null, "pain: not bare -> model handles it");
const fixed = { ...sampleNote, subjective: { ...sampleNote.subjective, pain_nprs: 5, summary: "REESCRITO" } };
eq(mergeRevision(sampleNote, fixed, ["subjective.pain_nprs"]).note.subjective,
  { ...sampleNote.subjective, pain_nprs: 5 }, "merge: undeclared change reverted");
eq(mergeRevision(sampleNote, fixed, ["subjective.pain_nprs"]).applied, true, "merge: declared change applied");
eq(mergeRevision(sampleNote, sampleNote, ["subjective.pain_nprs"]).applied, false, "merge: nothing changed -> not applied");
eq(mergeRevision(sampleNote, fixed, []).note, sampleNote, "merge: nothing declared -> nothing changes");
eq(mergeRevision(sampleNote, fixed, ["subjective"]).note.subjective.summary, "REESCRITO", "merge: a section covers its fields");
const twoEx: SoapExtraction = { ...sampleNote, plan: { ...sampleNote.plan, home_exercises: [sampleNote.plan.home_exercises[0],
  { ...sampleNote.plan.home_exercises[0], name: "Sentadilla en pared" }] } };
const removed: SoapExtraction = { ...twoEx, plan: { ...twoEx.plan, home_exercises: [twoEx.plan.home_exercises[0]] } };
eq(mergeRevision(twoEx, removed, ["plan.home_exercises[1]"]).note.plan.home_exercises.map((e) => e.name),
  ["Elevación de pierna recta"], "merge: removing one item keeps the others");
const renamedFirst: SoapExtraction = { ...removed, plan: { ...removed.plan, home_exercises: [{ ...removed.plan.home_exercises[0], name: "OTRO" }] } };
eq(mergeRevision(twoEx, renamedFirst, ["plan.home_exercises[1]"]).note.plan.home_exercises.map((e) => e.name),
  ["Elevación de pierna recta"], "merge: undeclared rename of a kept item reverted");
const added: SoapExtraction = { ...sampleNote, plan: { ...sampleNote.plan, home_exercises: [...sampleNote.plan.home_exercises,
  { ...sampleNote.plan.home_exercises[0], name: "Puente" }] } };
eq(mergeRevision(sampleNote, added, ["plan.home_exercises[1]"]).note.plan.home_exercises.length, 2, "merge: adding an item");
eq(mergeRevision(sampleNote, added, ["assessment"]).note.plan.home_exercises.length, 1, "merge: undeclared new item dropped");
eq(toPlanItems({ ...sampleNote, plan: { ...sampleNote.plan, activities: [{ name: "Correr", target: "20 min",
  frequency_per_week: 2, report: ["pain_nprs"], days_of_week: null, instructions: null }] } })[1],
  { type: "activity", name: "Correr", sets: null, reps: null, hold_seconds: null, frequency_per_week: 2,
    days_of_week: null, instructions: "20 min; reportar dolor" }, "plan items: activity target into instructions");
eq(toPlanItems({ ...sampleNote, plan: { ...sampleNote.plan, home_exercises: [{ ...sampleNote.plan.home_exercises[0],
  frequency_per_week: 21 }] } })[0].frequency_per_week, null, "plan items: frequency outside 1-14 -> null");
eq(toPlanItems({ ...sampleNote, plan: { ...sampleNote.plan, keep_current_plan: true } }), [], "plan items: none when keeping the plan");
const cols = toNoteColumns(bare, ["pain_nprs"], [{ text: "a", audio_url: null, received_at: "2026-11-23T10:00:00Z" },
  { text: "b", audio_url: "u2", received_at: "2026-11-23T10:05:00Z" }]);
eq(cols.source_transcript, ["a", "b"].join("\n\n"), "columns: transcripts joined in order");
eq(cols.source_audio_url, "u2", "columns: first audio url");
eq(cols.missing_fields, ["pain_nprs"], "columns: missing fields");
eq(cols.pain_nprs, null, "columns: pain");

// ---------------------------------------------------------------- Task 3: review formatting
const review = formatReview({ patientName: "Ana López", date: "2026-11-23", note: sampleNote, missing: [], hasActivePlan: true });
eq(review.length, 1, "review: short note is one message");
eq(review[0].startsWith("*Ana López* · 23 nov 2026"), true, "review: header with es-MX date");
eq(review[0].includes("Plan en casa (reemplaza el actual):" + "\n" + " 1. Elevación de pierna recta 3×12, diario"), true, "review: plan list");
eq(formatReview({ patientName: "Ana López", date: "2026-11-23", note: sampleNote, missing: [], hasActivePlan: false })[0]
  .includes("Plan en casa (nuevo):"), true, "review: new plan header when none active");
const keep: SoapExtraction = { ...sampleNote, plan: { ...sampleNote.plan, home_exercises: [], keep_current_plan: true } };
eq(formatReview({ patientName: "Ana López", date: "2026-11-23", note: keep, missing: [], hasActivePlan: false })[0]
  .includes("Plan en casa: sin cambios (no hay plan activo)"), true, "review: no changes, no active plan");
eq(formatReview({ patientName: "Ana López", date: "2026-11-23", note: keep, missing: [], hasActivePlan: true })[0]
  .includes("Plan en casa: sin cambios"), true, "review: no changes, keeps active plan");
eq(formatReview({ patientName: "Ana López", date: "2026-11-23", note: sampleNote, missing: ["pain_nprs"], hasActivePlan: true })[0]
  .includes("Falta: escala de dolor"), true, "review: gaps listed");
const long: SoapExtraction = { ...sampleNote, subjective: { ...sampleNote.subjective, summary: "palabra ".repeat(400) } };
const parts = formatReview({ patientName: "Ana López", date: "2026-11-23", note: long, missing: [], hasActivePlan: true });
eq(parts.length > 1 && parts.every((p) => p.length <= MAX_MESSAGE - 60), true, "review: long note split, each part fits with options");
eq(parts.join("").includes("Elevación de pierna recta"), true, "review: nothing lost when split");
eq(formatAck("Ana López", 2), ["Anotado para Ana López (nota 2)."], "ack text");

// ---------------------------------------------------------------- Task 5: patient matching
const ref = (id: string, full_name: string, dob: string | null = null): PatientRef =>
  ({ id, full_name, dob, diagnosis: null, assigned_therapist_id: null });
const refs = [ref("1", "Ana López"), ref("2", "Ana Martínez"), ref("3", "Carlos Méndez"),
  ref("4", "Luis Pérez", "1980-01-02"), ref("5", "Luis Pérez", "1992-05-06")];
const names = (ps: PatientRef[]) => ps.map((p) => p.full_name);
eq(names(matchPatients("ana", refs)), ["Ana López", "Ana Martínez"], "match: first name, two hits");
eq(names(matchPatients("ana lopez", refs)), ["Ana López"], "match: accents ignored");
eq(names(matchPatients("Ana López.", refs)), ["Ana López"], "match: punctuation ignored");
eq(names(matchPatients("lopes", refs)), ["Ana López"], "match: one-letter typo in a surname");
eq(names(matchPatients("Méndez", refs)), ["Carlos Méndez"], "match: last name only");
eq(names(matchPatients("Roberto", refs)), [], "match: none");
eq(names(matchPatients("", refs)), [], "match: empty query");
eq(names(matchPatients("luis perez", refs)).length, 2, "match: identical full names both returned");
eq(names(namesInText("Sesión con Carlos Méndez, hoy trabajamos hombro", refs)), ["Carlos Méndez"], "text: full name found");
eq(names(namesInText("La paciente refiere dolor 3 de 10", refs)), [], "text: no name");
eq(namesInText("Ana vino hoy", refs).length, 2, "text: first name alone is ambiguous");
eq(names(namesInText("Hoy vi a Ana López, rodilla", refs)), ["Ana López"], "text: full name beats first name");
eq(names(namesInText("Analizamos la marcha", refs)), [], "text: name inside another word does not count");
const luis = refs.filter((r) => r.full_name === "Luis Pérez");
eq(patientLabel(luis[0], luis), "Luis Pérez (nac. 02/01/1980)", "label: dob only when full names tie");
eq(patientLabel(refs[0], refs), "Ana López", "label: plain otherwise");

// ---------------------------------------------------------------- Task 6: model output clean-up
eq(cleanExtraction({ ...sampleNote, plan: { ...sampleNote.plan, keep_current_plan: true } }).plan.keep_current_plan, false,
  "clean: a dictated list beats 'sin cambios'");
eq(cleanExtraction({ ...sampleNote, plan: { ...sampleNote.plan, keep_current_plan: true, home_exercises: [] } }).plan.keep_current_plan,
  true, "clean: 'sin cambios' with no list stays");

// ---------------------------------------------------------------- Task 8: fixes from simulator runs
eq(names(matchPatients("ana", [refs[1], refs[0]])), ["Ana López", "Ana Martínez"], "match: results sorted by name");
eq(planHeadline({ ...sampleNote, plan: { ...sampleNote.plan, visits_per_week: 1 } }), "1 visita/semana.", "headline: singular visit");
eq(describePlanItem({ type: "exercise", name: "equilibrio unipodal", sets: 3, reps: null, hold_seconds: 30,
  frequency_per_week: 7, days_of_week: null, instructions: null }), "Equilibrio unipodal 3×30 s, diario", "plan line: capitalised");
eq(formatReview({ patientName: "V", date: "2026-11-23", hasActivePlan: false, missing: [],
  note: { ...sampleNote, subjective: { ...sampleNote.subjective, summary: "Refiere dolor 2 de 10.", pain_nprs: 2 } } })[0]
  .includes("Dolor 2/10"), false, "review: pain not repeated when the summary says 'N de 10'");

// ---------------------------------------------------------------- final review fixes
// Finding 1: only a whole-message yes confirms at the review.
for (const t of ["sí", "Si", "ok", "Confirmo", "confirmar", "sí, guárdala"]) eq(isConfirmWord(t), true, `confirm word: ${t}`);
for (const t of ["Sí, pero la flexión fue 120", "Si quita la sentadilla", "si cambia el dolor a 4", "simón"])
  eq(isConfirmWord(t), false, `not a confirm: ${t}`);
// Finding 2: removals and additions in lists.
const withTests = (tests: string[]): SoapExtraction =>
  ({ ...sampleNote, objective: { ...sampleNote.objective, special_tests: tests } });
eq(mergeRevision(withTests(["Lachman", "McMurray", "Cajón"]), withTests(["McMurray", "Cajón"]),
  ["objective.special_tests[0]"]).note.objective.special_tests, ["McMurray", "Cajón"], "merge: remove first unnamed item");
eq(mergeRevision(withTests(["A", "B", "C"]), withTests(["B", "C", "D"]),
  ["objective.special_tests[0]", "objective.special_tests[3]"]).note.objective.special_tests, ["B", "C", "D"],
  "merge: remove one and add one (unnamed)");
eq(mergeRevision(withTests(["A", "B", "C"]), withTests(["B", "C reescrito"]),
  ["objective.special_tests[0]"]).note.objective.special_tests, ["B", "C"], "merge: removal does not let an undeclared rewrite in");
const ex = (name: string) => ({ ...sampleNote.plan.home_exercises[0], name });
const withEx = (names: string[]): SoapExtraction => ({ ...sampleNote, plan: { ...sampleNote.plan, home_exercises: names.map(ex) } });
eq(mergeRevision(withEx(["A", "B", "C"]), withEx(["B", "C", "D"]), ["plan.home_exercises[0]", "plan.home_exercises[3]"])
  .note.plan.home_exercises.map((e) => e.name), ["B", "C", "D"], "merge: remove one and add one (plan items)");
eq(mergeRevision(withEx(["A", "B"]), withEx(["B"]), ["plan.home_exercises[0]"]).note.plan.home_exercises.map((e) => e.name),
  ["B"], "merge: remove first of two plan items");
eq(mergeRevision(withEx(["A", "B"]), withEx(["A", "Z"]), ["plan.home_exercises[1]"]).note.plan.home_exercises.map((e) => e.name),
  ["A", "Z"], "merge: replace an item in place");
const rom = (deg: number): SoapExtraction => ({ ...sampleNote, objective: { ...sampleNote.objective,
  rom: [{ joint: "rodilla", movement: "flexión", degrees: deg }, { joint: "rodilla", movement: "extensión", degrees: -3 }] } });
eq(mergeRevision(rom(115), rom(120), ["objective.rom[0].degrees"]).note.objective.rom.map((r) => r.degrees), [120, -3],
  "merge: change a field inside an unnamed item");
// Finding 4: notes that arrived after the extraction.
const t3 = [1, 2, 3].map((i) => ({ text: `n${i}`, audio_url: null, received_at: `2026-11-23T10:0${i}:00Z` }));
eq(lateNotes({ ...d, transcripts: t3, extracted_count: 2 }).map((t) => t.text), ["n3"], "late notes: the one after extraction");
eq(lateNotes({ ...d, transcripts: t3, extracted_count: 3 }), [], "late notes: none");
eq(lateNotes({ ...d, transcripts: t3 }), [], "late notes: none when never counted");

// ---------------------------------------------------------------- UX: icons, transcript echo, SOAP guide
eq(formatOptions("¿Qué quieres hacer?", [{ id: "a", title: "Nota de sesión", icon: "📝" }, { id: "b", title: "Otra" }]),
  "¿Qué quieres hacer?\n\n1. 📝 Nota de sesión\n2. Otra", "options: icon before the title, none when missing");
eq(formatAck("Ana López", 2, "Refiere dolor 3 de 10."),
  ["🎙️ Anotado para Ana López (nota 2). Esto entendí:\n«Refiere dolor 3 de 10.»\n\n¿Algo mal? Elige *Corregir*."],
  "ack: voice note shows the transcription");
const longAck = formatAck("Ana López", 1, "palabra ".repeat(500).trim());
eq(longAck.length > 1 && longAck.every((p) => p.length <= MAX_MESSAGE - 60), true, "ack: long transcription split, each part fits with options");
eq(longAck.join(" ").includes("¿Algo mal? Elige *Corregir*."), true, "ack: hint kept when split");
eq(formatCorrectionAck(2), "✏️ Corrección anotada para la nota 2.", "correction ack");
for (const part of ["*S – Subjetivo:*", "*O – Objetivo:*", "*A – Valoración:*", "*P – Plan:*", "*Listo*"])
  eq(SOAP_GUIDE.includes(part), true, `SOAP guide has ${part}`);
eq(SOAP_GUIDE.length < MAX_MESSAGE - 200, true, "SOAP guide fits in one message with the patient line");

for (const t of ["Valeria Soto", "ana", "María de la Luz Pérez", "Méndez"]) eq(looksLikeName(t), true, `name: ${t}`);
for (const t of ["La dorsiflexión fue 17 grados, no 15.", "Dolor 3 de 10", "Refiere que se siente mucho mejor hoy y caminó sin dolor"])
  eq(looksLikeName(t), false, `not a name: ${t}`);

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow B checks passed");
