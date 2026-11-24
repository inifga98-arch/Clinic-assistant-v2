-- Bitácora 0003: Flow A (new patient + initial evaluation). Additive only: one nullable column,
-- one new table and three functions, so code already running keeps working while it is applied.
-- Run once in the Supabase SQL editor before merging the Flow A PR. Never edit once applied.
--
-- patients.intake_reason: the short reason the therapist gave at registration ("rodilla
--   derecha"). Kept apart from diagnosis so an evaluation never mistakes it for one.
-- initial_evaluations: the clinic's "Historia Clínica" (MS / MI / Columna) as structured data,
--   read from photos of the paper form or from voice notes. Photos are never stored here.
--   Drafts are real rows: anything showing evaluations must filter status = 'confirmed'.

alter table patients add column intake_reason text;

create table initial_evaluations (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references patients(id),
  therapist_id       uuid not null references therapists(id),
  source             text check (source in ('photo', 'voice')),
  status             text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_at       timestamptz,
  data               jsonb,               -- the evaluation, set on confirm
  draft              jsonb,               -- working state: inputs, extraction, step; null once confirmed
  source_transcript  text,                -- voice path
  page_count         smallint,            -- photo path
  created_at         timestamptz not null default now(),
  check (status = 'draft' or confirmed_at is not null)
);
create index initial_evaluations_patient_idx on initial_evaluations (patient_id, created_at desc);

-- Confirmed evaluations are locked, like confirmed session notes.
create or replace function initial_evaluations_lock_confirmed() returns trigger
language plpgsql as $$
begin
  if old.status = 'confirmed' then
    raise exception 'evaluation % is confirmed and locked', old.id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger initial_evaluations_lock_confirmed
  before update or delete on initial_evaluations
  for each row execute function initial_evaluations_lock_confirmed();

alter table initial_evaluations enable row level security;
create policy staff_read on initial_evaluations for select to authenticated using (is_clinic_patient(patient_id));

-- Append one input (a form page or a note) atomically, sorted by arrival. One UPDATE, so
-- photos sent together as a multi-select never overwrite each other. Returns the new count.
create or replace function append_evaluation_input(p_id uuid, p_entry jsonb)
returns int
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  update initial_evaluations e
     set draft = jsonb_set(
           coalesce(e.draft, '{}'::jsonb),
           '{inputs}',
           (select coalesce(jsonb_agg(x order by (x->>'received_at')::timestamptz, ord), '[]'::jsonb)
              from jsonb_array_elements(coalesce(e.draft->'inputs', '[]'::jsonb) || jsonb_build_array(p_entry))
                   with ordinality as t(x, ord)))
   where e.id = p_id and e.status = 'draft'
  returning jsonb_array_length(e.draft->'inputs') into n;
  if n is null then
    raise exception 'draft_not_found: evaluation % is not an open draft', p_id;
  end if;
  return n;
end $$;

-- Merge fields into the draft (shallow). Never writes inputs: only the append above does.
create or replace function set_evaluation_fields(p_id uuid, p_fields jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  update initial_evaluations
     set draft = coalesce(draft, '{}'::jsonb) || (p_fields - 'inputs')
   where id = p_id and status = 'draft';
  if not found then
    raise exception 'draft_not_found: evaluation % is not an open draft', p_id;
  end if;
end $$;

-- Confirm, all or nothing: lock the evaluation and fill the patient's EMPTY fields only.
-- p_eval: {data, source_transcript, page_count}
-- p_patient: {diagnosis, referring_doctor, dob (YYYY-MM-DD), sex ('female'|'male')}; nulls fill nothing.
create or replace function confirm_initial_evaluation(p_id uuid, p_eval jsonb, p_patient jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_patient uuid;
begin
  update initial_evaluations
     set data              = p_eval->'data',
         source_transcript = p_eval->>'source_transcript',
         page_count        = (p_eval->>'page_count')::smallint,
         status            = 'confirmed',
         confirmed_at      = now(),
         draft             = null
   where id = p_id and status = 'draft'
  returning patient_id into v_patient;

  if v_patient is null then
    if exists (select 1 from initial_evaluations where id = p_id and status = 'confirmed') then
      raise exception 'already_confirmed: evaluation % was already confirmed', p_id;
    end if;
    raise exception 'draft_not_found: evaluation % is not an open draft', p_id;
  end if;

  update patients
     set diagnosis        = coalesce(nullif(btrim(diagnosis), ''), p_patient->>'diagnosis'),
         referring_doctor = coalesce(nullif(btrim(referring_doctor), ''), p_patient->>'referring_doctor'),
         dob              = coalesce(dob, (p_patient->>'dob')::date),
         sex              = coalesce(sex, p_patient->>'sex')
   where id = v_patient;
end $$;

-- Only the server (service role) may call these; the CRM's logged-in users may not.
revoke execute on function append_evaluation_input(uuid, jsonb) from public, anon, authenticated;
revoke execute on function set_evaluation_fields(uuid, jsonb) from public, anon, authenticated;
revoke execute on function confirm_initial_evaluation(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function append_evaluation_input(uuid, jsonb) to service_role;
grant execute on function set_evaluation_fields(uuid, jsonb) to service_role;
grant execute on function confirm_initial_evaluation(uuid, jsonb, jsonb) to service_role;
