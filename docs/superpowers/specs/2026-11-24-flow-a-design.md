# Flow A design: new patient and initial evaluation

Status: draft for approval, 24 Nov 2026. Owner: Iñigo (therapist agent).
Spec: `docs/prd.md` ("Therapist registers a new patient", T-2). Conversation rules:
`docs/conversation-design.md`. Reference implementation: Flow B (`lib/agents/therapist/`,
`docs/superpowers/specs/2026-11-23-flow-b-design.md`).

## Why

A patient must exist in Bitácora before anything else works: session notes (Flow B), reminders
and check-ins (patient agent), the CRM. Today patients exist only in the seed.

The PRD has the therapist dictate name, WhatsApp number, date of birth, diagnosis and referring
doctor. In practice the therapist doesn't know the patient's date of birth or email, and the
clinic's real intake is a long paper questionnaire (historia clínica) filled in at the first
visit, which is too complex to dictate. So intake is split by who actually has each piece of
information:

1. **Registration (this design):** the therapist gives only the name and WhatsApp number, in
   about 10 seconds. The patient is created and gets the welcome.
2. **Patient details (not this design):** after accepting the privacy notice, the patient fills
   in their own date of birth, sex, email and emergency contact on WhatsApp. This is Cherub's
   patient agent; a separate spec will go to him.
3. **Initial evaluation (this design):** the therapist sends a photo of the filled-in paper form,
   or a voice note. The AI extracts the clinical sections, the therapist checks them, and only
   the structured fields are saved (option "C+": the photo is never stored by Bitácora).

Success: registering a patient takes under 15 seconds of the therapist's time, the patient gets
the welcome right away, and the initial evaluation is searchable in the record without the
therapist retyping the form.

## Goals

- Register a patient from WhatsApp with name and number only (plus an optional reason).
- Catch duplicates: a number that already belongs to a patient or therapist, or an identical
  name in the clinic.
- Send the patient the welcome (Cherub's `startWelcome`) right after saving.
- Capture an initial evaluation from 1+ photos of the paper form or from voice notes, show what
  was read, accept corrections in plain words, and save on Confirmar, locked.
- Use what the evaluation contains to fill empty patient fields (diagnosis, referring doctor,
  date of birth, sex).

## Non-goals

- Storing the photos (decided: C+). Images are read in memory and discarded.
- The patient completing their own details (piece 2, Cherub).
- Editing a patient or an evaluation after saving (CRM later; evaluations get addenda later).
- Re-evaluations as their own type. A new evaluation for the same patient is allowed; the
  newest confirmed one is the current one.
- Using the evaluation in session prep (Flow E) or showing it in the CRM (Marina): both read the
  new table later.
- The discharge section, the SOAP log pages and the extra sheets of the clinic's forms (see
  Schema).

## Anti-goals

- Inventing history. "Niega alergias" (denied) and "not mentioned" are different and must stay
  different. Nothing the form or the therapist didn't say.
- Duplicate patient rows for the same person, or a patient created on a number that is a
  therapist's.
- Anything saved, or any message sent to the patient, before the therapist confirms.
- Keeping copies of the form images anywhere we control.
- Overwriting patient fields the patient or staff already filled in.

## Approaches considered (piece 3)

| | What's kept | Build | Running cost | Trade-off |
| --- | --- | --- | --- | --- |
| A. Own table + stored photos | Photos in a private bucket + structured fields | ~1–1.5 days + CRM photo viewer | ~$0.01–0.02 per page to read; storage ≈ $0 | Can check the AI against the original; we hold images of health data |
| **C+. Own table, no photos (chosen)** | Structured fields only | ~1 day | Same reading cost; no storage | Structured and searchable; to see the original, staff pull the paper form |
| C. Text summary only | A summary in patient fields | ~½ day | Same reading cost | Cheapest; loses structure Flow E and the CRM would use |

Iñigo picked C+: the structure of A without holding images of health data. The paper form stays
in the clinic as the legal original (NOM-004).

## Piece 1: registration

### Conversation

```
Therapist: 1 (🆕 Nuevo paciente)
Bitácora:  🆕 Nuevo paciente. Escribe o dime su *nombre completo* y su *WhatsApp*.
           Ej.: *Laura Méndez, 55 1234 5678*. Si quieres, agrega el motivo (p. ej. rodilla derecha).
Therapist: (voice or text) "Laura Méndez, 55 1234 5678, viene por la rodilla derecha"
Bitácora:  🆕 *Laura Méndez*
           📱 +52 55 1234 5678
           🩺 Motivo: rodilla derecha
           👤 Terapeuta: tú
           1. ✅ Guardar   2. ✏️ Corregir   3. 🗑️ Cancelar
Therapist: 1
Bitácora:  ✅ *Laura Méndez* registrada. Le envié la bienvenida para que acepte el aviso de
           privacidad y elija sus recordatorios.
           ¿Agregamos su valoración inicial?
           1. 📷 Foto del formato   2. 🎙️ Nota de voz   3. ⏭️ Después
```

- **Extraction:** a small Structured Outputs call returns `full_name`, `phone` (digits as said)
  and `reason` (nullable). Code normalises the phone with `normalizePhone`: 10 Mexican digits
  become `+521…`; a number with a `+` and country code is kept. A number that doesn't come out
  as valid E.164 (8–15 digits after `+`) is "missing".
- **Missing pieces:** if the name or the number is missing, ask for that one only
  ("¿Cuál es su WhatsApp?"). A voice note is echoed like Flow B ("🎙️ Esto entendí: «…»").
- **Corregir:** the therapist says the fix in plain words ("es Laura Méndez Ruiz", "el número
  termina en 79"); the same extraction runs on the current card plus the fix, and the card is
  shown again.
- **Duplicates (checked before the card is shown):**
  - The number belongs to an existing patient (any form, via `phoneVariants`): "Ese número ya es
    de *X*." with 📝 options to start a note or an evaluation for X, or 🗑️ Cancelar. No new row.
  - The number belongs to a **discharged** patient of this clinic: "*X* estaba dada de alta.
    ¿La reactivo?" ✅ Reactivar / 🗑️ Cancelar. Reactivating sets `status 'active'`, assigns them
    to this therapist and offers the evaluation; no new welcome if they already consented.
  - The number belongs to a patient of **another clinic**: "Ese número ya está registrado en
    otra clínica." No name, no options.
  - The number belongs to a therapist: say so, ask for another number.
  *(Builder-check calls.)*
  - Same full name already in the clinic (`matchPatients`, exact): warn on the card
    ("⚠️ Ya existe *Laura Méndez* (nac. 14/03/1991)") and keep Guardar, so a different person
    with the same name can still be registered.
- **Saving:** one insert into `patients`: `clinic_id` and `assigned_therapist_id` from the
  therapist, `full_name`, `phone`, `intake_reason` = the reason if given (new nullable column in
  `0003`, so the reason never sits in `diagnosis` and can't be mistaken for one),
  `first_visit_at = now()`, `status 'active'`. *(Builder-check call.)* The unique `phone`
  constraint is the final guard against a race: on a unique violation, show the "ya es de X"
  message.
- **Welcome:** call `startWelcome(patient)` after the insert. Twilio accepts the send and reports
  failures later, so the agent can't know if it arrived. While the Sandbox is in use (no
  `TWILIO_TEMPLATE_WELCOME` set), add one line: "Mientras usemos el número de prueba, solo le
  llega si antes mandó *join east-people* al +1 415 523 8886." If `startWelcome` throws, the
  patient is still saved; tell the therapist the welcome didn't go out and that it will start
  when the patient writes "hola" (the patient agent already sends the welcome to anyone without
  consent).

## Piece 3: initial evaluation ("Valoración inicial")

### Entry points

- Right after registration (📷 / 🎙️ / ⏭️ Después).
- A new menu option **🩺 Valoración inicial** (5th), which picks the patient with Flow B's picker
  (`recentPatients`, `matchPatients`, `patientLabel`).
- When a "ya es de X" duplicate is found during registration.

### Photo path

```
Therapist: (sends 1–3 photos; WhatsApp sends a multi-select as separate messages)
Bitácora:  📷 Recibí la página 1. ¿Hay más páginas?   1. ✅ Listo   2. ➕ Otra página
Therapist: 1
Bitácora:  Un momento, leo el formato…
Bitácora:  🩺 *Valoración inicial · Laura Méndez*
           *Motivo:* dolor de rodilla derecha de 3 semanas…
           *Antecedentes:* Alergias: niega. Medicamentos: ninguno. Cirugías: LCA 2024…
           *Exploración:* Dolor 6/10. Flexión 110°…
           *Diagnóstico:* …  *Objetivos:* …  *Plan:* 2×/semana…
           No se pudo leer: antecedentes heredofamiliares
           1. ✅ Confirmar   2. ✏️ Corregir   3. 🗑️ Descartar
```

- Pages arriving together are appended atomically (same pattern as Flow B's transcripts) and
  acknowledged with the running page count. Up to 6 pages. The first message asks for the pages
  up to the treatment plan ("las hojas hasta *Plan de tratamiento*; no hace falta la de
  consentimiento ni la bitácora").
- Reading: one Structured Outputs call with all page images (base64 from `downloadMedia`) and
  the schema below. The prompt says: read only what is written; a field crossed out or marked
  "niega/negado/ninguno" is a stated "none"; unreadable or blank is null and listed in
  `unreadable`; never infer.
- The images are held in memory only for the call. As soon as the extraction succeeds, the
  Twilio media for those pages is deleted (best effort; logged if it fails): corrections work on
  the extracted fields, so nothing needs the images again. If the extraction fails, the media is
  kept so "✅ Listo" can retry, and deleted on Descartar. An abandoned draft whose extraction
  failed can leave media in Twilio; accepted as rare, no cleanup job. *(Builder-check call.)* OpenAI's API doesn't train on API data; it may keep requests for up
  to 30 days for abuse monitoring.

### Voice path

Same as Flow B's recording: a guide first, then one or more voice/text notes, each echoed with
✏️ Corregir, then ✅ Listo → extraction from the transcripts → the same review.

```
🩺 Valoración inicial de *Laura Méndez*. Sigue el orden de la historia clínica:
💬 *Motivo y mecanismo de lesión*, y el dolor: inicio, dónde, tipo, intensidad (0 a 10), irradiación.
📚 *Antecedentes:* heredofamiliares, no patológicos (actividad física), patológicos
   (alergias, cirugías, trauma, enfermedades, medicamentos).
🔍 *Exploración:* postura, marcha, goniometría, fuerza, pruebas ortopédicas.
🧠 *Impresión diagnóstica* y *diagnóstico fisioterapéutico*.
🎯 *Plan de tratamiento:* objetivos e indicaciones.
```

### Review, corrections, confirm

Same rules as Flow B: one message (split at 1,600 characters, options last); a correction in
plain words is applied by a revise call that declares the paths it changed, and
`mergeRevision`'s guarantee holds (nothing undeclared changes); only a whole-message "sí" or
✅ Confirmar confirms. There are no follow-up questions: gaps are listed and the therapist can add them by Corregir
or save as is. Photo path: "No se pudo leer: …" from `unreadable`. Voice path, and the photo path
too when they are empty: "Falta: …" lists only the core items, `chief_complaint`,
`pain.intensity_nprs`, a diagnosis (`pt_diagnosis` or `diagnostic_impression`), and a plan
(`treatment_plan.goals` or `treatment_plan.instructions`). Other empty sections are simply not shown. *(Builder-check call.)*

On confirm, one database function, atomically:
- marks the evaluation `confirmed` (locked by trigger, like sessions);
- fills **empty** patient fields only: `diagnosis` = `diagnostic_impression`, or `pt_diagnosis`
  when there is none (the seed uses the medical wording, which is what the CRM header shows);
  `referring_doctor` = "name (specialty)"; `dob`; `sex`. Occupation, marital status and the
  emergency contact stay in the evaluation (the patient table has no columns for them). *(Builder-check call.)*

### Schema: the clinic's "Historia Clínica" (Structured Outputs; keys in English, content in es-MX)

The clinic (Balan-C) uses three paper forms, *Historia Clínica MS* (miembro superior), *MI*
(miembro inferior) and *Columna*, with the same sections. Only the goniometry joints and the
list of orthopedic tests change by region. The title printed on the form tells the region. The
extraction follows the form section by section, so a therapist can compare the review with the
paper line by line. Every key present; unknown = null or []. A field marked "niega", "negado",
"ninguno" or crossed out is the literal string "Niega" (stated none), never null.

```
form_region: "upper_limb" | "lower_limb" | "spine" | null     // from "HISTORIA CLÍNICA MS/MI/Columna"
form_date: "YYYY-MM-DD"|null, performed_by: string|null       // "Fecha", "Realizó"

identification: {                                             // ficha de identificación
  full_name, age: int|null, dob: "YYYY-MM-DD"|null, occupation,
  sex: "female"|"male"|null, marital_status, fall_risk,
  physician: { name, specialty, phone },                      // "Médico / Especialidad / Tel"
  emergency_contact: { name, relationship, phone } }

family_history: [ { condition, relatives: ["hermanos"|"madre"|"padre"|"abuelos"] } ]   // AHF grid:
   // cáncer, diabetes, HTA, cardiopatías, infartos/ACV, enf. reumáticas, artrosis/otros
non_pathological: { substance_use, activity_type, activity_frequency, activity_hours_daily }  // APNP
pathological: { allergies, transfusions, surgeries, orthopedic_surgeries, trauma,
                illnesses, medications_supplements }                                        // APP
vital_signs: { temperature, blood_pressure, respiratory_rate, spo2, heart_rate }            // strings as written

chief_complaint: string|null                                  // "Motivo de la consulta"
injury_mechanism: string|null                                 // "Mecanismo de lesión"
pain: { onset, location, type, intensity_nprs: 0–10|null, radiation, modifiers }  // semiología del dolor

exam: {
  posture, gait, observations,
  goniometry: [ { joint, movement, right, left } ],           // e.g. rodilla / flexión / "110°" / "135°"
  strength_mrc: [ { muscle_or_movement, right: 0–5|null, left: 0–5|null } ],
  orthopedic_tests: [ { test, right: "positiva"|"negativa"|"dolorosa"|null, left: same } ],
  complementary_tests, sensation, reflexes,
  spasm_location,
  surgical_scar: { location, features: ["queloide"|"retráctil"|"abierta"|"con adherencias"|"hipertrófica"] },
  edema: { location, type, characteristics, godet_sign } }

auxiliary_studies: string|null                                // "Estudios auxiliares"
diagnostic_impression: string|null                            // "Impresión diagnóstica" (medical)
pt_diagnosis: string|null                                     // "Diagnóstico fisioterapéutico"
treatment_plan: { goals: string[], instructions: string[] }   // "Plan de tratamiento: objetivos / indicaciones"

unreadable: string[]                                          // photo path: sections written but illegible
```

Not extracted at intake: "Evaluación final / datos de alta" (discharge, filled at the end), the
"Bitácora de sesiones" SOAP log pages (those notes come through Flow B), and the consent page
(the signed paper stays the legal consent; the patient's WhatsApp privacy consent is separate).
The extra sheets in the clinic's folder (valoración sensitiva y reflejos, escala Downton,
revaloración) are later work.

### Data (migration `0003_initial_evaluations.sql`, additive)

```
initial_evaluations (
  id uuid pk, patient_id fk, therapist_id fk,
  source text check in ('photo','voice'),
  status text 'draft'|'confirmed', confirmed_at timestamptz, check like sessions,
  data jsonb,            -- the schema above, set on confirm
  draft jsonb,           -- working state: inputs (page media refs or transcripts), extraction, step
  source_transcript text,-- voice path
  page_count smallint,   -- photo path
  created_at timestamptz default now()
)
index (patient_id, created_at desc)
trigger: confirmed rows locked (same as sessions_lock_confirmed)
RLS: enable; staff_read using is_clinic_patient(patient_id)
functions (service role only, like 0002):
  append_evaluation_input(p_id, p_entry jsonb) returns int   -- pages or transcripts, atomic
  set_evaluation_fields(p_id, p_fields jsonb) returns void   -- never touches inputs
  confirm_initial_evaluation(p_id, p_data jsonb, p_patient jsonb) returns void
```

`p_patient` carries the patient fields to fill; the function only writes those that are empty.
`0003` also adds `patients.intake_reason text` (nullable). Run in the Supabase SQL editor before merging, with a
rolled-back check script, as with `0002`.

### Code

| File | What |
| --- | --- |
| `lib/agents/therapist/new-patient.ts` | registration step machine |
| `lib/agents/therapist/initial-eval.ts` | evaluation step machine (photo and voice) |
| `lib/agents/therapist/intake-format.ts` | pure: registration card, evaluation review, guide |
| `lib/ai/intake-extract.ts` | `extractRegistration`, `extractEvaluation` (text or images), `reviseEvaluation` |
| `lib/ai/intake-schema.ts` | zod schemas above |
| `lib/agents/therapist/eval-store.ts` | draft rows and RPCs |
| `lib/agents/therapist/index.ts` | menu option 5, dispatch |
| `lib/agents/therapist/note-draft.ts` | make `mergeRevision` generic over the object type (no behaviour change) |
| `lib/whatsapp/media.ts` | image types for the simulator; delete-media helper (shared file: small, tell Cherub) |
| `scripts/simulate.ts` | `--image file` and `/image file` |
| `supabase/migrations/0003_initial_evaluations.sql`, `supabase/tests/0003_check.sql` | data |
| `docs/team-guide.md` | Marina: show the newest confirmed evaluation on the patient page; Cherub: piece 2 pointer |

## Testing

- Pure checks (`npm run check`): registration parsing and phone normalisation (10 digits,
  `+52 1`, foreign `+1…`, too short), duplicate decisions, card and review formatting with
  the 1,600 split, "Niega" vs null rendering, the merge guarantee on the evaluation schema.
- Synthetic form images: fill the clinic's blank *Historia Clínica MI* (and one *MS*) with a
  made-up patient, as photos of 2–3 pages, plus a deliberately blurry page. Commit them under
  `test_inputs/ws1_intake/forms/`. The blank templates are in the clinic's Drive folder; never
  commit a real patient's form.
- Simulator scripts in `test_inputs/ws1_intake/es/`: register by text and by voice, missing
  number, duplicate number, same name, Corregir; evaluation by photo (1 and 2 pages), by
  voice, a correction, Descartar, ⏭️ Después then menu 🩺.
- Database check after confirm: evaluation locked, empty patient fields filled, filled ones untouched.
- On WhatsApp after deploy: register a test patient on a number that joined the Sandbox and
  see the welcome arrive.

## Left to the builder

- Exact es-MX copy (following `docs/conversation-design.md`).
- Prompt wording for the three AI calls.
- How the photo extraction handles rotation and multiple pages in one image.
- Whether the registration extraction can skip the model call when the text is clearly
  "Name, number" (cost and speed optimisation).
- Logging and error messages, following Flow B.
