import "server-only";
import { clinicToday } from "@/lib/agents/patient/time";
import { db } from "@/lib/db/server";
import type { ActivityLog, ExerciseLog, Patient, PlanItem, Session } from "@/lib/db/types";
import { describePlanItem } from "./note-draft";
import { noteText, planHeadlineOf, type PrepData } from "./prep-format";
import { activityLines, exerciseSummary, prepWindow } from "./prep-logic";

// Flow E reads (T-10): confirmed notes and evaluations only, the active plan, and the
// patient's own logs since the last session. Writes nothing.

const clinicDate = (ts: string) => clinicToday(new Date(ts)).date;

export async function loadPrepData(patient: Patient, now = new Date()): Promise<PrepData> {
  const today = clinicToday(now).date;

  const [{ data: sessions, error: sErr }, { data: evals, error: eErr }, { data: plan, error: pErr }] = await Promise.all([
    db()
      .from("sessions")
      .select("session_at, subjective, objective, assessment, plan_text, pain_nprs")
      .eq("patient_id", patient.id)
      .eq("status", "confirmed")
      .order("session_at", { ascending: false })
      .limit(1),
    db()
      .from("initial_evaluations")
      .select("confirmed_at")
      .eq("patient_id", patient.id)
      .eq("status", "confirmed")
      .order("confirmed_at", { ascending: false })
      .limit(1),
    db().from("plans").select("id").eq("patient_id", patient.id).eq("status", "active").maybeSingle(),
  ]);
  if (sErr) throw new Error(`prep: could not load sessions: ${sErr.message}`);
  if (eErr) throw new Error(`prep: could not load evaluations: ${eErr.message}`);
  if (pErr) throw new Error(`prep: could not load plan: ${pErr.message}`);

  const last = (sessions?.[0] ?? null) as Pick<Session, "session_at" | "subjective" | "objective" | "assessment" | "plan_text" | "pain_nprs"> | null;
  const lastDate = last ? clinicDate(last.session_at) : null;
  const window = prepWindow(lastDate, today);

  let items: PlanItem[] = [];
  if (plan) {
    const { data, error } = await db().from("plan_items").select("*").eq("plan_id", plan.id).order("position");
    if (error) throw new Error(`prep: could not load plan items: ${error.message}`);
    items = data as PlanItem[];
  }
  const exercises = items.filter((i) => i.type === "exercise");

  let exerciseLogs: ExerciseLog[] = [];
  if (window.days.length && exercises.length) {
    const { data, error } = await db()
      .from("exercise_logs")
      .select("plan_item_id, log_date, done, comment")
      .eq("patient_id", patient.id)
      .in("plan_item_id", exercises.map((i) => i.id))
      .gte("log_date", window.days[0])
      .lte("log_date", window.days[window.days.length - 1]);
    if (error) throw new Error(`prep: could not load exercise logs: ${error.message}`);
    exerciseLogs = data as ExerciseLog[];
  }

  // Activities since the last session (or since registration when there is none yet).
  const { data: acts, error: aErr } = await db()
    .from("activity_logs")
    .select("activity, duration_min, pain_nprs, pain_location, onset_min, red_flag, comment, logged_at")
    .eq("patient_id", patient.id)
    .gt("logged_at", last?.session_at ?? patient.created_at)
    .order("logged_at", { ascending: false })
    .limit(50);
  if (aErr) throw new Error(`prep: could not load activity logs: ${aErr.message}`);

  return {
    patientName: patient.full_name,
    diagnosis: patient.diagnosis,
    intakeReason: patient.intake_reason,
    lastSession: last
      ? { date: lastDate!, pain: last.pain_nprs, text: noteText(last), headline: planHeadlineOf(last.plan_text) }
      : null,
    evaluationDate: evals?.[0]?.confirmed_at ? clinicDate(evals[0].confirmed_at) : null,
    planLines: items.map((i) => describePlanItem(i)),
    days: window.days.length,
    exercises: exercises.length ? exerciseSummary(window.days, exerciseLogs, exercises) : null,
    activities: activityLines((acts ?? []) as ActivityLog[]),
  };
}
