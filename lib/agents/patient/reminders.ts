import "server-only";
import { db } from "@/lib/db/server";
import type { Patient, Reminder } from "@/lib/db/types";
import { loadState, saveState } from "@/lib/router/state";
import { sendOptions, sendTemplate } from "@/lib/whatsapp/send";
import { STATUS_OPTIONS, freshContext } from "./checkin";
import { clinicTimeToUtc, clinicToday } from "./time";

// P-2 reminder scheduler. Owner: Person 3.
// Called every 15 minutes (app/api/cron/reminders). Two steps:
//   1. schedule: one "exercise_reminder" row per opted-in patient who has exercises today,
//      due at their reminder_time (clinic time). Idempotent.
//   2. send: claim each due row (scheduled -> sent) and send it, so overlapping runs never
//      double-send. Rows more than STALE_MS late are cancelled instead of sent.
// Patient replies are handled by the check-in flow (Todos / Algunos / Hoy no).

const TEMPLATE_NAME = "exercise_reminder";
const STALE_MS = 2 * 60 * 60 * 1000;

export interface ReminderRun {
  scheduled: number;
  sent: number;
  failed: number;
  stale: number;
}

export async function runReminders(now = new Date()): Promise<ReminderRun> {
  const scheduled = await scheduleToday(now);
  return { scheduled, ...(await sendDue(now)) };
}

/** Patients who should get a reminder: consented, opted in, with a time and a phone. */
async function remindablePatients(): Promise<Patient[]> {
  const { data, error } = await db()
    .from("patients")
    .select("*")
    .eq("status", "active")
    .eq("reminders_opt_in", true)
    .not("consent_at", "is", null)
    .not("reminder_time", "is", null)
    .not("phone", "is", null);
  if (error) throw new Error(`reminders: could not load patients: ${error.message}`);
  return data as Patient[];
}

async function scheduleToday(now: Date): Promise<number> {
  const { date } = clinicToday(now);
  let created = 0;
  for (const patient of await remindablePatients()) {
    const dueAt = clinicTimeToUtc(date, patient.reminder_time!).toISOString();
    const { data: existing, error: exErr } = await db()
      .from("reminders")
      .select("id")
      .eq("patient_id", patient.id)
      .eq("template_name", TEMPLATE_NAME)
      .eq("due_at", dueAt)
      .limit(1);
    if (exErr) throw new Error(`reminders: lookup failed: ${exErr.message}`);
    if (existing && existing.length > 0) continue;
    const context = await freshContext(patient);
    if (context.items.length === 0) continue; // nothing to remind about today
    const { error } = await db().from("reminders").insert({ patient_id: patient.id, due_at: dueAt, template_name: TEMPLATE_NAME });
    if (error) throw new Error(`reminders: insert failed: ${error.message}`);
    created++;
  }
  return created;
}

async function sendDue(now: Date): Promise<Omit<ReminderRun, "scheduled">> {
  const result = { sent: 0, failed: 0, stale: 0 };
  const { data, error } = await db()
    .from("reminders")
    .select("*")
    .eq("status", "scheduled")
    .lte("due_at", now.toISOString())
    .order("due_at");
  if (error) throw new Error(`reminders: could not load due reminders: ${error.message}`);

  for (const reminder of data as Reminder[]) {
    if (now.getTime() - new Date(reminder.due_at).getTime() > STALE_MS) {
      await setStatus(reminder.id, "cancelled");
      result.stale++;
      continue;
    }
    // Claim it first: only one run can move it from scheduled to sent.
    const { data: claimed } = await db()
      .from("reminders")
      .update({ status: "sent", sent_at: now.toISOString() })
      .eq("id", reminder.id)
      .eq("status", "scheduled")
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    try {
      const delivered = await deliver(reminder.patient_id);
      if (delivered) result.sent++;
      else {
        await setStatus(reminder.id, "cancelled");
        result.stale++;
      }
    } catch (err) {
      console.error("[reminders] send failed", reminder.id, err);
      await setStatus(reminder.id, "failed");
      result.failed++;
    }
  }
  return result;
}

/** Send today's reminder to one patient. False if they no longer qualify. */
async function deliver(patientId: string): Promise<boolean> {
  const { data: patient } = await db().from("patients").select("*").eq("id", patientId).maybeSingle<Patient>();
  if (!patient?.phone || !patient.reminders_opt_in || !patient.consent_at) return false;
  const context = await freshContext(patient);
  if (context.items.length === 0) return false;

  const firstName = patient.full_name.split(" ")[0];
  const template = process.env.TWILIO_TEMPLATE_REMINDER;
  if (template) {
    // Template variables can't hold line breaks, so the list is one line.
    await sendTemplate(patient.phone, template, { "1": firstName, "2": context.items.map((i) => i.label).join("; ") });
  } else {
    // Plain text only arrives inside the patient's 24 h window (dev and the simulator).
    const list = context.items.map((i) => `• ${i.label}`).join("\n");
    await sendOptions(patient.phone, `Hola, ${firstName}. Es hora de tus ejercicios de hoy:\n\n${list}\n\n¿Cómo te fue?`, STATUS_OPTIONS);
  }

  // Let a numbered reply ("2") count as "Algunos" for the next 30 minutes, unless the
  // patient is already in the middle of something.
  if (!(await loadState(patient.phone))) {
    await saveState(patient.phone, "patient", { flow: "checkin", step: "awaiting_status", context });
  }
  return true;
}

async function setStatus(id: string, status: Reminder["status"]): Promise<void> {
  const { error } = await db().from("reminders").update({ status }).eq("id", id);
  if (error) console.error("[reminders] could not update status", id, status, error.message);
}
