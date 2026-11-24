import "server-only";
import { normalize } from "@/lib/agents/patient/signals";
import { db } from "@/lib/db/server";
import type { Patient, Therapist } from "@/lib/db/types";
import { phoneVariants } from "@/lib/whatsapp/phone";
import type { NumberOwner } from "./intake-logic";

// Flow A storage for patients: who owns a number, create, reactivate.

/** Every patient or therapist whose phone is this number, in any stored form. */
export async function numberOwners(phone: string): Promise<NumberOwner[]> {
  const variants = phoneVariants(phone);
  const [patients, therapists] = await Promise.all([
    db().from("patients").select("id, full_name, clinic_id, status, consent_at").in("phone", variants),
    db().from("therapists").select("id").in("phone", variants),
  ]);
  if (patients.error) throw new Error(`patients: could not look up number: ${patients.error.message}`);
  if (therapists.error) throw new Error(`patients: could not look up therapist number: ${therapists.error.message}`);
  return [
    ...therapists.data.map((): NumberOwner => ({ kind: "therapist" })),
    ...patients.data.map(
      (p): NumberOwner => ({
        kind: "patient",
        id: p.id as string,
        full_name: p.full_name as string,
        clinic_id: p.clinic_id as string,
        status: p.status as "active" | "discharged",
        consent_at: (p.consent_at as string | null) ?? null,
      }),
    ),
  ];
}

/** An active patient in the clinic with exactly this name (accents and case ignored). */
export async function sameNamePatient(clinicId: string, fullName: string): Promise<{ full_name: string; dob: string | null } | null> {
  const { data, error } = await db().from("patients").select("full_name, dob").eq("clinic_id", clinicId).eq("status", "active");
  if (error) throw new Error(`patients: could not check names: ${error.message}`);
  const target = normalize(fullName);
  const hit = data.find((p) => normalize(p.full_name as string) === target);
  return hit ? { full_name: hit.full_name as string, dob: (hit.dob as string | null) ?? null } : null;
}

/** Register a patient for this therapist. "duplicate" when the number was taken meanwhile. */
export async function createPatient(
  therapist: Therapist,
  r: { full_name: string; phone: string; reason: string | null },
): Promise<Patient | "duplicate"> {
  const { data, error } = await db()
    .from("patients")
    .insert({
      clinic_id: therapist.clinic_id,
      assigned_therapist_id: therapist.id,
      full_name: r.full_name.trim(),
      phone: r.phone,
      intake_reason: r.reason?.trim() || null,
      first_visit_at: new Date().toISOString(),
      status: "active",
    })
    .select("*")
    .single();
  if (error?.code === "23505") return "duplicate";
  if (error) throw new Error(`patients: could not create: ${error.message}`);
  return data as Patient;
}

/** A discharged patient returns: active again, assigned to this therapist. */
export async function reactivatePatient(patientId: string, therapistId: string): Promise<Patient> {
  const { data, error } = await db()
    .from("patients")
    .update({ status: "active", assigned_therapist_id: therapistId })
    .eq("id", patientId)
    .select("*")
    .single();
  if (error) throw new Error(`patients: could not reactivate: ${error.message}`);
  return data as Patient;
}

export async function getPatient(patientId: string): Promise<Patient | null> {
  const { data, error } = await db().from("patients").select("*").eq("id", patientId).maybeSingle();
  if (error) throw new Error(`patients: could not load: ${error.message}`);
  return (data as Patient | null) ?? null;
}
