# For Cherub (patient agent): what changed, and what's next

Status 24 Nov 2026. Read with `docs/how-we-build.md` and `docs/conversation-design.md`.

## 1. What the therapist side now does that touches you

- **Flow A calls your `startWelcome(patient)`** right after a therapist registers a patient
  (`lib/agents/therapist/new-patient.ts`). New patients therefore arrive with only a name and a
  WhatsApp number (`patients.intake_reason` may hold a short reason). Your welcome must work for
  them as is; it does today.
- **Some patients arrive with more data**: a confirmed initial evaluation fills empty patient
  fields (`dob`, `sex`, `diagnosis`, `referring_doctor`). Never overwrite a filled field.
- **Plans change after every session note** (Flow B): the active plan is superseded and a new one
  created. Your check-ins and reminders already read the active plan each time, which is right.
- **`Option` has an optional `icon`** (`lib/whatsapp/options.ts`, re-exported from `send.ts`).
  Matching ignores the icon, so adding icons to your menus can't break replies.
- **Media helpers**: `mediaTypeForPath` (audio and images; `audioTypeForPath` still works) and
  `deleteTwilioMedia(url)` in `lib/whatsapp/media.ts`. The simulator takes `--image file`.
- **OpenAI calls time out at 45 s** with one retry (`lib/ai/openai.ts`), to stay inside the 60 s
  webhook limit.
- **Test identities**: simulate therapist flows as Terapeuta Simulador (+52 55 0000 9999).
  Synthetic test patients exist: Lucía Prueba Uno (+52 55 0000 9101) and Laura Méndez Ruiz
  (+52 55 0000 9102). Don't simulate as Iñigo or Marina while they may be on WhatsApp.

## 2. Bring the patient flows up to the shared design

From `docs/conversation-design.md` (Flow B and Flow A show each one working):

1. Icons on every option list: 💪 Mis ejercicios de hoy / 🏃 Una actividad; ✅ Todos /
   🟡 Algunos / ❌ Hoy no; ✅ Acepto / ❌ No acepto; ⏰ on the reminder times.
2. Voice activity logs: show what was understood ("🎙️ Esto entendí: «…»") with ✏️ Corregir
   before saving.
3. Say what a good answer looks like: for an activity, *qué hiciste, cuánto tiempo y si te dolió
   (0 a 10)*, with an example.
4. Summaries as information blocks: a bold title and plain `Label: value` lines, icons only on
   the options.
5. After saving a log, offer the next step, not a dead end (e.g. 💪 Registrar ejercicios /
   🏃 Otra actividad / ✅ Es todo).
6. Encouraging tone ("¡Bien hecho! 💪"), never clinical advice (X-4).
7. A photo the patient sends is not used by any flow yet: delete it from Twilio
   (`deleteTwilioMedia`) and say so, as the therapist flows do.

## 3. Spec: the patient completes their own details (Flow A, piece 2)

**Why.** Therapists register patients with name and WhatsApp only: they don't know a patient's
date of birth or email. The patient does. Standard practice is that demographics come from the
patient, and asking right after consent keeps it legal (Mexican data-protection law: consent
first, then personal data) and natural.

**When.** At the end of the welcome, after the reminder question (after `awaiting_time`, or after
"No, gracias" at `awaiting_opt_in`). Only if the patient accepted the privacy notice. Only for
fields still empty: a confirmed initial evaluation may already have filled date of birth and sex.
Ask once; never again automatically (the CRM shows what is missing).

**What to ask, one question per message, each skippable with "omitir":**

| Field | Column | Question (es-MX) | Accept |
| --- | --- | --- | --- |
| Date of birth | `patients.dob` | "¿Cuál es tu fecha de nacimiento? Por ejemplo *14/03/1991*." | DD/MM/AAAA (also "14 de marzo de 1991"); reuse `isValidDate` from `lib/agents/therapist/intake-logic.ts`; a date in the future or impossible → ask again once |
| Sex | `patients.sex` | "¿Cuál es tu sexo?" 1. Femenino 2. Masculino 3. Prefiero no decir | `female` / `male` / leave null |
| Email | `patients.email` | "¿Cuál es tu correo? Lo usamos solo para mandarte tus documentos." | a simple email check; "no tengo" = skip |
| Emergency contact | new columns (below) | "¿A quién llamamos en caso de emergencia? Nombre, parentesco y teléfono." | parse with `parsePatientPhone` (same file); if the phone is missing, ask for it once |

**Opening and closing messages:**

```
¡Listo! Para completar tu expediente me faltan unos datos (1 minuto).
Puedes escribir *omitir* en cualquier pregunta.
```
Then, at the end, an information block and the next step:
```
*Tus datos*
Fecha de nacimiento: 14/03/1991
Correo: laura@example.com
Contacto de emergencia: Rosa Méndez (madre) +52 55 1111 2222

Gracias, Laura. Tu terapeuta ya puede verlos.
```
Each answer is saved as soon as it is valid (it is the patient's own data; no therapist
confirmation is needed). If the patient leaves halfway, nothing else happens: what was saved
stays saved.

**Data (a new migration, `0004_patient_details.sql`, additive):**
```
alter table patients add column emergency_contact_name text;
alter table patients add column emergency_contact_relationship text;
alter table patients add column emergency_contact_phone text;
alter table patients add column details_asked_at timestamptz;  -- so it is asked once
```
Run it in the Supabase SQL editor before merging, with a rolled-back check script, and tell
Marina (the CRM shows these fields). Never overwrite a filled `dob`, `sex` or `email`.

**Rules from `how-we-build.md` that apply:** the step machine decides everything (no model call
is needed here except perhaps parsing a spoken date); one question per message; skippable;
pure parsers in a file without `server-only`, tested in `npm run check` first; simulate as a
test patient, including sending two answers at once.

**Done when:** a new patient who accepts the notice is asked only for the missing fields, can skip
any, sees the summary, and the CRM shows the saved values; a patient whose evaluation already
filled the date of birth is not asked for it; a check script covers parsing and "ask once".

## 4. Still on your list (from `docs/team-guide.md`)

The WhatsApp sender registration (under the clinic's Meta Business account), the welcome and
reminder templates, the reminder schedule, P-7, P-9 and the red-flag alert outside the 24 h
window. Piece 2 above can be built and tested now; it doesn't depend on any of them.
