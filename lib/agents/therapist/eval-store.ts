import "server-only";
import type { EvaluationExtraction } from "@/lib/ai/intake-schema";
import { db } from "@/lib/db/server";
import type { InitialEvaluation, Patient } from "@/lib/db/types";
import { patientFieldsToFill, type EvalDraft, type EvalInput } from "./intake-logic";

// Flow A storage for the initial evaluation. The draft lives in initial_evaluations.draft until
// it is confirmed; atomic writes go through supabase/migrations/0003_initial_evaluations.sql.

export type { EvalDraft, EvalInput, EvalStep } from "./intake-logic";

const EMPTY: EvalDraft = { inputs: [], extraction: null, step: "choose_source", source: null };

export interface LoadedEval {
  row: InitialEvaluation;
  draft: EvalDraft;
  patient: Patient;
}

export async function createEvalDraft(therapistId: string, patientId: string): Promise<string> {
  const { data, error } = await db()
    .from("initial_evaluations")
    .insert({ therapist_id: therapistId, patient_id: patientId, status: "draft", draft: EMPTY })
    .select("id")
    .single();
  if (error) throw new Error(`evaluations: could not create draft: ${error.message}`);
  return data.id as string;
}

/** The open draft with its patient, or null when it was confirmed or discarded meanwhile. */
export async function loadEvalDraft(id: string): Promise<LoadedEval | null> {
  const { data: row, error } = await db().from("initial_evaluations").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`evaluations: could not load: ${error.message}`);
  if (!row || row.status !== "draft") return null;
  const { data: patient, error: pErr } = await db().from("patients").select("*").eq("id", row.patient_id).single();
  if (pErr) throw new Error(`evaluations: could not load patient: ${pErr.message}`);
  return {
    row: row as InitialEvaluation,
    draft: { ...EMPTY, ...((row.draft as Partial<EvalDraft> | null) ?? {}) },
    patient: patient as Patient,
  };
}

/** Add a page or a note; returns how many inputs the draft has now. Safe for simultaneous photos. */
export async function appendEvalInput(id: string, input: EvalInput): Promise<number> {
  const { data, error } = await db().rpc("append_evaluation_input", { p_id: id, p_entry: input });
  if (error) throw new Error(`evaluations: could not add input: ${error.message}`);
  return data as number;
}

/** Merge fields into the draft. Never touches inputs (only appendEvalInput does). */
export async function setEvalFields(id: string, fields: Partial<Omit<EvalDraft, "inputs">>): Promise<void> {
  const { error } = await db().rpc("set_evaluation_fields", { p_id: id, p_fields: fields });
  if (error) throw new Error(`evaluations: could not update draft: ${error.message}`);
}

/** Also sets the source column, so the CRM can tell photo from voice. */
export async function setEvalSource(id: string, source: "photo" | "voice"): Promise<void> {
  const { error } = await db().from("initial_evaluations").update({ source }).eq("id", id).eq("status", "draft");
  if (error) throw new Error(`evaluations: could not set source: ${error.message}`);
  await setEvalFields(id, { source });
}

export async function deleteEvalDraft(id: string): Promise<void> {
  const { error } = await db().from("initial_evaluations").delete().eq("id", id).eq("status", "draft");
  if (error) throw new Error(`evaluations: could not discard: ${error.message}`);
}

export async function evalStatus(id: string): Promise<"draft" | "confirmed" | null> {
  const { data, error } = await db().from("initial_evaluations").select("status").eq("id", id).maybeSingle();
  if (error) throw new Error(`evaluations: could not read status: ${error.message}`);
  return (data?.status as "draft" | "confirmed" | undefined) ?? null;
}

/** Lock the evaluation and fill the patient's empty fields, in one transaction. */
export async function confirmEvaluation(
  id: string,
  e: EvaluationExtraction,
  meta: { source_transcript: string | null; page_count: number | null; patient_name: string },
): Promise<"saved" | "already_confirmed" | "not_found"> {
  const { error } = await db().rpc("confirm_initial_evaluation", {
    p_id: id,
    p_eval: { data: e, source_transcript: meta.source_transcript, page_count: meta.page_count },
    p_patient: patientFieldsToFill(e, meta.patient_name), // nothing when the form names another person
  });
  if (!error) return "saved";
  if (error.message.includes("already_confirmed")) return "already_confirmed";
  if (error.message.includes("draft_not_found")) return "not_found";
  throw new Error(`evaluations: could not confirm: ${error.message}`);
}

/** The therapist's open evaluation drafts (to clean up abandoned ones and their photos). */
export async function openEvalDrafts(therapistId: string): Promise<{ id: string; draft: EvalDraft }[]> {
  const { data, error } = await db()
    .from("initial_evaluations")
    .select("id, draft")
    .eq("therapist_id", therapistId)
    .eq("status", "draft");
  if (error) throw new Error(`evaluations: could not list drafts: ${error.message}`);
  return data.map((r) => ({ id: r.id as string, draft: { ...EMPTY, ...((r.draft as Partial<EvalDraft> | null) ?? {}) } }));
}
