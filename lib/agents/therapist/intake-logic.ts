// Flow A logic (pure): phone parsing, duplicate decisions, evaluation gaps and the patient
// fields an evaluation fills. No runtime "@/" imports so scripts/check-flow-a.mts can test it.

import type { EvaluationExtraction } from "../../ai/intake-schema";
import { normalizePhone } from "../../whatsapp/phone";

/**
 * A spoken or typed WhatsApp number to the stored E.164 form, or null if it isn't one.
 * "55 1234 5678" (10 Mexican digits) -> +5215512345678; a "+" number keeps its country code.
 */
export function parsePatientPhone(raw: string | null): string | null {
  if (!raw) return null;
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  let e164: string | null = null;
  if (plus) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+52${digits}`;
  else if ((digits.length === 12 || digits.length === 13) && digits.startsWith("52")) e164 = `+${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  if (!e164) return null;
  const normalized = normalizePhone(e164);
  return /^\+\d{8,15}$/.test(normalized) ? normalized : null;
}

/** "+5215512345678" -> "+52 55 1234 5678" for showing; other numbers unchanged. */
export function displayPhone(e164: string): string {
  const mx = /^\+521(\d{2})(\d{4})(\d{4})$/.exec(e164);
  return mx ? `+52 ${mx[1]} ${mx[2]} ${mx[3]}` : e164;
}

// ---------------------------------------------------------------- duplicates

export type NumberOwner =
  | {
      kind: "patient";
      id: string;
      full_name: string;
      clinic_id: string;
      status: "active" | "discharged";
      consent_at: string | null;
    }
  | { kind: "therapist" };

type PatientOwner = Extract<NumberOwner, { kind: "patient" }>;

export type NumberClass =
  | { kind: "new" }
  | { kind: "therapist" }
  | { kind: "other_clinic" }
  | { kind: "existing"; patient: PatientOwner }
  | { kind: "discharged"; patient: PatientOwner };

/** Who already owns a number, from this clinic's point of view. A therapist always wins. */
export function classifyNumber(owners: NumberOwner[], clinicId: string): NumberClass {
  if (owners.some((o) => o.kind === "therapist")) return { kind: "therapist" };
  const patients = owners.filter((o): o is PatientOwner => o.kind === "patient");
  const mine = patients.find((p) => p.clinic_id === clinicId);
  if (mine) return mine.status === "discharged" ? { kind: "discharged", patient: mine } : { kind: "existing", patient: mine };
  if (patients.length) return { kind: "other_clinic" };
  return { kind: "new" };
}

// ---------------------------------------------------------------- evaluation gaps

export type EvalGap = "chief_complaint" | "pain" | "diagnosis" | "plan";

export const EVAL_GAP_LABELS: Record<EvalGap, string> = {
  chief_complaint: "motivo de consulta",
  pain: "intensidad del dolor",
  diagnosis: "diagnóstico",
  plan: "plan de tratamiento",
};

const filled = (s: string | null) => !!s && s.trim().length > 0;

/** The core items an initial evaluation should have; anything else empty is simply not shown. */
export function evaluationGaps(e: EvaluationExtraction): EvalGap[] {
  const gaps: EvalGap[] = [];
  if (!filled(e.chief_complaint)) gaps.push("chief_complaint");
  if (e.pain.intensity_nprs === null) gaps.push("pain");
  if (!filled(e.diagnostic_impression) && !filled(e.pt_diagnosis)) gaps.push("diagnosis");
  if (!e.treatment_plan.goals.length && !e.treatment_plan.instructions.length) gaps.push("plan");
  return gaps;
}

// ---------------------------------------------------------------- patient fields

export interface PatientFields {
  diagnosis: string | null;
  referring_doctor: string | null;
  dob: string | null;
  sex: "female" | "male" | null;
}

/** Patient fields the evaluation can fill. The database only writes the ones still empty. */
export function patientFieldsFromEvaluation(e: EvaluationExtraction): PatientFields {
  const doctor = e.identification.physician;
  const name = doctor.name?.trim();
  return {
    diagnosis: (filled(e.diagnostic_impression) ? e.diagnostic_impression : e.pt_diagnosis)?.trim() || null,
    referring_doctor: name ? (doctor.specialty?.trim() ? `${name} (${doctor.specialty.trim()})` : name) : null,
    dob: isValidDate(e.identification.dob) ? e.identification.dob : null,
    sex: e.identification.sex,
  };
}

/** YYYY-MM-DD, a real calendar date, not in the future. */
export function isValidDate(s: string | null, now = new Date()): boolean {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  return date.getTime() <= now.getTime();
}

// ---------------------------------------------------------------- two reads of a photo

const VITAL_LABELS = {
  temperature: "temperatura",
  blood_pressure: "TA",
  respiratory_rate: "FR",
  spo2: "SatO2",
  heart_rate: "FC",
} as const;

const same = (a: unknown, b: unknown) =>
  String(a ?? "").replace(/\s+/g, "").toLowerCase() === String(b ?? "").replace(/\s+/g, "").toLowerCase();
const rowKey = (...parts: string[]) => parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Photos are read twice; where the two reads disagree on a number, date or test result, the
 * value is a guess. Keep the first read, blank every such disagreeing value and list it as
 * unreadable, so the therapist fills it in from the paper. Wording differences in free text
 * are not guesses and keep the first read.
 */
export function reconcileReadings(a: EvaluationExtraction, b: EvaluationExtraction): EvaluationExtraction {
  const out: EvaluationExtraction = structuredClone(a);
  const flagged: string[] = [];
  const check = <T>(x: T | null, y: T | null, label: string, clear: () => void) => {
    if ((x === null || x === undefined) && (y === null || y === undefined)) return;
    if (!same(x, y)) {
      clear();
      flagged.push(label);
    }
  };

  check(a.form_date, b.form_date, "fecha del formato", () => (out.form_date = null));
  check(a.identification.dob, b.identification.dob, "fecha de nacimiento", () => (out.identification.dob = null));
  check(a.identification.age, b.identification.age, "edad", () => (out.identification.age = null));
  check(a.identification.physician.phone, b.identification.physician.phone, "teléfono del médico",
    () => (out.identification.physician.phone = null));
  check(a.identification.emergency_contact.phone, b.identification.emergency_contact.phone, "teléfono de emergencia",
    () => (out.identification.emergency_contact.phone = null));
  check(a.pain.intensity_nprs, b.pain.intensity_nprs, "intensidad del dolor", () => (out.pain.intensity_nprs = null));
  for (const key of Object.keys(VITAL_LABELS) as (keyof typeof VITAL_LABELS)[]) {
    check(a.vital_signs[key], b.vital_signs[key], `signos vitales (${VITAL_LABELS[key]})`, () => (out.vital_signs[key] = null));
  }

  const sides = (
    rowsA: { right: unknown; left: unknown }[],
    rowsOut: { right: unknown; left: unknown }[],
    keysA: string[],
    lookupB: Map<string, { right: unknown; left: unknown }>,
    label: (i: number) => string,
  ) => {
    rowsA.forEach((row, i) => {
      const other = lookupB.get(keysA[i]);
      if (!other) return; // only one read saw this row: nothing to compare
      check(row.right, other.right, `${label(i)} (D)`, () => (rowsOut[i].right = null));
      check(row.left, other.left, `${label(i)} (I)`, () => (rowsOut[i].left = null));
    });
  };
  const gonioKey = (g: { joint: string; movement: string }) => rowKey(g.joint, g.movement);
  sides(a.exam.goniometry, out.exam.goniometry, a.exam.goniometry.map(gonioKey),
    new Map(b.exam.goniometry.map((g) => [gonioKey(g), g])),
    (i) => `goniometría ${rowKey(a.exam.goniometry[i].joint, a.exam.goniometry[i].movement)}`);
  sides(a.exam.strength_mrc, out.exam.strength_mrc, a.exam.strength_mrc.map((s) => rowKey(s.muscle_or_movement)),
    new Map(b.exam.strength_mrc.map((s) => [rowKey(s.muscle_or_movement), s])),
    (i) => `fuerza ${rowKey(a.exam.strength_mrc[i].muscle_or_movement)}`);
  sides(a.exam.orthopedic_tests, out.exam.orthopedic_tests, a.exam.orthopedic_tests.map((t) => rowKey(t.test)),
    new Map(b.exam.orthopedic_tests.map((t) => [rowKey(t.test), t])),
    (i) => `prueba ${a.exam.orthopedic_tests[i].test}`);

  out.unreadable = [...new Set([...a.unreadable, ...flagged])];
  return out;
}
