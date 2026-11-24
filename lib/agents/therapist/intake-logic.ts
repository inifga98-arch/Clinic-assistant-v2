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
