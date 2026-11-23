-- Synthetic seed data: 1 clinic, 2 therapists, 5 patients. NO real patients, ever.
--
-- To test on WhatsApp, put your own number on a therapist (E.164, no "whatsapp:" prefix; Mexican mobiles with the 1: +521...)
-- in your local copy before running, or afterwards in the Supabase table editor:
--   update therapists set phone = '+52155XXXXXXXX', email = 'you@example.com' where full_name = 'Ana Torres';
-- The +52 1 55 ... numbers below are placeholders and reach nobody.
-- Laura Méndez is NOT seeded: the demo script registers her by voice (PRD, Flow A).

insert into clinics (id, name, address, whatsapp_number) values
  ('00000000-0000-4000-8000-000000000001', 'Clínica Bosques', 'Bosques de las Lomas, CDMX', null);

insert into therapists (id, clinic_id, full_name, license_no, phone, email) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   'Ana Torres', '12345678', '+5215500000101', 'ana.torres@example.com'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   'Diego Ramírez', '87654321', '+5215500000102', 'diego.ramirez@example.com');

insert into patients (id, clinic_id, full_name, phone, email, dob, sex, diagnosis, referring_doctor,
                      assigned_therapist_id, first_visit_at, last_visit_at, reminder_time,
                      consent_at, reminders_opt_in) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001',
   'Ana López', '+5215510000001', 'ana.lopez@example.com', '1991-03-03', 'female',
   'Esguince grado I del ligamento colateral medial, rodilla derecha', 'Dr. Ruiz (ortopedia)',
   '00000000-0000-4000-8000-000000000101', '2026-10-08 10:00-06', '2026-11-12 10:00-06', '19:00',
   '2026-10-08 10:30-06', true),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001',
   'Carlos Méndez', '+5215510000002', 'carlos.mendez@example.com', '1978-07-21', 'male',
   'Tendinopatía del manguito rotador, hombro derecho', 'Dra. Salas (ortopedia)',
   '00000000-0000-4000-8000-000000000101', '2026-10-20 12:00-06', '2026-11-10 12:00-06', '08:00',
   '2026-10-20 12:30-06', true),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001',
   'Valeria Soto', '+5215510000003', null, '1996-11-30', 'female',
   'Lumbalgia mecánica', null,
   '00000000-0000-4000-8000-000000000102', '2026-11-03 09:00-06', '2026-11-13 09:00-06', null,
   '2026-11-03 09:30-06', false),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000001',
   'Jorge Herrera', '+5215510000004', 'jorge.herrera@example.com', '1985-06-12', 'male',
   'Posoperatorio de reconstrucción de LCA, rodilla izquierda (semana 4)', 'Dr. Ruiz (ortopedia)',
   '00000000-0000-4000-8000-000000000102', '2026-10-28 17:00-06', '2026-11-14 17:00-06', '20:00',
   '2026-10-28 17:30-06', true),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000001',
   'Ana Martínez', '+5215510000005', null, '1962-01-15', 'female',
   'Fascitis plantar, pie izquierdo', null,
   '00000000-0000-4000-8000-000000000101', '2026-11-11 11:00-06', '2026-11-11 11:00-06', null,
   null, false);

-- Ana López: two confirmed sessions, an active plan and logs since, for Prep (Flow E) and
-- Handoff (Flow F). Two "Ana" patients exist on purpose, to test the patient picker (T-3).
insert into sessions (id, patient_id, therapist_id, session_at, subjective, objective, assessment,
                      plan_text, pain_nprs, status, confirmed_at) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000101', '2026-11-08 10:00-06',
   'Dolor 4/10 al subir escaleras. Realizó ejercicios en casa 5 de 7 días.',
   '{"rom":[{"joint":"rodilla derecha","movement":"flexión","degrees":110}],"strength":[{"muscle":"cuádriceps derecho","grade_0_5":4}],"special_tests":["Estrés en valgo doloroso, estable"],"treatment_given":["Bicicleta estática 10 min","Sentadillas parciales","Terapia manual"]}',
   'Evolución favorable; persiste déficit de fuerza de cuádriceps.',
   '2 sesiones por semana. Casa: elevación de pierna recta 3x12 diario; sentadilla en pared 3x30 s diario.',
   4, 'confirmed', '2026-11-08 10:20-06'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000101', '2026-11-12 10:00-06',
   'Dolor 3/10. Corrió 15 min el domingo con dolor a partir del minuto 10.',
   '{"rom":[{"joint":"rodilla derecha","movement":"flexión","degrees":120}],"strength":[{"muscle":"cuádriceps derecho","grade_0_5":4}],"special_tests":[],"treatment_given":["Elevación de pierna recta","Step-ups 15 cm","Terapia manual"]}',
   'Progresa según lo esperado; tolerancia limitada a la carrera.',
   '2 sesiones por semana. Casa: elevación de pierna recta 3x12 diario; sentadilla en pared 3x30 s diario. Actividad: correr 20 min 2 veces por semana y reportar dolor.',
   3, 'confirmed', '2026-11-12 10:25-06');

insert into plans (id, patient_id, session_id, start_date, status) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000301', '2026-11-08', 'superseded'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000302', '2026-11-12', 'active');

insert into plan_items (id, plan_id, type, name, sets, reps, hold_seconds, frequency_per_week, position) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000402',
   'exercise', 'Elevación de pierna recta', 3, 12, null, 7, 1),
  ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000402',
   'exercise', 'Sentadilla en pared', 3, null, 30, 7, 2),
  ('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000402',
   'activity', 'Correr 20 min', null, null, null, 2, 3);

insert into exercise_logs (patient_id, plan_item_id, log_date, done, pain_nprs, comment) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000501', '2026-11-13', true,  2, null),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000502', '2026-11-13', true,  3, null),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000501', '2026-11-14', true,  2, null),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000502', '2026-11-14', false, 2, 'La sentadilla en pared se sintió muy difícil'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000501', '2026-11-16', true,  2, null),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000502', '2026-11-16', false, null, null);

insert into activity_logs (patient_id, plan_item_id, activity, duration_min, pain_nprs, pain_location,
                           onset_min, pain_duration, red_flag, logged_at) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000503', 'Correr', 25, 5,
   'cara anterior de la rodilla derecha', 20, 'hasta el final de la carrera', false, '2026-11-15 08:30-06');
