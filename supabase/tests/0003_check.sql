-- Checks for migration 0003 (Flow A). Safe on the shared database: everything runs inside
-- one transaction that is rolled back at the end. Any failure raises an error; success means
-- every check passed. Run in the Supabase SQL editor AFTER 0003_initial_evaluations.sql.
-- Never remove the begin/rollback.
begin;

do $$
declare
  clinic  constant uuid := '00000000-0000-4000-8000-000000000001';
  valeria constant uuid := '00000000-0000-4000-8000-000000000203';
  inigo   constant uuid := '00000000-0000-4000-8000-000000000101';
  e1 uuid; e2 uuid; fresh uuid; n int; v_text text;
begin
  -- New column on patients.
  insert into patients (clinic_id, full_name, phone, assigned_therapist_id, intake_reason, first_visit_at)
  values (clinic, 'Paciente Prueba Cero', '+5215500000999', inigo, 'rodilla derecha', now())
  returning id into fresh;
  if (select intake_reason from patients where id = fresh) = 'rodilla derecha'
  then raise notice 'PASS intake_reason stored';
  else raise exception 'FAIL intake_reason'; end if;

  -- Pages arriving out of order come back in order.
  insert into initial_evaluations (patient_id, therapist_id, source, draft)
  values (valeria, inigo, 'photo', '{"step":"pages"}') returning id into e1;
  n := append_evaluation_input(e1, '{"kind":"page","media_url":"u2","content_type":"image/jpeg","received_at":"2026-11-24T10:00:05Z"}');
  n := append_evaluation_input(e1, '{"kind":"page","media_url":"u1","content_type":"image/jpeg","received_at":"2026-11-24T10:00:01Z"}');
  select draft->'inputs'->0->>'media_url' into v_text from initial_evaluations where id = e1;
  if n = 2 and v_text = 'u1' then raise notice 'PASS append keeps arrival order, count 2';
  else raise exception 'FAIL append: n=%, first=%', n, v_text; end if;

  -- Merging fields never touches inputs.
  perform set_evaluation_fields(e1, '{"step":"review","inputs":[]}');
  select draft->>'step', jsonb_array_length(draft->'inputs') into v_text, n from initial_evaluations where id = e1;
  if v_text = 'review' and n = 2 then raise notice 'PASS set_evaluation_fields merges and protects inputs';
  else raise exception 'FAIL set_evaluation_fields: step=%, inputs=%', v_text, n; end if;

  -- Confirm for Valeria: only her empty field (referring_doctor) is filled.
  perform confirm_initial_evaluation(e1,
    '{"data":{"chief_complaint":"Dolor lumbar"},"source_transcript":null,"page_count":2}',
    '{"diagnosis":"Otro diagnóstico","referring_doctor":"Dr. Ruiz (ortopedia)","dob":"1990-01-01","sex":"male"}');
  if (select status = 'confirmed' and confirmed_at is not null and draft is null and page_count = 2
             and data->>'chief_complaint' = 'Dolor lumbar' from initial_evaluations where id = e1)
  then raise notice 'PASS evaluation confirmed, draft cleared';
  else raise exception 'FAIL evaluation not confirmed'; end if;
  if (select diagnosis = 'Lumbalgia mecánica' and dob = '1996-11-30' and sex = 'female'
             and referring_doctor = 'Dr. Ruiz (ortopedia)' from patients where id = valeria)
  then raise notice 'PASS filled fields untouched, empty one filled';
  else raise exception 'FAIL patient fields for Valeria'; end if;

  -- A second confirm is refused; a confirmed evaluation is locked.
  begin
    perform confirm_initial_evaluation(e1, '{"data":{}}', '{}');
    raise exception 'FAIL second confirm accepted';
  exception when others then
    if sqlerrm like 'already_confirmed%' then raise notice 'PASS second confirm refused (already_confirmed)';
    else raise; end if;
  end;
  begin
    update initial_evaluations set data = '{}' where id = e1;
    raise exception 'FAIL confirmed evaluation editable';
  exception when others then
    if sqlerrm like '%locked%' then raise notice 'PASS confirmed evaluation locked';
    else raise; end if;
  end;
  begin
    perform confirm_initial_evaluation(gen_random_uuid(), '{"data":{}}', '{}');
    raise exception 'FAIL unknown evaluation accepted';
  exception when others then
    if sqlerrm like 'draft_not_found%' then raise notice 'PASS unknown evaluation refused (draft_not_found)';
    else raise; end if;
  end;

  -- A fresh patient with nothing filled gets every field; a null value fills nothing.
  insert into initial_evaluations (patient_id, therapist_id, source, draft)
  values (fresh, inigo, 'voice', '{}') returning id into e2;
  perform confirm_initial_evaluation(e2,
    '{"data":{},"source_transcript":"nota","page_count":null}',
    '{"diagnosis":"Esguince de tobillo grado II","referring_doctor":null,"dob":"1991-03-14","sex":"female"}');
  if (select diagnosis = 'Esguince de tobillo grado II' and dob = '1991-03-14' and sex = 'female'
             and referring_doctor is null from patients where id = fresh)
     and (select source_transcript = 'nota' from initial_evaluations where id = e2)
  then raise notice 'PASS empty patient filled; null leaves it empty';
  else raise exception 'FAIL fresh patient fields'; end if;
end $$;

rollback;
