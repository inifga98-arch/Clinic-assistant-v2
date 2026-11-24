// Flow A pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { EvaluationExtraction, EvaluationRevision, RegistrationExtraction } from "../lib/ai/intake-schema.ts";
import { mergeRevision } from "../lib/agents/therapist/note-draft.ts";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(pass ? "ok  " : "FAIL", label, pass ? "" : `got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- shared samples (synthetic)
const sampleEval: EvaluationExtraction = {
  form_region: "lower_limb",
  form_date: "2026-11-24",
  performed_by: "Ana Torres",
  identification: {
    full_name: "Laura Méndez",
    age: 35,
    dob: "1991-03-14",
    occupation: "Contadora",
    sex: "female",
    marital_status: "Soltera",
    fall_risk: "Bajo",
    physician: { name: "Dr. Ruiz", specialty: "ortopedia", phone: null },
    emergency_contact: { name: "Rosa Méndez", relationship: "Madre", phone: "55 1111 2222" },
  },
  family_history: [{ condition: "Diabetes", relatives: ["madre"] }],
  non_pathological: { substance_use: "Niega", activity_type: "Correr", activity_frequency: "3 veces por semana", activity_hours_daily: "1" },
  pathological: {
    allergies: "Niega",
    transfusions: "Niega",
    surgeries: "Niega",
    orthopedic_surgeries: "Niega",
    trauma: "Esguince de tobillo izquierdo jugando fútbol (oct 2026)",
    illnesses: "Niega",
    medications_supplements: "Ibuprofeno 400 mg si hay dolor",
  },
  vital_signs: { temperature: "36.5", blood_pressure: "110/70", respiratory_rate: "16", spo2: "98%", heart_rate: "72" },
  chief_complaint: "Dolor de tobillo izquierdo",
  injury_mechanism: "Inversión forzada al caer de un salto",
  pain: { onset: "Hace 3 semanas", location: "Cara lateral del tobillo izquierdo", type: "Punzante", intensity_nprs: 6, radiation: "No", modifiers: "Aumenta al caminar, disminuye en reposo" },
  exam: {
    posture: "Sin alteraciones",
    gait: "Claudicante, apoyo reducido izquierdo",
    observations: null,
    goniometry: [
      { joint: "Tobillo", movement: "Flexión dorsal", right: "20°", left: "10°" },
      { joint: "Tobillo", movement: "Flexión plantar", right: "45°", left: "35°" },
    ],
    strength_mrc: [{ muscle_or_movement: "Eversores", right: 5, left: 4 }],
    orthopedic_tests: [{ test: "Cajón anterior", right: "negativa", left: "dolorosa" }],
    complementary_tests: null,
    sensation: "Conservada",
    reflexes: null,
    spasm_location: "Peroneos izquierdos",
    surgical_scar: { location: null, features: [] },
    edema: { location: "Maléolo lateral izquierdo", type: "Blando", characteristics: null, godet_sign: "Negativo" },
  },
  auxiliary_studies: "Radiografía sin fractura",
  diagnostic_impression: "Esguince de tobillo grado II",
  pt_diagnosis: "Inestabilidad lateral de tobillo izquierdo con déficit de dorsiflexión",
  treatment_plan: { goals: ["Recuperar dorsiflexión", "Volver a correr en 6 semanas"], instructions: ["2 sesiones por semana", "Propiocepción"] },
  unreadable: [],
};

// ---------------------------------------------------------------- Task 1: schemas
eq(EvaluationExtraction.safeParse(sampleEval).success, true, "schema: sample evaluation parses");
eq(EvaluationExtraction.safeParse({ ...sampleEval, pain: { ...sampleEval.pain, intensity_nprs: 11 } }).success, false,
  "schema: pain 11 rejected");
eq(EvaluationExtraction.safeParse({ ...sampleEval, form_region: "hand" }).success, false, "schema: unknown region rejected");
eq(zodResponseFormat(EvaluationExtraction, "evaluation").type, "json_schema", "schema: evaluation converts to response format");
eq(zodResponseFormat(EvaluationRevision, "evaluation_revision").type, "json_schema", "schema: revision converts");
eq(RegistrationExtraction.safeParse({ full_name: "Laura Méndez", phone: "55 1234 5678", reason: null }).success, true,
  "schema: registration parses");
const changedEval: EvaluationExtraction = {
  ...sampleEval,
  chief_complaint: "REESCRITO",
  exam: { ...sampleEval.exam, goniometry: [{ ...sampleEval.exam.goniometry[0], left: "15°" }, sampleEval.exam.goniometry[1]] },
};
const merged = mergeRevision(sampleEval, changedEval, ["exam.goniometry[0].left"]);
eq([merged.note.chief_complaint, merged.note.exam.goniometry[0].left, merged.applied], ["Dolor de tobillo izquierdo", "15°", true],
  "merge: generic over evaluations, only the declared cell changes");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow A checks passed");
