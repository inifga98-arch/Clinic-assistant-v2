import type { NoteDraft } from "@/lib/agents/therapist/note-draft";
// Row types for supabase/migrations/0001_init.sql. Shared by every component: change by PR.
// Hand-written for now; can be replaced with `supabase gen types typescript` later.

export type Uuid = string;
export type Timestamp = string; // ISO 8601
export type DateString = string; // YYYY-MM-DD

export interface Clinic {
  id: Uuid;
  name: string;
  address: string | null;
  whatsapp_number: string | null;
  created_at: Timestamp;
}

export interface Therapist {
  id: Uuid;
  clinic_id: Uuid;
  full_name: string;
  license_no: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
  created_at: Timestamp;
}

export interface Patient {
  id: Uuid;
  clinic_id: Uuid;
  full_name: string;
  phone: string | null;
  email: string | null;
  dob: DateString | null;
  sex: "female" | "male" | "other" | null;
  diagnosis: string | null;
  referring_doctor: string | null;
  assigned_therapist_id: Uuid | null;
  status: "active" | "discharged";
  first_visit_at: Timestamp | null;
  last_visit_at: Timestamp | null;
  reminder_time: string | null; // HH:MM:SS, clinic local time
  consent_at: Timestamp | null;
  reminders_opt_in: boolean;
  created_at: Timestamp;
}

export interface SoapObjective {
  rom: { joint: string; movement: string; degrees: number }[];
  strength: { muscle: string; grade_0_5: number }[];
  special_tests: string[];
  treatment_given: string[];
}

export interface Session {
  id: Uuid;
  patient_id: Uuid;
  therapist_id: Uuid;
  session_at: Timestamp;
  subjective: string | null;
  objective: SoapObjective | null;
  assessment: string | null;
  plan_text: string | null;
  pain_nprs: number | null;
  missing_fields: string[];
  status: "draft" | "confirmed";
  confirmed_at: Timestamp | null;
  source_transcript: string | null;
  source_audio_url: string | null;
  /** Working note while status is 'draft' (Flow B); null once confirmed. */
  draft: NoteDraft | null;
  created_at: Timestamp;
}

export interface SessionAddendum {
  id: Uuid;
  session_id: Uuid;
  therapist_id: Uuid;
  text: string;
  created_at: Timestamp;
}

export interface Plan {
  id: Uuid;
  patient_id: Uuid;
  session_id: Uuid | null;
  start_date: DateString;
  end_date: DateString | null;
  status: "active" | "superseded";
  created_at: Timestamp;
}

export interface PlanItem {
  id: Uuid;
  plan_id: Uuid;
  type: "exercise" | "activity";
  name: string;
  sets: number | null;
  reps: number | null;
  hold_seconds: number | null;
  frequency_per_week: number | null;
  days_of_week: number[] | null; // 0 = Sunday
  instructions: string | null;
  position: number;
  created_at: Timestamp;
}

export interface ExerciseLog {
  id: Uuid;
  patient_id: Uuid;
  plan_item_id: Uuid;
  log_date: DateString;
  done: boolean;
  pain_nprs: number | null;
  comment: string | null;
  created_at: Timestamp;
}

export interface ActivityLog {
  id: Uuid;
  patient_id: Uuid;
  plan_item_id: Uuid | null;
  activity: string;
  duration_min: number | null;
  pain_nprs: number | null;
  pain_location: string | null;
  onset_min: number | null;
  pain_duration: string | null;
  comment: string | null;
  red_flag: boolean;
  logged_at: Timestamp;
}

export interface Reminder {
  id: Uuid;
  patient_id: Uuid;
  due_at: Timestamp;
  template_name: string;
  status: "scheduled" | "sent" | "answered" | "failed" | "cancelled";
  sent_at: Timestamp | null;
  created_at: Timestamp;
}

export interface Conversation {
  phone: string;
  role: "therapist" | "patient";
  current_flow: string | null;
  step: string | null;
  context: Record<string, unknown>;
  updated_at: Timestamp;
}

export interface MessageRow {
  id: Uuid;
  twilio_sid: string | null;
  phone: string;
  direction: "in" | "out";
  body: string | null;
  media_url: string | null;
  media_type: string | null;
  created_at: Timestamp;
}
