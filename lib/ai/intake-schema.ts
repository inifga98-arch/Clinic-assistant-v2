import { z } from "zod";

// Flow A schemas. Owner: Person 1. Used with OpenAI Structured Outputs (zodResponseFormat).
// Every key present; unknown = null or []. A field the form or the therapist marks as denied
// ("niega", "negado", "ninguno", crossed out) is the string "Niega", never null.
// Field list: docs/superpowers/specs/2026-11-24-flow-a-design.md ("Schema").

const text = () => z.string().nullable();

/** Registration: what the therapist said about a new patient. */
export const RegistrationExtraction = z.object({
  full_name: text().describe("Nombre y apellidos tal como los dijo"),
  phone: text().describe("El número de WhatsApp tal como lo dijo, solo dígitos y +"),
  reason: text().describe("Motivo breve si lo dijo, p. ej. 'rodilla derecha'"),
});
export type RegistrationExtraction = z.infer<typeof RegistrationExtraction>;

const TestResult = z.enum(["positiva", "negativa", "dolorosa"]).nullable();
const Mrc = z.number().int().min(0).max(5).nullable();

/** The clinic's "Historia Clínica" (MS / MI / Columna), section by section. */
export const EvaluationExtraction = z.object({
  form_region: z
    .enum(["upper_limb", "lower_limb", "spine"])
    .nullable()
    .describe("Del título: HISTORIA CLÍNICA MS = upper_limb, MI = lower_limb, Columna = spine"),
  form_date: text().describe("YYYY-MM-DD"),
  performed_by: text(),
  identification: z.object({
    full_name: text(),
    age: z.number().int().nullable(),
    dob: text().describe("YYYY-MM-DD"),
    occupation: text(),
    sex: z.enum(["female", "male"]).nullable(),
    marital_status: text(),
    fall_risk: text(),
    physician: z.object({ name: text(), specialty: text(), phone: text() }),
    emergency_contact: z.object({ name: text(), relationship: text(), phone: text() }),
  }),
  family_history: z.array(
    z.object({
      condition: z.string(),
      relatives: z.array(z.enum(["hermanos", "madre", "padre", "abuelos"])),
    }),
  ),
  non_pathological: z.object({
    substance_use: text(),
    activity_type: text(),
    activity_frequency: text(),
    activity_hours_daily: text(),
  }),
  pathological: z.object({
    allergies: text(),
    transfusions: text(),
    surgeries: text(),
    orthopedic_surgeries: text(),
    trauma: text(),
    illnesses: text(),
    medications_supplements: text(),
  }),
  vital_signs: z.object({
    temperature: text(),
    blood_pressure: text(),
    respiratory_rate: text(),
    spo2: text(),
    heart_rate: text(),
  }),
  chief_complaint: text(),
  injury_mechanism: text(),
  pain: z.object({
    onset: text(),
    location: text(),
    type: text(),
    intensity_nprs: z.number().int().min(0).max(10).nullable(),
    radiation: text(),
    modifiers: text(),
  }),
  exam: z.object({
    posture: text(),
    gait: text(),
    observations: text(),
    goniometry: z.array(z.object({ joint: z.string(), movement: z.string(), right: text(), left: text() })),
    strength_mrc: z.array(z.object({ muscle_or_movement: z.string(), right: Mrc, left: Mrc })),
    orthopedic_tests: z.array(z.object({ test: z.string(), right: TestResult, left: TestResult })),
    complementary_tests: text(),
    sensation: text(),
    reflexes: text(),
    spasm_location: text(),
    surgical_scar: z.object({
      location: text(),
      features: z.array(z.enum(["queloide", "retráctil", "abierta", "con adherencias", "hipertrófica"])),
    }),
    edema: z.object({ location: text(), type: text(), characteristics: text(), godet_sign: text() }),
  }),
  auxiliary_studies: text(),
  diagnostic_impression: text().describe("Impresión diagnóstica (médica)"),
  pt_diagnosis: text().describe("Diagnóstico fisioterapéutico"),
  treatment_plan: z.object({ goals: z.array(z.string()), instructions: z.array(z.string()) }),
  unreadable: z.array(z.string()).describe("Secciones escritas pero ilegibles (solo para fotos)"),
});
export type EvaluationExtraction = z.infer<typeof EvaluationExtraction>;

/** A correction applied to an evaluation: the whole evaluation back, plus the paths changed. */
export const EvaluationRevision = z.object({
  evaluation: EvaluationExtraction,
  changed: z.array(z.string()).describe("Rutas exactas que cambiaste, p. ej. exam.goniometry[0].left"),
});
export type EvaluationRevision = z.infer<typeof EvaluationRevision>;
