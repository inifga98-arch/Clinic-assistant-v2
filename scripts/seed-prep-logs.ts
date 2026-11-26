// Synthetic patient logs for testing and demoing Flow E (prepare a session).
//
//   npm run seed-prep                          Laura Méndez Ruiz (+52 55 0000 9102)
//   npm run seed-prep -- --phone +5215500009101   another test patient
//   npm run seed-prep -- --flag                also log one red-flag activity
//
// Only test patients (+52 1 55 0000 9xxx). When the patient has no confirmed note with a home
// plan yet, it first writes a synthetic one dated 4 days ago by Terapeuta Simulador (confirmed
// notes are locked, so a note made today in the simulator would leave no days to log). Exercise
// logs are upserted (one per exercise per day), activity logs replace the previous seeded ones,
// so it can run again.

import { clinicToday } from "@/lib/agents/patient/time";
import { prepWindow } from "@/lib/agents/therapist/prep-logic";
import { db } from "@/lib/db/server";
import type { PlanItem } from "@/lib/db/types";

const SEED_MARK = "Registro de prueba (seed-prep).";
const SEED_TAG = "seed-prep";
const args = process.argv.slice(2);
const phone = args.includes("--phone") ? args[args.indexOf("--phone") + 1] : "+5215500009102";
const withFlag = args.includes("--flag");

async function main() {
  if (!/^\+5215500009\d{3}$/.test(phone)) throw new Error(`only test patients (+5215500009xxx), not ${phone}`);
  const { data: patient, error } = await db().from("patients").select("id, full_name").eq("phone", phone).maybeSingle();
  if (error || !patient) throw new Error(`no patient with phone ${phone}`);

  const lastNote = async () => {
    const { data: session, error: sErr } = await db()
      .from("sessions")
      .select("session_at")
      .eq("patient_id", patient.id)
      .eq("status", "confirmed")
      .order("session_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: plan, error: pErr } = await db().from("plans").select("id").eq("patient_id", patient.id).eq("status", "active").maybeSingle();
    if (sErr || pErr) throw new Error((sErr ?? pErr)!.message);
    return { session, plan };
  };
  let { session, plan } = await lastNote();
  if (!session || !plan) {
    if (session || plan) throw new Error(`${patient.full_name} has a note or a plan but not both; add a note with a plan in the simulator`);
    await writeTestNote(patient.id);
    ({ session, plan } = await lastNote());
    if (!session || !plan) throw new Error("could not write the test note");
  }

  const { data: itemRows } = await db().from("plan_items").select("*").eq("plan_id", plan.id).order("position");
  const exercises = ((itemRows ?? []) as PlanItem[]).filter((i) => i.type === "exercise");
  const today = clinicToday().date;
  const { days } = prepWindow(clinicToday(new Date(session.session_at)).date, today);
  if (!days.length) {
    throw new Error("the last confirmed note is from today or yesterday: the brief has no full days to show logs for yet");
  }

  // A realistic week: full days, a day the hardest exercise was skipped with a comment, a day with no answer.
  const rows = days.flatMap((day, i) => {
    const kind = i % 4; // 0 all done, 1 first skipped, 2 no answer, 3 all done
    if (kind === 2) return [];
    return exercises.map((item, j) => {
      const done = !(kind === 1 && j === 0);
      return {
        patient_id: patient.id,
        plan_item_id: item.id,
        log_date: day,
        done,
        pain_nprs: done ? (kind === 1 ? 4 : 2) : null,
        // On the done rows, as the patient check-in saves it (checkin.ts).
        comment: done && kind === 1 ? `${exercises[0].name.toLowerCase()} me costó mucho` : null,
      };
    });
  });
  if (rows.length) {
    const { error: e } = await db().from("exercise_logs").upsert(rows, { onConflict: "plan_item_id,log_date" });
    if (e) throw new Error(e.message);
  }

  // Seeded rows are marked in pain_duration (never shown); older runs marked the comment.
  // Two plain deletes: an or() filter with the mark's spaces and brackets silently matched nothing.
  for (const del of [
    db().from("activity_logs").delete().eq("patient_id", patient.id).eq("pain_duration", SEED_TAG),
    db().from("activity_logs").delete().eq("patient_id", patient.id).like("comment", `%${SEED_MARK}%`),
  ]) {
    const { error: dErr } = await del;
    if (dErr) throw new Error(dErr.message);
  }
  const at = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00-06:00`).toISOString();
  const last = days[days.length - 1];
  type Act = { activity: string; duration_min: number | null; pain_nprs: number | null; pain_location: string | null; onset_min: number | null; red_flag: boolean; logged_at: string };
  const acts: Act[] = [
    { activity: "correr", duration_min: 25, pain_nprs: 5, pain_location: "frente de la rodilla", onset_min: 20, red_flag: false, logged_at: at(last, 19) },
    { activity: "subir escaleras", duration_min: null, pain_nprs: 2, pain_location: null, onset_min: null, red_flag: false, logged_at: at(days[0], 9) },
  ];
  if (withFlag) {
    acts.push({ activity: "correr", duration_min: 10, pain_nprs: 8, pain_location: "rodilla", onset_min: null, red_flag: true, logged_at: at(last, 20) });
  }
  const { error: aErr } = await db()
    .from("activity_logs")
    .insert(
      acts.map((a) => ({
        ...a,
        patient_id: patient.id,
        pain_duration: SEED_TAG,
        comment: a.red_flag ? "La rodilla se inflamó y no puede apoyar." : null,
      })),
    );
  if (aErr) throw new Error(aErr.message);

  console.log(`${patient.full_name}: ${rows.length} exercise logs over ${days.length} days, ${acts.length} activities${withFlag ? " (1 red flag)" : ""}.`);
}

/** A synthetic confirmed note 4 days ago with a home plan, by Terapeuta Simulador. */
async function writeTestNote(patientId: string) {
  const { data: therapist, error: tErr } = await db().from("therapists").select("id").eq("phone", "+5215500009999").maybeSingle();
  if (tErr || !therapist) throw new Error("Terapeuta Simulador (+5215500009999) not found");
  const sessionAt = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  sessionAt.setUTCHours(17, 0, 0, 0); // 11:00 in Mexico City
  const { data: session, error } = await db()
    .from("sessions")
    .insert({
      patient_id: patientId,
      therapist_id: therapist.id,
      session_at: sessionAt.toISOString(),
      subjective: "Refiere menos dolor al subir escaleras; molestia al correr más de 20 minutos.",
      objective: {
        rom: [{ joint: "rodilla derecha", movement: "flexión", degrees: 115 }],
        strength: [{ muscle: "cuádriceps derecho", grade_0_5: 4 }],
        special_tests: ["Clarke positivo"],
        treatment_given: ["terapia manual", "fortalecimiento de cuádriceps"],
      },
      assessment: "Evolución favorable; persiste déficit de fuerza de cuádriceps.",
      plan_text: [
        "2 visitas/semana. Próxima sesión: fuerza de cuádriceps.",
        "Plan en casa:",
        "1. Sentadilla en pared 3×10, diario",
        "2. Elevación de pierna recta 3×12, diario",
        "3. Correr, 3×/semana",
      ].join("\n"),
      pain_nprs: 3,
      missing_fields: [],
      status: "confirmed",
      confirmed_at: sessionAt.toISOString(),
      source_transcript: SEED_MARK,
    })
    .select("id")
    .single();
  if (error || !session) throw new Error(`test note: ${error?.message}`);
  const start = clinicToday(sessionAt).date;
  const { data: plan, error: pErr } = await db()
    .from("plans")
    .insert({ patient_id: patientId, session_id: session.id, start_date: start, status: "active" })
    .select("id")
    .single();
  if (pErr || !plan) throw new Error(`test plan: ${pErr?.message}`);
  const item = (position: number, type: "exercise" | "activity", name: string, sets: number | null, reps: number | null, frequency: number) => ({
    plan_id: plan.id, type, name, sets, reps, hold_seconds: null, frequency_per_week: frequency, days_of_week: null, instructions: null, position,
  });
  const { error: iErr } = await db().from("plan_items").insert([
    item(1, "exercise", "Sentadilla en pared", 3, 10, 7),
    item(2, "exercise", "Elevación de pierna recta", 3, 12, 7),
    item(3, "activity", "Correr", null, null, 3),
  ]);
  if (iErr) throw new Error(`test plan items: ${iErr.message}`);
  await db().from("patients").update({ last_visit_at: sessionAt.toISOString() }).eq("id", patientId);
  console.log(`Wrote a test note (${start}) with a home plan.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
