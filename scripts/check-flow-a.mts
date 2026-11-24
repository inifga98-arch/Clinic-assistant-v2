// Flow A pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { EvaluationExtraction, EvaluationRevision, RegistrationExtraction } from "../lib/ai/intake-schema.ts";
import { mergeRevision } from "../lib/agents/therapist/note-draft.ts";
import {
  classifyNumber, displayPhone, evaluationGaps, isValidDate, parsePatientPhone, patientFieldsFromEvaluation,
  type NumberOwner,
} from "../lib/agents/therapist/intake-logic.ts";

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

// ---------------------------------------------------------------- Task 2: intake logic
const emptyEval: EvaluationExtraction = {
  ...sampleEval,
  chief_complaint: null,
  pain: { ...sampleEval.pain, intensity_nprs: null },
  diagnostic_impression: null,
  pt_diagnosis: null,
  treatment_plan: { goals: [], instructions: [] },
};
eq(parsePatientPhone("55 1234 5678"), "+5215512345678", "phone: 10 MX digits");
eq(parsePatientPhone("+52 1 55 1234 5678"), "+5215512345678", "phone: +52 1");
eq(parsePatientPhone("5215512345678"), "+5215512345678", "phone: 52 1 no plus");
eq(parsePatientPhone("525512345678"), "+5215512345678", "phone: 52 no 1");
eq(parsePatientPhone("+52 55 1234 5678"), "+5215512345678", "phone: +52 without 1");
eq(parsePatientPhone("+1 (617) 259-7932"), "+16172597932", "phone: US with +");
eq(parsePatientPhone("16172597932"), "+16172597932", "phone: US without +");
eq(parsePatientPhone("1234"), null, "phone: too short");
eq(parsePatientPhone("12345678901234567"), null, "phone: too long");
eq(parsePatientPhone(null), null, "phone: missing");
const pat = (clinic_id: string, status: "active" | "discharged"): NumberOwner =>
  ({ kind: "patient", id: "p1", full_name: "Carlos Méndez", clinic_id, status, consent_at: null });
eq(classifyNumber([], "c1").kind, "new", "dup: none");
eq(classifyNumber([{ kind: "therapist" }], "c1").kind, "therapist", "dup: therapist");
eq(classifyNumber([pat("c1", "active")], "c1").kind, "existing", "dup: same clinic");
eq(classifyNumber([pat("c1", "discharged")], "c1").kind, "discharged", "dup: discharged");
eq(classifyNumber([pat("c2", "active")], "c1").kind, "other_clinic", "dup: other clinic");
eq(classifyNumber([pat("c2", "active"), { kind: "therapist" }], "c1").kind, "therapist", "dup: therapist wins");
eq(evaluationGaps(sampleEval), [], "gaps: complete");
eq(evaluationGaps(emptyEval), ["chief_complaint", "pain", "diagnosis", "plan"], "gaps: all four");
eq(evaluationGaps({ ...emptyEval, pt_diagnosis: "Inestabilidad" }).includes("diagnosis"), false, "gaps: pt diagnosis is enough");
eq(patientFieldsFromEvaluation(sampleEval),
  { diagnosis: "Esguince de tobillo grado II", referring_doctor: "Dr. Ruiz (ortopedia)", dob: "1991-03-14", sex: "female" },
  "fields: mapped");
eq(patientFieldsFromEvaluation({ ...sampleEval, diagnostic_impression: null }).diagnosis, sampleEval.pt_diagnosis,
  "fields: pt diagnosis fallback");
eq(patientFieldsFromEvaluation({ ...sampleEval, identification: { ...sampleEval.identification, dob: "1991-02-30" } }).dob, null,
  "fields: impossible dob dropped");
eq(patientFieldsFromEvaluation({ ...sampleEval, identification: { ...sampleEval.identification,
  physician: { name: "Dra. Salas", specialty: null, phone: null } } }).referring_doctor, "Dra. Salas", "fields: doctor without specialty");
eq(isValidDate("1991-03-14"), true, "date: valid");
eq(isValidDate("1991-02-30"), false, "date: impossible");
eq(isValidDate("2999-01-01"), false, "date: future");
eq(isValidDate("14/03/1991"), false, "date: wrong format");
eq(displayPhone("+5215512345678"), "+52 55 1234 5678", "display: MX");
eq(displayPhone("+16172597932"), "+16172597932", "display: other");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow A checks passed");
