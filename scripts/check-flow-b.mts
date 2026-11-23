// Flow B pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { SoapExtraction, SoapRevision } from "../lib/ai/soap-schema.ts";
import {
  QUESTIONS, isDoneWord, isSkipWord, mergeRevision, missingItems, nextQuestion, parsePainAnswer, toNoteColumns,
  toPlanItems, type NoteDraft,
} from "../lib/agents/therapist/note-draft.ts";

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

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow B checks passed");
