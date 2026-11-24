import "server-only";
import { db } from "@/lib/db/server";
import type { PatientRef } from "./patient-match";

// Patient queries for the therapist agent's picker (T-3). Pure matching is in patient-match.ts.

const COLUMNS = "id, full_name, dob, diagnosis, assigned_therapist_id";

/** The therapist's own active patients, most recent visit first. */
export async function recentPatients(therapistId: string, limit = 8): Promise<PatientRef[]> {
  const { data, error } = await db()
    .from("patients")
    .select(COLUMNS)
    .eq("assigned_therapist_id", therapistId)
    .eq("status", "active")
    .order("last_visit_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`picker: could not load recent patients: ${error.message}`);
  return data as PatientRef[];
}

/** Every active patient in the clinic, for matching a typed or spoken name. */
export async function clinicPatients(clinicId: string): Promise<PatientRef[]> {
  const { data, error } = await db().from("patients").select(COLUMNS).eq("clinic_id", clinicId).eq("status", "active");
  if (error) throw new Error(`picker: could not load clinic patients: ${error.message}`);
  return data as PatientRef[];
}
