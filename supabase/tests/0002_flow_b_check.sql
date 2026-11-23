-- Checks for migration 0002 (Flow B). Safe on the shared database: everything runs inside
-- one transaction that is rolled back at the end. Expect only "PASS" notices.
-- Run in the Supabase SQL editor AFTER 0002_flow_b.sql. Never remove the begin/rollback.
begin;

do $$
declare
  ana     constant uuid := '00000000-0000-4000-8000-000000000201';
  valeria constant uuid := '00000000-0000-4000-8000-000000000203';
  inigo   constant uuid := '00000000-0000-4000-8000-000000000101';
  s1 uuid; s2 uuid; n int; v_plan uuid; v_count int; v_text text; v_at timestamptz;
begin
  -- A draft for Ana; two notes arrive out of order.
  insert into sessions (patient_id, therapist_id, draft) values (ana, inigo, '{"step":"recording"}') returning id into s1;
  n := append_session_transcript(s1, '{"text":"segunda","audio_url":null,"received_at":"2026-11-23T10:05:00Z"}');
  n := append_session_transcript(s1, '{"text":"primera","audio_url":"u1","received_at":"2026-11-23T10:00:00Z"}');
  select draft->'transcripts'->0->>'text' into v_text from sessions where id = s1;
  if n = 2 and v_text = 'primera' then raise notice 'PASS append keeps arrival order, count 2';
  else raise exception 'FAIL append: n=%, first=%', n, v_text; end if;

  -- Merging fields never touches transcripts.
  perform set_draft_fields(s1, '{"step":"review","transcripts":[]}');
  select draft->>'step', jsonb_array_length(draft->'transcripts') into v_text, n from sessions where id = s1;
  if v_text = 'review' and n = 2 then raise notice 'PASS set_draft_fields merges and protects transcripts';
  else raise exception 'FAIL set_draft_fields: step=%, transcripts=%', v_text, n; end if;

  -- Confirm with a new plan of two items.
  v_plan := confirm_session_note(s1,
    '{"subjective":"Dolor al subir escaleras","objective":{"rom":[],"strength":[],"special_tests":[],"treatment_given":["Terapia manual"]},
      "assessment":"Progresa","plan_text":"Plan","pain_nprs":4,"missing_fields":[],"source_transcript":"primera\n\nsegunda","source_audio_url":"u1"}',
    '[{"type":"exercise","name":"Puente","sets":3,"reps":10,"hold_seconds":null,"frequency_per_week":7,"days_of_week":null,"instructions":null},
      {"type":"activity","name":"Correr","sets":null,"reps":null,"hold_seconds":null,"frequency_per_week":2,"days_of_week":[1,4],"instructions":"20 min; reportar dolor"}]',
    true, '2026-11-23');
  if (select status = 'confirmed' and confirmed_at is not null and draft is null and pain_nprs = 4 from sessions where id = s1)
  then raise notice 'PASS session confirmed, draft cleared';
  else raise exception 'FAIL session not confirmed'; end if;
  if (select status = 'superseded' and end_date = '2026-11-23' from plans where id = '00000000-0000-4000-8000-000000000402')
  then raise notice 'PASS old plan superseded with end date';
  else raise exception 'FAIL old plan not superseded'; end if;
  select count(*) into v_count from plans where patient_id = ana and status = 'active';
  if v_count = 1 and (select id from plans where patient_id = ana and status = 'active') = v_plan
  then raise notice 'PASS exactly one active plan, the new one';
  else raise exception 'FAIL active plans: %', v_count; end if;
  if (select count(*) from plan_items where plan_id = v_plan) = 2
     and (select name from plan_items where plan_id = v_plan and position = 0) = 'Puente'
     and (select days_of_week from plan_items where plan_id = v_plan and position = 1) = '{1,4}'::smallint[]
  then raise notice 'PASS plan items inserted in order with days';
  else raise exception 'FAIL plan items'; end if;
  select session_at into v_at from sessions where id = s1;
  if (select last_visit_at from patients where id = ana) = v_at then raise notice 'PASS last_visit_at updated';
  else raise exception 'FAIL last_visit_at'; end if;

  -- A second Confirmar is refused with a recognisable message.
  begin
    perform confirm_session_note(s1, '{}', '[]', false, '2026-11-23');
    raise exception 'FAIL second confirm was accepted';
  exception when others then
    if sqlerrm like 'already_confirmed%' then raise notice 'PASS second confirm refused (already_confirmed)';
    else raise; end if;
  end;

  -- A confirmed note stays locked.
  begin
    update sessions set assessment = 'x' where id = s1;
    raise exception 'FAIL confirmed note was editable';
  exception when others then
    if sqlerrm like '%locked%' then raise notice 'PASS confirmed note locked';
    else raise; end if;
  end;

  -- An unknown or discarded draft.
  begin
    perform confirm_session_note(gen_random_uuid(), '{}', '[]', false, '2026-11-23');
    raise exception 'FAIL unknown draft was accepted';
  exception when others then
    if sqlerrm like 'draft_not_found%' then raise notice 'PASS unknown draft refused (draft_not_found)';
    else raise; end if;
  end;

  -- "Sin cambios" for a patient with no active plan: saved, no plan created.
  if (select count(*) from plans where patient_id = valeria) > 0 then raise exception 'FAIL precondition: Valeria has plans'; end if;
  insert into sessions (patient_id, therapist_id, draft) values (valeria, inigo, '{}') returning id into s2;
  v_plan := confirm_session_note(s2,
    '{"subjective":"Bien","objective":{"rom":[],"strength":[],"special_tests":[],"treatment_given":[]},
      "assessment":null,"plan_text":"Plan en casa: sin cambios.","pain_nprs":null,"missing_fields":["pain_nprs","objective","assessment"],
      "source_transcript":"nota","source_audio_url":null}', '[]', false, '2026-11-23');
  if v_plan is null and (select count(*) from plans where patient_id = valeria) = 0
     and (select missing_fields from sessions where id = s2) = '{pain_nprs,objective,assessment}'
  then raise notice 'PASS no-change note saved without a plan, gaps recorded';
  else raise exception 'FAIL no-change note'; end if;
end $$;

rollback;
