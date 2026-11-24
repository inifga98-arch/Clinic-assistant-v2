// Flow A logic (pure): phone parsing, duplicate decisions, evaluation gaps and the patient
// fields an evaluation fills. No runtime "@/" imports so scripts/check-flow-a.mts can test it.

import type { EvaluationExtraction } from "../../ai/intake-schema";
import { normalizePhone } from "../../whatsapp/phone";
import { matchPatients } from "./patient-match";

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

const HISTORY_LABELS = {
  allergies: "alergias",
  transfusions: "transfusiones",
  surgeries: "antecedentes quirúrgicos",
  orthopedic_surgeries: "quirúrgicos ortopédicos",
  trauma: "trauma",
  illnesses: "enfermedades",
  medications_supplements: "medicamentos/suplementos",
} as const;

const HABIT_LABELS = {
  substance_use: "toxicomanías",
  activity_type: "actividad física",
  activity_frequency: "frecuencia de actividad",
  activity_hours_daily: "horas diarias de actividad",
} as const;

/** Compare what was read, ignoring spacing, case, accents and units ("20°" = "20", "98%" = "98"). */
const canonical = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9./]/g, "");
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
/**
 * Row names as the two reads may write them: "Flex. dorsal" and "Flexión dorsal" are the same
 * row. Each word is cut to its first 4 letters (accents and punctuation removed).
 */
const rowMatchKey = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.slice(0, 4))
    .join(" ");
/** A readable label for a row: lower case, single spaces (accents kept for the therapist). */
const rowLabel = (...parts: string[]) => parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Photos are read twice; where the two reads disagree, the value is a guess. Keep the first read,
 * blank every value the reads disagree on (numbers, dates, test results, sex, the form type),
 * every value only one read saw (a row or a history field the other read left empty), and list
 * them all as unreadable so the therapist fills them in from the paper. Wording differences in
 * free text that both reads saw are not guesses and keep the first read.
 */
export function reconcileReadings(a: EvaluationExtraction, b: EvaluationExtraction): EvaluationExtraction {
  const out: EvaluationExtraction = structuredClone(a);
  const flagged: string[] = [];
  /** Exact check: any difference (including one side empty) blanks the value. */
  const check = (x: unknown, y: unknown, label: string, clear: () => void) => {
    if (blank(x) && blank(y)) return;
    if (!same(x, y)) {
      if (!blank(x)) clear();
      flagged.push(label);
    }
  };
  /** Free text: wording may differ; only "one read saw it, the other didn't" is a guess. */
  const presence = (x: unknown, y: unknown, label: string, clear: () => void) => {
    if (blank(x) !== blank(y)) {
      if (!blank(x)) clear();
      flagged.push(label);
    }
  };

  check(a.form_region, b.form_region, "tipo de formato", () => (out.form_region = null));
  check(a.form_date, b.form_date, "fecha del formato", () => (out.form_date = null));
  check(a.identification.dob, b.identification.dob, "fecha de nacimiento", () => (out.identification.dob = null));
  check(a.identification.age, b.identification.age, "edad", () => (out.identification.age = null));
  check(a.identification.sex, b.identification.sex, "sexo", () => (out.identification.sex = null));
  check(a.identification.physician.phone, b.identification.physician.phone, "teléfono del médico",
    () => (out.identification.physician.phone = null));
  check(a.identification.emergency_contact.phone, b.identification.emergency_contact.phone, "teléfono de emergencia",
    () => (out.identification.emergency_contact.phone = null));
  check(a.pain.intensity_nprs, b.pain.intensity_nprs, "intensidad del dolor", () => (out.pain.intensity_nprs = null));
  for (const key of Object.keys(VITAL_LABELS) as (keyof typeof VITAL_LABELS)[]) {
    check(a.vital_signs[key], b.vital_signs[key], `signos vitales (${VITAL_LABELS[key]})`, () => (out.vital_signs[key] = null));
  }
  for (const key of Object.keys(HISTORY_LABELS) as (keyof typeof HISTORY_LABELS)[]) {
    presence(a.pathological[key], b.pathological[key], HISTORY_LABELS[key], () => (out.pathological[key] = null));
  }
  for (const key of Object.keys(HABIT_LABELS) as (keyof typeof HABIT_LABELS)[]) {
    presence(a.non_pathological[key], b.non_pathological[key], HABIT_LABELS[key], () => (out.non_pathological[key] = null));
  }
  presence(a.chief_complaint, b.chief_complaint, "motivo de consulta", () => (out.chief_complaint = null));
  presence(a.diagnostic_impression, b.diagnostic_impression, "impresión diagnóstica", () => (out.diagnostic_impression = null));
  presence(a.pt_diagnosis, b.pt_diagnosis, "diagnóstico fisioterapéutico", () => (out.pt_diagnosis = null));

  const familyKey = (f: EvaluationExtraction["family_history"]) =>
    f.map((x) => `${canonical(x.condition)}:${[...x.relatives].sort().join(",")}`).sort().join("|");
  if (familyKey(a.family_history) !== familyKey(b.family_history)) {
    out.family_history = [];
    flagged.push("antecedentes heredofamiliares");
  }

  const sides = <R extends { right: unknown; left: unknown }>(
    rowsA: R[],
    rowsOut: { right: unknown; left: unknown }[],
    rowsB: R[],
    key: (r: R) => string,
    label: (r: R) => string,
  ) => {
    const lookupB = new Map(rowsB.map((r) => [rowMatchKey(key(r)), r]));
    rowsA.forEach((row, i) => {
      const other = lookupB.get(rowMatchKey(key(row))); // undefined: only this read saw the row
      check(row.right, other?.right ?? null, `${label(row)} (D)`, () => (rowsOut[i].right = null));
      check(row.left, other?.left ?? null, `${label(row)} (I)`, () => (rowsOut[i].left = null));
    });
  };
  sides(a.exam.goniometry, out.exam.goniometry, b.exam.goniometry, (g) => `${g.joint} ${g.movement}`,
    (g) => `goniometría ${rowLabel(g.joint, g.movement)}`);
  sides(a.exam.strength_mrc, out.exam.strength_mrc, b.exam.strength_mrc, (s) => s.muscle_or_movement,
    (s) => `fuerza ${rowLabel(s.muscle_or_movement)}`);
  sides(a.exam.orthopedic_tests, out.exam.orthopedic_tests, b.exam.orthopedic_tests, (t) => t.test,
    (t) => `prueba ${t.test}`);

  out.unreadable = [...new Set([...a.unreadable, ...b.unreadable, ...flagged])];
  return out;
}

// ---------------------------------------------------------------- what the evaluation may fill

/** Patient fields to fill on confirm; none when the form names another person. */
export function patientFieldsToFill(e: EvaluationExtraction, patientName: string): PatientFields {
  if (formNameMismatch(e.identification.full_name, patientName)) {
    return { diagnosis: null, referring_doctor: null, dob: null, sex: null };
  }
  return patientFieldsFromEvaluation(e);
}

// ---------------------------------------------------------------- evaluation draft (shape)

export type EvalInput =
  | { kind: "page"; media_url: string; content_type: string; received_at: string }
  | { kind: "note"; text: string; audio_url: string | null; received_at: string };

/** "reading": an extraction is running; anything arriving now is late. */
export type EvalStep = "choose_source" | "pages" | "recording" | "reading" | "review" | "editing";

export interface EvalDraft {
  inputs: EvalInput[];
  extraction: EvaluationExtraction | null;
  step: EvalStep;
  source: "photo" | "voice" | null;
  /** How many inputs the current extraction was built from (unset before the first). */
  extracted_count?: number;
  /** Photo path: true once the pages that were read have been deleted from Twilio. */
  pages_deleted?: boolean;
}

/** Inputs that arrived after the current extraction was made (not in it yet). */
export function lateInputs(d: EvalDraft): EvalInput[] {
  if (d.extracted_count === undefined) return [];
  return d.inputs.slice(d.extracted_count);
}

// ---------------------------------------------------------------- the form names another person

/**
 * True when the name written on the form is clearly another person than the patient the
 * evaluation is for (a photo of the wrong patient's form). Same person if every word of the
 * shorter name appears in the longer one, allowing accents, case and one-letter typos.
 */
export function formNameMismatch(formName: string | null, patientName: string): boolean {
  if (!formName?.trim()) return false;
  const ref = (full_name: string) => ({ id: "x", full_name, dob: null, diagnosis: null, assigned_therapist_id: null });
  const [shorter, longer] =
    formName.trim().split(/\s+/).length <= patientName.trim().split(/\s+/).length
      ? [formName, patientName]
      : [patientName, formName];
  return matchPatients(shorter, [ref(longer)]).length === 0;
}
