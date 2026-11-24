# For Marina (CRM): what the agents now write, and how to show it

Status 24 Nov 2026. Read with `docs/how-we-build.md` (process and lessons) and
`app/(crm)/README.md` (read as the logged-in user, never with the service role).

Everything below is already live in the shared database. Types: `lib/db/types.ts`.

## 1. Rules that apply to every page

- **Show only confirmed clinical records.** `sessions` and `initial_evaluations` now hold drafts
  while a therapist is still working on them. Always filter `status = 'confirmed'`; ignore the
  `draft` columns (agent working data). Staff can read draft rows through RLS, so a page that
  forgets the filter would show half-finished notes, transcripts included.
- **Confirmed rows never change.** They are locked by a trigger. Corrections will be addenda
  (`session_addenda`, C-8): show them under the note, don't offer editing.
- **Synthetic rows exist in the shared database.** Therapist **Terapeuta Simulador** is used for
  tests; patients **Lucía Prueba Uno**, **Laura Méndez Ruiz**, Carlos Méndez and Valeria Soto have
  test notes and evaluations. Ana López is the demo patient: build and screenshot against her.
- Follow the same design rules as the agents where they apply (`docs/conversation-design.md`):
  plain `Label: value` information blocks, Spanish (es-MX) labels, clear empty states, and
  "Niega" shown as written (it means the patient denied it, which is different from empty).

## 2. Patients (`patients`)

| Column | Where it comes from | Show |
| --- | --- | --- |
| `full_name`, `phone` | therapist registration (Flow A) | always; phone as `+52 55 1234 5678` (helper `displayPhone` in `lib/agents/therapist/intake-logic.ts`) |
| `intake_reason` | the short reason given at registration ("rodilla derecha") | until the patient has a diagnosis, as "Motivo" |
| `diagnosis`, `referring_doctor`, `dob`, `sex` | filled from the confirmed initial evaluation (only if empty) | header of the patient page |
| `assigned_therapist_id`, `first_visit_at`, `last_visit_at`, `status` | registration; `last_visit_at` on each confirmed note; reactivation sets `status` back to `active` | list (C-2) and header |
| `consent_at`, `reminders_opt_in`, `reminder_time` | the patient's welcome (Cherub) | a small "Recordatorios" line |
| emergency contact, email (coming) | the patient completes them (Cherub, `docs/handoff/cherub.md`, migration `0004`) | header, when present |

## 3. Initial evaluation (`initial_evaluations`) — new

The clinic's paper *Historia Clínica* (MS / MI / Columna) as structured data, from photos of the
form or voice notes. **Show the newest confirmed row on the patient page** as its own section
(above the session timeline), in the same order as the paper form so staff recognise it:

Ficha (identificación) → Antecedentes heredofamiliares → No patológicos → Patológicos → Signos
vitales → Motivo y mecanismo de lesión → Dolor → Exploración (postura, marcha, goniometría D/I,
fuerza MRC D/I, pruebas ortopédicas D/I, sensibilidad, reflejos, espasmo, cicatriz, edema) →
Estudios auxiliares → Diagnóstico (impresión diagnóstica, diagnóstico fisioterapéutico) → Plan de
tratamiento (objetivos, indicaciones).

- `data` follows `EvaluationExtraction` in `lib/ai/intake-schema.ts` (every field listed there).
  `formatEvaluationReview` in `lib/agents/therapist/intake-format.ts` is the WhatsApp version of
  the same layout; reuse its labels so both say the same thing.
- `data.form_region`: `upper_limb` / `lower_limb` / `spine` → "Miembro superior / inferior / Columna".
- `data.unreadable`: fields that couldn't be read from the photo; show them as "No se pudo leer".
- `source` (`photo` / `voice`), `page_count`, `confirmed_at`, `therapist_id` → a small footer.
- No photos are stored: the signed paper form stays in the clinic.
- Empty state: "Sin valoración inicial. El terapeuta puede agregarla desde WhatsApp (🩺)."

## 4. Session notes and plans (Flow B)

- `sessions` (confirmed): `subjective`, `objective` (jsonb: rom, strength, special_tests,
  treatment_given), `assessment`, `plan_text`, `pain_nprs`, `missing_fields` (show as "Falta: …"
  so gaps are visible), `session_at`, `confirmed_at`, `therapist_id`.
- `plans`: one `active` plan per patient; older ones `superseded` with `end_date`. Show the active
  plan (C-5) and keep the history reachable.
- `plan_items`: `type` exercise / activity, `sets`, `reps`, `hold_seconds`, `frequency_per_week`
  (7 = "diario"), `days_of_week` (0 = domingo), `instructions`, `position` (display order).
  `describePlanItem` in `lib/agents/therapist/note-draft.ts` renders the same line the patient
  sees on WhatsApp ("Elevación de pierna recta 3×12, diario").
- Pain over time (C-6): `sessions.pain_nprs`, plus the patient's own logs (`exercise_logs`,
  `activity_logs`).

## 5. PDF export (C-7)

Include the initial evaluation (when confirmed) before the session notes, in the paper form's
order, with the therapist's name and cédula and a signature line, so the printed record matches
what the clinic files today.

## 6. How to work (same as everyone)

Branch, test first, a fresh review before merging, green Vercel check, verify on the deployed
site (`docs/how-we-build.md`). If the CRM ever needs to write (addenda, patient edits), write
through server code that respects the same rules (never edit confirmed rows) and tell Iñigo:
the agents rely on those rules.
