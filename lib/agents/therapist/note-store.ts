import "server-only";
import { db } from "@/lib/db/server";
import type { Patient, PlanItem, Session } from "@/lib/db/types";
import { clinicToday } from "@/lib/agents/patient/time";
import {
  EMPTY_DRAFT, describePlanItem, type NoteColumns, type NoteDraft, type PlanItemInput, type SessionNoteStep,
  type TranscriptEntry,
} from "./note-draft";

// Flow B storage: the draft note lives in sessions.draft until it is confirmed. Writes that must
// be atomic go through the functions in supabase/migrations/0002_flow_b.sql.

export interface LoadedDraft {
  session: Session;
  draft: NoteDraft;
  patient: Patient;
}

/** A new draft note for a patient; returns the session id. */
export async function createDraft(therapistId: string, patientId: string): Promise<string> {
  const { data, error } = await db()
    .from("sessions")
    .insert({ therapist_id: therapistId, patient_id: patientId, status: "draft", draft: EMPTY_DRAFT })
    .select("id")
    .single();
  if (error) throw new Error(`notes: could not create draft: ${error.message}`);
  return data.id as string;
}

/** The open draft with its patient, or null when it was confirmed or discarded meanwhile. */
export async function loadDraft(sessionId: string): Promise<LoadedDraft | null> {
  const { data: session, error } = await db().from("sessions").select("*").eq("id", sessionId).maybeSingle();
  if (error) throw new Error(`notes: could not load draft: ${error.message}`);
  if (!session || session.status !== "draft") return null;
  const { data: patient, error: pErr } = await db().from("patients").select("*").eq("id", session.patient_id).single();
  if (pErr) throw new Error(`notes: could not load patient: ${pErr.message}`);
  return {
    session: session as Session,
    draft: { ...EMPTY_DRAFT, ...((session.draft as Partial<NoteDraft> | null) ?? {}) },
    patient: patient as Patient,
  };
}

/** "draft", "confirmed", or null when the session no longer exists (discarded). */
export async function draftStatus(sessionId: string): Promise<"draft" | "confirmed" | null> {
  const { data, error } = await db().from("sessions").select("status").eq("id", sessionId).maybeSingle();
  if (error) throw new Error(`notes: could not read status: ${error.message}`);
  return (data?.status as "draft" | "confirmed" | undefined) ?? null;
}

/** Add one note; returns how many the draft has now. Safe when two notes arrive at once. */
export async function appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<number> {
  const { data, error } = await db().rpc("append_session_transcript", { p_session_id: sessionId, p_entry: entry });
  if (error) throw new Error(`notes: could not append transcript: ${error.message}`);
  return data as number;
}

/** Merge fields into the draft. Never touches transcripts (only appendTranscript does). */
export async function setDraftFields(sessionId: string, fields: Partial<Omit<NoteDraft, "transcripts">>): Promise<void> {
  const { error } = await db().rpc("set_draft_fields", { p_session_id: sessionId, p_fields: fields });
  if (error) throw new Error(`notes: could not update draft: ${error.message}`);
}

export interface DraftSummary {
  sessionId: string;
  patientName: string;
  createdAt: string;
  step: SessionNoteStep;
}

const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The therapist's newest draft from the last 24 hours, if any. */
export async function latestDraft(therapistId: string, now = new Date()): Promise<DraftSummary | null> {
  const since = new Date(now.getTime() - DRAFT_MAX_AGE_MS).toISOString();
  const { data, error } = await db()
    .from("sessions")
    .select("id, created_at, draft, patients(full_name)")
    .eq("therapist_id", therapistId)
    .eq("status", "draft")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`notes: could not look for drafts: ${error.message}`);
  const row = data?.[0] as
    | { id: string; created_at: string; draft: Partial<NoteDraft> | null; patients: { full_name: string } | { full_name: string }[] | null }
    | undefined;
  if (!row) return null;
  const patient = Array.isArray(row.patients) ? row.patients[0] : row.patients;
  return {
    sessionId: row.id,
    patientName: patient?.full_name ?? "un paciente",
    createdAt: row.created_at,
    step: row.draft?.step ?? "recording",
  };
}

/** Throw a draft away (Descartar). Confirmed notes cannot be deleted. */
export async function deleteDraft(sessionId: string): Promise<void> {
  const { error } = await db().from("sessions").delete().eq("id", sessionId).eq("status", "draft");
  if (error) throw new Error(`notes: could not discard draft: ${error.message}`);
}

/** The patient's active home plan, one line per item; empty when there is no active plan. */
export async function activePlanLines(patientId: string): Promise<string[]> {
  const { data: plan, error } = await db()
    .from("plans")
    .select("id")
    .eq("patient_id", patientId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`notes: could not load active plan: ${error.message}`);
  if (!plan) return [];
  const { data: items, error: iErr } = await db()
    .from("plan_items")
    .select("*")
    .eq("plan_id", plan.id)
    .order("position");
  if (iErr) throw new Error(`notes: could not load plan items: ${iErr.message}`);
  return (items as PlanItem[]).map((it) => describePlanItem(it));
}

export type ConfirmResult = "saved" | "already_confirmed" | "not_found";

/** T-8 in one transaction: lock the note, update last visit, replace the plan when it changed. */
export async function confirmNote(
  sessionId: string,
  cols: NoteColumns,
  items: PlanItemInput[],
  replacePlan: boolean,
  now = new Date(),
): Promise<ConfirmResult> {
  const { error } = await db().rpc("confirm_session_note", {
    p_session_id: sessionId,
    p_note: cols,
    p_items: items,
    p_replace_plan: replacePlan,
    p_start_date: clinicToday(now).date,
  });
  if (!error) return "saved";
  if (error.message.includes("already_confirmed")) return "already_confirmed";
  if (error.message.includes("draft_not_found")) return "not_found";
  throw new Error(`notes: could not confirm: ${error.message}`);
}
