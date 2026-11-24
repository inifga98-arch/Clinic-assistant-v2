// Flow A pure-logic checks (no network, no DB). Run: npm run check
import { zodResponseFormat } from "openai/helpers/zod";
import { EvaluationExtraction, EvaluationRevision, RegistrationExtraction } from "../lib/ai/intake-schema.ts";
import { mergeRevision } from "../lib/agents/therapist/note-draft.ts";
import {
  classifyNumber, displayPhone, reconcileReadings, evaluationGaps, isValidDate, parsePatientPhone, patientFieldsFromEvaluation,
  type NumberOwner,
} from "../lib/agents/therapist/intake-logic.ts";
import {
  EVAL_REVIEW_OPTIONS, EVAL_SOURCE_OPTIONS, PAGES_OPTIONS, PHOTO_PROMPT, REGISTRATION_OPTIONS, REGISTRATION_PROMPT,
  evalVoiceGuide, formatEvaluationReview, formatPageAck, formatRegistrationCard,
} from "../lib/agents/therapist/intake-format.ts";
import { MAX_MESSAGE } from "../lib/agents/therapist/note-format.ts";
import { mediaTypeForPath } from "../lib/whatsapp/media-types.ts";

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

// ---------------------------------------------------------------- Task 4: messages
const card = formatRegistrationCard({ full_name: "Laura Méndez", phone: "+5215512345678", reason: "rodilla derecha" });
eq(card.includes("🆕 *Laura Méndez*") && card.includes("📱 +52 55 1234 5678") && card.includes("🩺 Motivo: rodilla derecha"), true,
  "card: name, display phone, reason");
eq(formatRegistrationCard({ full_name: "Laura Méndez", phone: "+5215512345678", reason: null }).includes("Motivo"), false,
  "card: no reason line when none");
eq(formatRegistrationCard({ full_name: "Laura Méndez", phone: "+5215512345678", reason: null },
  { full_name: "Laura Méndez", dob: "1991-03-14" }).includes("⚠️ Ya existe *Laura Méndez* (nac. 14/03/1991)"), true,
  "card: same-name warning with dob");
const review = formatEvaluationReview("Laura Méndez", sampleEval).join("\n");
eq(review.startsWith("🩺 *Valoración inicial · Laura Méndez*"), true, "review: header");
eq(review.includes("Alergias: Niega"), true, "review: stated none shown as written");
eq(review.includes("Tobillo flexión dorsal: D 20° / I 10°"), true, "review: goniometry right/left");
eq(review.includes("Cajón anterior: D negativa / I dolorosa"), true, "review: orthopedic tests right/left");
eq(review.includes("Diabetes (madre)"), true, "review: family history");
eq(review.includes("Falta:") || review.includes("No se pudo leer:"), false, "review: complete eval lists no gaps");
eq(review.indexOf("*Motivo*") < review.indexOf("*Exploración*") && review.indexOf("*Exploración*") < review.indexOf("*Plan de tratamiento*"),
  true, "review: form order");
const gapReview = formatEvaluationReview("Laura Méndez", { ...emptyEval, unreadable: ["antecedentes heredofamiliares"] }).join("\n");
eq(gapReview.includes("No se pudo leer: antecedentes heredofamiliares"), true, "review: unreadable listed");
eq(gapReview.includes("Falta: motivo de consulta, intensidad del dolor, diagnóstico, plan de tratamiento"), true, "review: gaps listed");
const bigEval: EvaluationExtraction = { ...sampleEval, exam: { ...sampleEval.exam,
  goniometry: Array.from({ length: 30 }, (_, i) => ({ joint: `Articulación ${i}`, movement: "flexión", right: "120°", left: "118°" })) } };
const bigParts = formatEvaluationReview("Laura Méndez", bigEval);
eq(bigParts.length > 1 && bigParts.every((p) => p.length <= MAX_MESSAGE - 60), true, "review: long evaluation split, each part fits");
eq(bigParts[bigParts.length - 1].includes("*Plan de tratamiento*"), true, "review: last section kept when split");
for (const [name, list] of Object.entries({ REGISTRATION_OPTIONS, EVAL_SOURCE_OPTIONS, PAGES_OPTIONS, EVAL_REVIEW_OPTIONS }))
  eq(list.every((o) => !!o.icon), true, `options with icons: ${name}`);
eq(REGISTRATION_PROMPT.length < 600 && REGISTRATION_PROMPT.includes("*nombre completo*"), true, "registration prompt");
eq(PHOTO_PROMPT.includes("*Plan de tratamiento*"), true, "photo prompt names the last page");
eq(evalVoiceGuide("Laura Méndez").includes("*Plan de tratamiento:*"), true, "voice guide follows the form");
eq(formatPageAck(2), "📷 Recibí la página 2. ¿Hay más páginas?", "page ack");

// ---------------------------------------------------------------- Task 5: media types
eq(mediaTypeForPath("forma.JPG"), "image/jpeg", "media: jpg");
eq(mediaTypeForPath("forma.png"), "image/png", "media: png");
eq(mediaTypeForPath("nota.ogg"), "audio/ogg", "media: audio still works");
eq(mediaTypeForPath("x.pdf"), "application/octet-stream", "media: unknown");

// ---------------------------------------------------------------- Task 6: two reads of a photo must agree
const agree = reconcileReadings(sampleEval, structuredClone(sampleEval));
eq(agree, sampleEval, "reconcile: identical reads unchanged");
const otherDob = { ...sampleEval, identification: { ...sampleEval.identification, dob: "1985-07-24", age: 41 } };
const r1 = reconcileReadings(sampleEval, otherDob);
eq([r1.identification.dob, r1.identification.age], [null, null], "reconcile: disagreeing date and age blanked");
eq(r1.unreadable.includes("fecha de nacimiento") && r1.unreadable.includes("edad"), true, "reconcile: blanked fields listed");
eq(r1.identification.full_name, sampleEval.identification.full_name, "reconcile: agreeing text kept");
const otherGonio = { ...sampleEval, exam: { ...sampleEval.exam, goniometry: [
  sampleEval.exam.goniometry[1], { ...sampleEval.exam.goniometry[0], left: "16°" }] } };
const r2 = reconcileReadings(sampleEval, otherGonio);
eq(r2.exam.goniometry.map((g) => g.left), [null, "35°"], "reconcile: goniometry rows matched by name, disagreeing cell blanked");
eq(r2.unreadable.includes("goniometría tobillo flexión dorsal (I)"), true, "reconcile: goniometry cell listed");
const otherPain = { ...sampleEval, pain: { ...sampleEval.pain, intensity_nprs: 8 },
  vital_signs: { ...sampleEval.vital_signs, blood_pressure: "120/80" } };
const r3 = reconcileReadings(sampleEval, otherPain);
eq([r3.pain.intensity_nprs, r3.vital_signs.blood_pressure, r3.vital_signs.heart_rate], [null, null, "72"],
  "reconcile: pain and vital signs");
const reworded = { ...sampleEval, chief_complaint: "Dolor en el tobillo izquierdo" };
eq(reconcileReadings(sampleEval, reworded).chief_complaint, sampleEval.chief_complaint, "reconcile: wording differences in text keep the first read");
eq(reconcileReadings({ ...sampleEval, unreadable: ["edema"] }, sampleEval).unreadable, ["edema"], "reconcile: first read's unreadable kept");

eq(formatEvaluationReview("Laura Méndez", sampleEval, { fromPhoto: true }).join("").includes("Revisa fechas y números contra el papel"), true,
  "review: photo path reminds to check against the paper");
eq(formatEvaluationReview("Laura Méndez", sampleEval).join("").includes("contra el papel"), false, "review: voice path has no paper reminder");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all Flow A checks passed");
