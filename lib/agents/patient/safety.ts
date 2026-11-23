import "server-only";
import { db } from "@/lib/db/server";
import type { Patient, Therapist } from "@/lib/db/types";
import { sendText } from "@/lib/whatsapp/send";
import { RED_FLAG_LABELS, painScoreIn, type RedFlag } from "./signals";

// Patient safety actions. Owner: Person 3.
// P-8 opt-out ("parar") and P-6 red flags (advise, 911, alert the therapist).

/**
 * P-8: stop reminders for good. Turns off the opt-in and cancels anything already scheduled.
 * Logging stays open: the patient can still write to us any time.
 */
export async function handleOptOut(patient: Patient, phone: string): Promise<void> {
  const { error: pErr } = await db()
    .from("patients")
    .update({ reminders_opt_in: false })
    .eq("id", patient.id);
  if (pErr) throw new Error(`handleOptOut(patient): ${pErr.message}`);

  const { error: rErr } = await db()
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("patient_id", patient.id)
    .eq("status", "scheduled");
  if (rErr) throw new Error(`handleOptOut(reminders): ${rErr.message}`);

  await sendText(
    phone,
    "Listo, ya no te enviaré recordatorios. " +
      "Si quieres, puedes seguir escribiéndome cuando hagas tus ejercicios o actividades.",
  );
}

/**
 * P-6: the patient described a red flag. Save it to their record (so the CRM and the next
 * session prep show it), alert the assigned therapist, and tell the patient to contact the
 * clinic, with 911 for emergencies. Never gives clinical advice (X-4).
 */
export async function handleRedFlag(
  patient: Patient,
  phone: string,
  text: string,
  flags: RedFlag[],
  pain: number | null = painScoreIn(text),
): Promise<void> {
  const firstName = patient.full_name.split(" ")[0];

  // Record first: even if a send fails, the flag is in the patient's timeline.
  const { error } = await db().from("activity_logs").insert({
    patient_id: patient.id,
    activity: "Reporte del paciente",
    pain_nprs: pain,
    comment: text.slice(0, 1000),
    red_flag: true,
  });
  if (error) console.error("[patient] could not save red flag", patient.id, error.message);

  const therapist = await assignedTherapist(patient);
  const alerted = therapist ? await alertTherapist(therapist, patient, text, flags) : false;

  const who = alerted && therapist ? `Ya le avisé a ${therapist.full_name.split(" ")[0]}.` : "";
  await sendText(
    phone,
    `Gracias por avisarme, ${firstName}. Por lo que me cuentas, es mejor que lo revise tu ` +
      `terapeuta: comunícate hoy con la clínica. Si es una emergencia, llama al 911. ${who}`.trim(),
  );
}

async function assignedTherapist(patient: Patient): Promise<Therapist | null> {
  if (!patient.assigned_therapist_id) return null;
  const { data, error } = await db()
    .from("therapists")
    .select("*")
    .eq("id", patient.assigned_therapist_id)
    .eq("active", true)
    .maybeSingle<Therapist>();
  if (error) {
    console.error("[patient] could not load therapist", patient.assigned_therapist_id, error.message);
    return null;
  }
  return data;
}

/**
 * T-12: push the alert to the therapist's WhatsApp. Returns false if it could not be sent.
 *
 * TODO(Person 3): free text only reaches the therapist inside their 24 h window. Outside it
 * this send fails; switch to an approved alert template once one exists.
 */
async function alertTherapist(
  therapist: Therapist,
  patient: Patient,
  text: string,
  flags: RedFlag[],
): Promise<boolean> {
  if (!therapist.phone) return false;
  const signs = flags.map((f) => RED_FLAG_LABELS[f]).join(", ");
  const quote = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  try {
    await sendText(
      therapist.phone,
      `⚠️ Alerta de ${patient.full_name}\nSeñales: ${signs}\nMensaje: «${quote}»\n` +
        "Le pedí que contacte a la clínica. Revisa y comunícate con el paciente.",
    );
    return true;
  } catch (err) {
    console.error("[patient] red-flag alert to therapist failed", therapist.id, err);
    return false;
  }
}
