// Flow B pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { SoapExtraction, SoapRevision } from "../lib/ai/soap-schema.ts";

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

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow B checks passed");
