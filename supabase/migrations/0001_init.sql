-- Bitácora schema v0.1 (PRD "Data model").
-- Owner: Person 1. Never edit this file once applied; add a new migration instead.
-- Server code writes with the service-role key (bypasses RLS). The CRM reads as the
-- logged-in staff member, and RLS limits them to their own clinic.

-- ---------------------------------------------------------------- clinic and people

create table clinics (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  address          text,
  whatsapp_number  text,                    -- E.164, the clinic's agent number
  created_at       timestamptz not null default now()
);

create table therapists (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references clinics(id),
  full_name   text not null,
  license_no  text,                         -- cédula profesional, printed on the PDF
  phone       text unique,                  -- E.164, how the router recognises a therapist
  email       text unique,                  -- CRM login (Supabase Auth magic link)
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table patients (
  id                     uuid primary key default gen_random_uuid(),
  clinic_id              uuid not null references clinics(id),
  full_name              text not null,
  phone                  text unique,       -- E.164; how the router recognises a patient
  email                  text,
  dob                    date,
  sex                    text check (sex in ('female', 'male', 'other')),
  diagnosis              text,
  referring_doctor       text,
  assigned_therapist_id  uuid references therapists(id),
  status                 text not null default 'active' check (status in ('active', 'discharged')),
  first_visit_at         timestamptz,
  last_visit_at          timestamptz,      -- updated on each confirmed note
  reminder_time          time,             -- local clinic time (America/Mexico_City)
  consent_at             timestamptz,      -- accepted the privacy notice
  reminders_opt_in       boolean not null default false,
  created_at             timestamptz not null default now()
);
create index patients_clinic_idx on patients (clinic_id);
create index patients_therapist_idx on patients (assigned_therapist_id, last_visit_at desc);

-- ---------------------------------------------------------------- clinical record

create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references patients(id),
  therapist_id       uuid not null references therapists(id),
  session_at         timestamptz not null default now(),
  subjective         text,
  objective          jsonb,               -- rom, strength, special_tests, treatment_given
  assessment         text,
  plan_text          text,
  pain_nprs          smallint check (pain_nprs between 0 and 10),
  missing_fields     text[] not null default '{}',  -- required fields saved as gaps (T-5)
  status             text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_at       timestamptz,
  source_transcript  text,
  source_audio_url   text,
  created_at         timestamptz not null default now(),
  check (status = 'draft' or confirmed_at is not null)
);
create index sessions_patient_idx on sessions (patient_id, session_at desc);

-- Confirmed notes are locked: corrections go in session_addenda.
create or replace function sessions_lock_confirmed() returns trigger
language plpgsql as $$
begin
  if old.status = 'confirmed' then
    raise exception 'session % is confirmed and locked; add an addendum instead', old.id;
  end if;
  -- In a BEFORE DELETE trigger NEW is null, and returning null would silently cancel it.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger sessions_lock_confirmed
  before update or delete on sessions
  for each row execute function sessions_lock_confirmed();

create table session_addenda (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id),
  therapist_id  uuid not null references therapists(id),
  text          text not null,
  created_at    timestamptz not null default now()
);
create index session_addenda_session_idx on session_addenda (session_id);

-- ---------------------------------------------------------------- home plan

create table plans (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references patients(id),
  session_id  uuid references sessions(id),
  start_date  date not null default current_date,
  end_date    date,
  status      text not null default 'active' check (status in ('active', 'superseded')),
  created_at  timestamptz not null default now()
);
-- Exactly one active plan per patient.
create unique index plans_one_active_idx on plans (patient_id) where status = 'active';

create table plan_items (
  id                  uuid primary key default gen_random_uuid(),
  plan_id             uuid not null references plans(id) on delete cascade,
  type                text not null check (type in ('exercise', 'activity')),
  name                text not null,
  sets                smallint,
  reps                smallint,
  hold_seconds        smallint,
  frequency_per_week  smallint check (frequency_per_week between 1 and 14),
  days_of_week        smallint[],          -- 0 = Sunday ... 6 = Saturday; null = any days
  instructions        text,
  position            smallint not null default 0,   -- order shown to the patient
  created_at          timestamptz not null default now()
);
create index plan_items_plan_idx on plan_items (plan_id, position);

-- ---------------------------------------------------------------- patient logs

create table exercise_logs (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references patients(id),
  plan_item_id  uuid not null references plan_items(id),
  log_date      date not null,
  done          boolean not null,
  pain_nprs     smallint check (pain_nprs between 0 and 10),
  comment       text,
  created_at    timestamptz not null default now(),
  unique (plan_item_id, log_date)           -- one row per item per day
);
create index exercise_logs_patient_idx on exercise_logs (patient_id, log_date desc);

create table activity_logs (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references patients(id),
  plan_item_id   uuid references plan_items(id),
  activity       text not null,
  duration_min   smallint,
  pain_nprs      smallint check (pain_nprs between 0 and 10),
  pain_location  text,
  onset_min      smallint,
  pain_duration  text,
  comment        text,
  red_flag       boolean not null default false,
  logged_at      timestamptz not null default now()
);
create index activity_logs_patient_idx on activity_logs (patient_id, logged_at desc);

create table reminders (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references patients(id),
  due_at         timestamptz not null,
  template_name  text not null,
  status         text not null default 'scheduled'
                 check (status in ('scheduled', 'sent', 'answered', 'failed', 'cancelled')),
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index reminders_due_idx on reminders (due_at) where status = 'scheduled';

-- ---------------------------------------------------------------- messaging

-- Router state for multi-turn flows, one row per phone. Expires after 30 min idle (app logic).
create table conversations (
  phone         text primary key,           -- E.164
  role          text not null check (role in ('therapist', 'patient')),
  current_flow  text,
  step          text,
  context       jsonb not null default '{}',
  updated_at    timestamptz not null default now()
);

-- Full message log. Unique twilio_sid makes webhook retries harmless.
create table messages (
  id          uuid primary key default gen_random_uuid(),
  twilio_sid  text unique,
  phone       text not null,                -- E.164 of the other party
  direction   text not null check (direction in ('in', 'out')),
  body        text,
  media_url   text,
  media_type  text,
  created_at  timestamptz not null default now()
);
create index messages_phone_idx on messages (phone, created_at desc);

-- ---------------------------------------------------------------- row level security

alter table clinics          enable row level security;
alter table therapists       enable row level security;
alter table patients         enable row level security;
alter table sessions         enable row level security;
alter table session_addenda  enable row level security;
alter table plans            enable row level security;
alter table plan_items       enable row level security;
alter table exercise_logs    enable row level security;
alter table activity_logs    enable row level security;
alter table reminders        enable row level security;
alter table conversations    enable row level security;  -- no policies: service role only
alter table messages         enable row level security;  -- no policies: service role only

-- The clinic of the logged-in staff member (matched by email to an active therapist).
create or replace function current_clinic_id() returns uuid
language sql stable security definer set search_path = public as $$
  select clinic_id from therapists
  where active and lower(email) = lower(auth.jwt() ->> 'email')
  limit 1
$$;
revoke all on function current_clinic_id() from public;
grant execute on function current_clinic_id() to authenticated;

create or replace function is_clinic_patient(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from patients where id = p and clinic_id = current_clinic_id())
$$;
revoke all on function is_clinic_patient(uuid) from public;
grant execute on function is_clinic_patient(uuid) to authenticated;

-- Read access for clinic staff. Writes go through server code (service role) for now;
-- Person 2 adds insert policies when the CRM gets edit features (e.g. addenda, C-8).
create policy staff_read on clinics         for select to authenticated using (id = current_clinic_id());
create policy staff_read on therapists      for select to authenticated using (clinic_id = current_clinic_id());
create policy staff_read on patients        for select to authenticated using (clinic_id = current_clinic_id());
create policy staff_read on sessions        for select to authenticated using (is_clinic_patient(patient_id));
create policy staff_read on plans           for select to authenticated using (is_clinic_patient(patient_id));
create policy staff_read on exercise_logs   for select to authenticated using (is_clinic_patient(patient_id));
create policy staff_read on activity_logs   for select to authenticated using (is_clinic_patient(patient_id));
create policy staff_read on reminders       for select to authenticated using (is_clinic_patient(patient_id));
create policy staff_read on session_addenda for select to authenticated using (
  exists (select 1 from sessions s where s.id = session_id and is_clinic_patient(s.patient_id)));
create policy staff_read on plan_items      for select to authenticated using (
  exists (select 1 from plans pl where pl.id = plan_id and is_clinic_patient(pl.patient_id)));
