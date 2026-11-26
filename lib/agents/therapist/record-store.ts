import "server-only";
import { clinicToday } from "@/lib/agents/patient/time";
import { db } from "@/lib/db/server";
import type { ActivityLog, ExerciseLog, Patient, PlanItem, Session } from "@/lib/db/types";
import { describePlanItem } from "./note-draft";
import { noteText } from "./prep-format";
import type { RecordData } from "./record-format";

// Reads a patient's whole record for "ask about a patient" (and Flow F): confirmed notes and
// evaluation only, every plan, the patient's logs. Writes nothing.

const clinicDate = (ts: string) => clinicToday(new Date(ts)).date;

export async function loadRecord(patient: Patient, now = new Date()): Promise<RecordData> {
  const [notesRes, evalRes, plansRes, actsRes] = await Promise.all([
    db()
      .from("sessions")
      .select("session_at, subjective, objective, assessment, plan_text, pain_nprs")
      .eq("patient_id", patient.id)
      .eq("status", "confirmed")
      .order("session_at", { ascending: false })
      .limit(25),
    db()
      .from("initial_evaluations")
      .select("confirmed_at, data")
      .eq("patient_id", patient.id)
      .eq("status", "confirmed")
      .order("confirmed_at", { ascending: false })
      .limit(1),
    db().from("plans").select("id, start_date, end_date").eq("patient_id", patient.id).order("start_date"),
    db()
      .from("activity_logs")
      .select("activity, duration_min, pain_nprs, pain_location, onset_min, red_flag, comment, logged_at")
      .eq("patient_id", patient.id)
      .order("logged_at", { ascending: false })
      .limit(60),
  ]);
  for (const [name, res] of [["notes", notesRes], ["evaluation", evalRes], ["plans", plansRes], ["activities", actsRes]] as const) {
    if (res.error) throw new Error(`record: could not load ${name}: ${res.error.message}`);
  }

  const plans = (plansRes.data ?? []) as { id: string; start_date: string; end_date: string | null }[];
  let items: PlanItem[] = [];
  if (plans.length) {
    const { data, error } = await db().from("plan_items").select("*").in("plan_id", plans.map((p) => p.id)).order("position");
    if (error) throw new Error(`record: could not load plan items: ${error.message}`);
    items = data as PlanItem[];
  }

  const exercises = items.filter((i) => i.type === "exercise");
  let exerciseLogs: ExerciseLog[] = [];
  if (exercises.length) {
    const { data, error } = await db()
      .from("exercise_logs")
      .select("plan_item_id, log_date, done, comment")
      .eq("patient_id", patient.id)
      .gte("log_date", plans[0].start_date)
      .order("log_date", { ascending: false })
      .limit(2000);
    if (error) throw new Error(`record: could not load exercise logs: ${error.message}`);
    exerciseLogs = data as ExerciseLog[];
  }

  const sessions = (notesRes.data ?? []) as Pick<Session, "session_at" | "subjective" | "objective" | "assessment" | "plan_text" | "pain_nprs">[];
  const evaluation = evalRes.data?.[0] as { confirmed_at: string | null; data: Record<string, unknown> | null } | undefined;

  return {
    today: clinicToday(now).date,
    patient: {
      full_name: patient.full_name,
      diagnosis: patient.diagnosis,
      intake_reason: patient.intake_reason,
      referring_doctor: patient.referring_doctor,
      dob: patient.dob,
      sex: patient.sex,
    },
    evaluation: evaluation?.confirmed_at && evaluation.data ? { date: clinicDate(evaluation.confirmed_at), data: evaluation.data } : null,
    notes: sessions.map((s) => ({ date: clinicDate(s.session_at), pain: s.pain_nprs, text: noteText(s) })),
    plans: plans.map((p) => ({
      start: p.start_date,
      end: p.end_date,
      lines: items.filter((i) => i.plan_id === p.id).map((i) => describePlanItem(i)),
    })),
    exerciseLogs,
    items: exercises.map((i) => ({ id: i.id, name: i.name })),
    activities: (actsRes.data ?? []) as ActivityLog[],
  };
}
