-- Bitácora 0002: Flow B (session note + home plan). Additive only: one nullable column and
-- three functions, so code already running keeps working while this is applied.
-- Run once in the Supabase SQL editor, before merging the Flow B PR. Never edit once applied.
--
-- sessions.draft holds the working note while it is open (transcripts, extraction, questions
-- asked, step). It is cleared on confirm. Draft rows are real rows: anything showing notes (CRM,
-- briefs) must filter status = 'confirmed'.

alter table sessions add column draft jsonb;

-- Append one transcript entry atomically. One UPDATE statement, so the row lock serialises
-- two voice notes arriving at the same moment; entries stay sorted by received_at.
-- Returns how many notes the draft now has ("nota 2").
create or replace function append_session_transcript(p_session_id uuid, p_entry jsonb)
returns int
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  update sessions s
     set draft = jsonb_set(
           coalesce(s.draft, '{}'::jsonb),
           '{transcripts}',
           (select coalesce(jsonb_agg(e order by (e->>'received_at')::timestamptz, ord), '[]'::jsonb)
              from jsonb_array_elements(coalesce(s.draft->'transcripts', '[]'::jsonb) || jsonb_build_array(p_entry))
                   with ordinality as t(e, ord)))
   where s.id = p_session_id and s.status = 'draft'
  returning jsonb_array_length(s.draft->'transcripts') into n;
  if n is null then
    raise exception 'draft_not_found: session % is not an open draft', p_session_id;
  end if;
  return n;
end $$;

-- Merge fields into the draft (shallow). Never writes transcripts: only the append above does,
-- so a step change cannot overwrite a note that arrived meanwhile.
create or replace function set_draft_fields(p_session_id uuid, p_fields jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  update sessions
     set draft = coalesce(draft, '{}'::jsonb) || (p_fields - 'transcripts')
   where id = p_session_id and status = 'draft';
  if not found then
    raise exception 'draft_not_found: session % is not an open draft', p_session_id;
  end if;
end $$;

-- Confirm a note (T-8), all or nothing: lock the note, update the patient's last visit and,
-- when the plan changes, supersede the active plan and create the new one with its items.
-- p_note: subjective, objective, assessment, plan_text, pain_nprs, missing_fields,
--         source_transcript, source_audio_url.
-- p_items: [{type, name, sets, reps, hold_seconds, frequency_per_week, days_of_week, instructions}]
-- Returns the new plan id, or null when the plan was kept.
create or replace function confirm_session_note(
  p_session_id uuid, p_note jsonb, p_items jsonb, p_replace_plan boolean, p_start_date date)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_patient    uuid;
  v_session_at timestamptz;
  v_plan       uuid;
begin
  update sessions
     set subjective        = p_note->>'subjective',
         objective         = p_note->'objective',
         assessment        = p_note->>'assessment',
         plan_text         = p_note->>'plan_text',
         pain_nprs         = (p_note->>'pain_nprs')::smallint,
         missing_fields    = coalesce(array(select jsonb_array_elements_text(coalesce(p_note->'missing_fields', '[]'::jsonb))), '{}'),
         source_transcript = p_note->>'source_transcript',
         source_audio_url  = p_note->>'source_audio_url',
         status            = 'confirmed',
         confirmed_at      = now(),
         draft             = null
   where id = p_session_id and status = 'draft'
  returning patient_id, session_at into v_patient, v_session_at;

  if v_patient is null then
    if exists (select 1 from sessions where id = p_session_id and status = 'confirmed') then
      raise exception 'already_confirmed: session % was already confirmed', p_session_id;
    end if;
    raise exception 'draft_not_found: session % is not an open draft', p_session_id;
  end if;

  update patients
     set last_visit_at = greatest(coalesce(last_visit_at, v_session_at), v_session_at)
   where id = v_patient;

  if p_replace_plan then
    update plans set status = 'superseded', end_date = p_start_date
     where patient_id = v_patient and status = 'active';
    insert into plans (patient_id, session_id, start_date)
    values (v_patient, p_session_id, p_start_date)
    returning id into v_plan;
    insert into plan_items (plan_id, type, name, sets, reps, hold_seconds, frequency_per_week,
                            days_of_week, instructions, position)
    select v_plan,
           e->>'type',
           e->>'name',
           (e->>'sets')::smallint,
           (e->>'reps')::smallint,
           (e->>'hold_seconds')::smallint,
           (e->>'frequency_per_week')::smallint,
           case when jsonb_typeof(e->'days_of_week') = 'array'
                then array(select jsonb_array_elements_text(e->'days_of_week')::smallint) end,
           e->>'instructions',
           (ord - 1)::smallint
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as t(e, ord);
  end if;

  return v_plan;
end $$;

-- Only the server (service role) may call these; the CRM's logged-in users may not.
revoke execute on function append_session_transcript(uuid, jsonb) from public, anon, authenticated;
revoke execute on function set_draft_fields(uuid, jsonb) from public, anon, authenticated;
revoke execute on function confirm_session_note(uuid, jsonb, jsonb, boolean, date) from public, anon, authenticated;
grant execute on function append_session_transcript(uuid, jsonb) to service_role;
grant execute on function set_draft_fields(uuid, jsonb) to service_role;
grant execute on function confirm_session_note(uuid, jsonb, jsonb, boolean, date) to service_role;
