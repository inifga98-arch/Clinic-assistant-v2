# Flow B design: session note and home plan

Status: draft for approval, 23 Nov 2026. Owner: Iñigo (therapist agent).
Spec: `docs/prd.md` ("Therapist records a session note and sets the home plan", T-3 to T-8).

## Why

The therapist ends each session by recording a voice note on WhatsApp. Bitácora turns it into a
SOAP note in clinical Spanish and a structured home plan. Flow B is the critical path for the
team. It writes the notes that Marina's CRM shows and the plans that drive Cherub's reminders and
check-ins. The PRD's demo checkpoint is "one voice note becomes a confirmed note visible in
the CRM".

Success means a therapist records a note in under a minute of their own time after the session,
with no typing beyond a tap or two. The note is accurate (nothing invented) and the patient's
next reminder has the new exercises.

## Goals

- Record one voice note after the session, or several during it, for one patient.
- Turn them into one SOAP note and plan, ask for what is missing, show the note, take
  corrections in plain words, and save only on an explicit Confirmar.
- On confirm, lock the note, update the patient's last visit, and replace the active plan
  (or keep it when the therapist says the plan does not change).
- Survive interruptions: a draft is never lost because the 30-minute conversation timeout
  expired.

## Non-goals

- Messaging the patient about their new plan. That needs an approved template, which we don't
  have yet. The patient sees the change in their next reminder or check-in.
- Touching reminders. Cherub's scheduler (`lib/agents/patient/reminders.ts`) builds each day's
  reminders from the plan that is active that day, so a new plan is picked up automatically.
- Guided S→O→A→P questionnaire mode (T-9, P1).
- Starting a note without going through the menu (for example a voice note sent while idle).
- Editing a confirmed note. Corrections after confirmation are addenda (CRM, later).
- Medical-history updates and contradiction checks against the record (v1 had them; later).
- Real WhatsApp buttons. We keep the numbered lists from `sendOptions` until Content Templates
  exist.

## Anti-goals

These would make it a failure even if it technically works:

- The note contains anything the therapist did not say, such as an invented assessment, pain
  score or exercise.
- Something reaches the clinical record without the therapist tapping Confirmar.
- A correction silently changes a part of the note the therapist already saw and didn't
  touch.
- A note saved on the wrong patient.

## Decisions from the conversation

**Recording.** Both styles are supported: one note after the session, or several during it.
After each note the agent replies briefly, naming the patient, with two options:

```
Anotado para Ana López (nota 2).
1. Listo
2. Agregar otra
```

Typed or spoken "listo" / "eso es todo" also closes it. Typed text notes are accepted like
voice notes. Nothing is processed on silence: the therapist always closes the recording.

**Choosing the patient.**
1. Tapping "Nota de sesión" shows the therapist's own active patients, most recent visit first
   (up to 8), and invites them to type or say a name instead.
2. A typed or spoken name is matched against all active patients in the therapist's clinic.
   Accents and case are ignored, and first name, last name or full name all match.
3. If two or more patients match, the agent asks which one and shows full names
   ("¿Ana López o Ana Martínez?"). If two share a full name, it adds the date of birth.
4. The therapist can also skip the picker and start talking: if the first message at the
   picker is a voice note (or a long text) that names exactly one patient, the agent asks
   "¿Es de Ana López?" (Sí / No). The note is kept either way. On "No", or if no name or
   several names are found, the agent shows the picker and still keeps the note.

**What makes a note complete.** The standard SOAP framework, which matches how the clinic
writes notes:
- S, O, A and P each have content.
- S has the pain score (0–10).
- P has either home exercises or activities, which become the new active plan, or an explicit
  "sin cambios en el plan de casa", which keeps the current plan.
- The agent writes only what the therapist said. It never invents. If something is missing, it
  asks.
- One question per missing item, at most three questions per note (T-5). After that, or if the
  therapist answers "omitir", the note can be saved with the gaps listed in `missing_fields`.

**Showing and correcting (T-7).** The note is shown as text, then the options:

```
Ana López · 23 nov 2026
S: Dolor 3/10, peor al subir escaleras…
O: Flexión de rodilla 115°, extensión −3°, cuádriceps 4/5…
A: Evolución esperada a 6 semanas posquirúrgica…
P: 2 visitas/semana. Próxima sesión: fuerza de cuádriceps.
Plan en casa (reemplaza el actual):
 1. Elevación de pierna recta 3×12, diario
 2. Sentadilla en pared 3×30 s, diario
 3. Correr 20 min, 2×/semana (reportar dolor)
Falta: (only when saving with gaps)

1. Confirmar
2. Editar
3. Descartar
```

- **Editar** asks "¿Qué cambio?". The therapist types or says the correction ("la flexión fue
  120", "quita la sentadilla"). The agent applies only that change and shows the note again,
  as many times as needed.
- A correction typed straight away, without tapping Editar first, is treated the same way.
- **Descartar** deletes the draft and nothing is saved. (Called "Descartar", not "Cancelar":
  typing "cancelar" is the router's reset word, which keeps the draft, so the button needs a
  different name.)

**Saving (T-8).** One atomic step:
- the note is written and locked (status `confirmed`, `confirmed_at`), and the existing
  database trigger refuses any later edit;
- `patients.last_visit_at` is updated;
- if the plan has items: the active plan becomes `superseded` (with `end_date`), and a new
  active plan with its `plan_items` is created and linked to the session;
- if the plan is "sin cambios": the active plan stays as is.

The reply confirms it. If the patient gets reminders, it says when the next one goes out:
"Guardado en el expediente de Ana López. Su próximo recordatorio es mañana a las 19:00."

## Approaches considered

| | How it works | Trade-off |
| --- | --- | --- |
| **A. One extraction, then targeted changes (chosen)** | On Listo, one AI call reads all transcripts and fills the SOAP schema. Each follow-up answer or correction is a second kind of call: current draft + one instruction → the same draft with only that part changed. Code decides what is missing and what to ask, show or save. | Two prompts to maintain, but approved text cannot drift and every save is a deliberate tap. |
| B. Re-extract from everything each time | Answers and corrections are appended to the transcript and the note is rebuilt from scratch. | One prompt, but rebuilds can reword or drop approved text (the drift v1 suffered), and get slower and costlier each round. |
| C. Free-form chat agent with tools | The AI runs the conversation and decides when to ask, show and save. | Breaks the build rule (menus and confirmations are a deterministic state machine), hardest to test, could save without a confirm. Ruled out. |

Iñigo picked A.

## Design

### Conversation steps

State lives in `conversations` (`flow: "session_note"`) as usual. The draft itself lives in
the database (see below), so the state's `context` holds only `{ sessionId }` plus the step's
own data (for example the candidates shown at a disambiguation question).

| Step | Waiting for | Next |
| --- | --- | --- |
| `pick_patient` | number, name, or a note that names the patient | `confirm_patient`, `disambiguate`, or `recording` |
| `disambiguate` | which of the listed patients | `recording` |
| `confirm_patient` | Sí / No (for a note that named a patient) | `recording` (note kept) or `pick_patient` (note kept) |
| `recording` | another note, or Listo | stays in `recording`, or runs the extraction → `asking` or `review` |
| `asking` | answer to one missing-item question, or "omitir" | `asking` (next gap) or `review` |
| `review` | Confirmar / Editar / Descartar / a correction | saved (state cleared), `editing`, discarded, or `review` again |
| `editing` | the correction | `review` |

Rules that apply in every step:
- "menu" / "cancelar" typed: the router clears the state (existing behaviour) and the agent
  shows the menu. The draft row stays and can be resumed from "Nota de sesión". The router is
  not changed.
- A voice note is transcribed first. If transcription fails, the agent says so and asks for
  it again or as text. The step does not change.
- Voice notes up to about 3 minutes (T-4). Longer ones are accepted, with no hard limit enforced.

**Resuming a draft.** The offer appears only when the therapist taps "Nota de sesión", never
in front of other flows. If they have draft notes from the last 24 hours, the most recent one
is offered before the picker:

```
Tienes una nota sin confirmar de Ana López (hace 2 h).
1. Continuar
2. Descartarla
3. Nota de otro paciente
```

- Continuar returns to the step the draft was in. If notes were recorded but not processed,
  that step is `recording`; otherwise it's `review`.
- Descartarla deletes the draft row, then shows the picker.
- "Nota de otro paciente" leaves the draft alone and shows the picker. A therapist can
  therefore have several drafts. Each one is offered in turn, most recent first, the next time
  they tap "Nota de sesión".
- Drafts older than 24 hours are ignored, and they are never shown as notes anywhere.

### Where the draft lives

Approach A needs the draft to outlive the 30-minute conversation timeout. The `sessions` row is
created as a `draft` as soon as the patient is chosen. The structured working data goes in a
new nullable column, added in migration `0002`:

```
sessions.draft jsonb   -- { transcripts: string[], audio_urls: string[], extraction: SoapExtraction | null,
                       --   questions_asked: number, skipped: string[], step: string }
```

A note recorded before the patient is chosen (the "start talking" path) has no row yet,
because `patient_id` is required. Its transcript waits in the conversation state and moves
into the draft row once the patient is confirmed. If the therapist walks away for 30 minutes
at that one question, that note is lost. This is accepted: it is a single picker question, and
the alternative is a schema change for a rare case.

Notes sent back to back are processed in parallel (`after()` per message, no lock per phone).
So transcripts are appended with one SQL statement through a small function in `0002`,
`append_session_transcript(p_session_id, p_transcript, p_audio_url, p_received_at)`, which
appends atomically, keeps the entries ordered by `received_at` and returns the count (used for
"nota 2"). Two notes in flight never overwrite each other. The conversation state doesn't
change during `recording`, so racing on it is harmless.

Audio: the Twilio media URLs are kept in `draft.audio_urls`, and the first one goes in
`source_audio_url`. Copying recordings to Supabase Storage is later work.

The existing columns (`subjective`, `objective`, `assessment`, `plan_text`, `pain_nprs`,
`missing_fields`, `source_transcript`) are filled from the draft at confirmation. Until then
they stay empty, so nothing half-finished looks like a note.

### AI calls (`lib/ai/`)

- `transcribeVoiceNote`: exists. Each voice note is transcribed when it arrives, so a bad
  recording is caught immediately, not at Listo.
- `extractSoap(transcripts, patient)`: one Structured Outputs call (`gpt-4.1`, `zodResponseFormat`)
  over all transcripts in order. It gets the patient's name, diagnosis and current active
  plan, so "sin cambios" and "same exercises but 4 sets" can be resolved. The instructions
  require clinical es-MX Spanish (T-6), using only what was said, with null or empty for
  anything not said, and no assessment unless the therapist gave one.
- `reviseSoap(draft, instruction)`: same schema in and out. The instruction is either a
  correction or the answer to one missing-item question ("Pregunta: dolor 0–10. Respuesta: 3").
  The model must change only what the instruction refers to, and it also returns `changed`:
  the list of field paths it meant to change (for example `objective.rom[0].degrees`,
  `plan.home_exercises[1]`).
  - Code compares the old and new draft leaf by leaf, with plan items compared one at a time.
    Any difference outside the declared `changed` paths is reverted to the old value.
  - If nothing declared actually changed, the agent says it didn't understand the correction
    and asks again.
  - "quita la sentadilla" therefore removes that one item and leaves the other items exactly as
    they were.
  - A bare number 0–10 answering the pain question is applied by code without calling the
    model.

Schema changes to `lib/ai/soap-schema.ts`:
- add `plan.keep_current_plan: boolean` ("sin cambios");
- add `days_of_week: number[] | null` and `instructions: string | null` to exercises and
  activities. Set only when the therapist names days ("lunes y jueves") or gives an
  instruction;
- remove `missing_required`. Code computes what is missing; the model doesn't decide.

### What counts as missing (code, not AI)

| Item | Missing when |
| --- | --- |
| `subjective` | `summary` empty |
| `pain_nprs` | null |
| `objective` | rom, strength, special_tests and treatment_given all empty |
| `assessment` | empty |
| `plan` | no exercises, no activities, and `keep_current_plan` false |

The agent asks in this order, one question per message, up to three in total. The questions are
fixed Spanish strings, for example "¿Qué dolor reportó hoy, del 0 al 10?". Gaps still open
after three questions, or skipped with "omitir", go into `missing_fields` and show as
"Falta: …" in the review.

### Confirming: one database function

The confirmation writes several tables and must be all-or-nothing. Supabase's client has no
transactions, so migration `0002` adds a Postgres function the agent calls with `rpc`:

```
confirm_session_note(p_session_id uuid, p_note jsonb, p_items jsonb, p_replace_plan boolean,
                     p_start_date date) returns uuid  -- the new plan id, or null
```

1. Update the session from `p_note` and set `status = 'confirmed'`, `confirmed_at = now()`,
   `draft = null`, but only where `status = 'draft'`. If no row was updated, raise "already
   confirmed". A second tap of Confirmar then tells the therapist it was already saved.
2. `patients.last_visit_at = greatest(last_visit_at, session_at)`.
3. If `p_replace_plan`: set the active plan to `superseded`, with `end_date = p_start_date`,
   insert the new active plan (`session_id`, `start_date = p_start_date`), and insert
   `p_items` with `position` in the order given.

`p_start_date` is the clinic's local date (`clinicToday()` in `lib/agents/patient/time.ts`),
not the server's UTC date. For both functions in `0002`, execute is revoked from `public`, `anon` and `authenticated`, so
only the service role can call it.

Mapping to `plan_items`: an exercise maps to `type 'exercise'` with sets, reps, hold_seconds,
frequency_per_week, days_of_week and instructions. An activity maps to `type 'activity'`. Its
`target` and what to report ("20 min; reportar dolor") go into `instructions`.
`frequency_per_week` outside 1–14 is stored as null.

### Files

| File | What |
| --- | --- |
| `lib/agents/therapist/session-note.ts` | the step machine above |
| `lib/agents/therapist/patient-picker.ts` | list, name match, disambiguation. Reusable by Flows E and F |
| `lib/agents/therapist/note-format.ts` | renders the review message (pure, testable) |
| `lib/agents/therapist/index.ts` | dispatch `session_note` from the menu and from state, plus the resume offer |
| `lib/ai/soap-extract.ts` | `extractSoap`, `reviseSoap` |
| `lib/ai/soap-schema.ts` | schema changes above |
| `supabase/migrations/0002_flow_b.sql` | `sessions.draft` column, `append_session_transcript`, `confirm_session_note` |
| `lib/db/types.ts` | `draft` on `Session` (shared file: small change, tell the team) |
| `docs/team-guide.md` | CRM and prep must show only `status = 'confirmed'` notes. The clinic owns the Meta Business account (Cherub's sender step) |

### Constraints

- All user-facing text in es-MX. One question per message.
- A WhatsApp message through Twilio is capped at 1,600 characters. If the review message is
  longer, the plan goes in a second message, sent before the options.
- The webhook returns 200 at once and the work runs in `after()`. The extraction call (a few
  seconds) fits there. Vercel's function time limit still applies, so keep to one model call
  per message.
- One database serves dev and production. Migration `0002` is additive (a nullable column plus
  a new function) and must be run in the Supabase SQL editor before the code is merged.
- Draft rows are now real rows in `sessions`. **Marina's CRM and Flow E must filter
  `status = 'confirmed'`.** Tell the team in the PR.

### Testing

- Pure-function checks in `npm run check`: name matching and disambiguation, missing-item
  detection, review formatting (including the 1,600-character split), and mapping to
  `plan_items`.
- Simulator scripts in Spanish under `test_inputs/ws2_sessions/es/`:
  - one clean note;
  - three notes plus Listo;
  - missing pain, answered with "3";
  - missing assessment, skipped with "omitir";
  - a correction;
  - "sin cambios";
  - two Anas;
  - a note that names the patient at the picker;
  - Descartar;
  - two voice notes sent at the same moment (both kept, in order);
  - resuming after `--reset`.
- After a confirm, check in Supabase: the session is confirmed and locked, the old plan is
  superseded, the new plan has its items, and `last_visit_at` changed. Then run Cherub's
  check-in as Ana López to see the new items.
- The demo script step 3: a 1-minute note with no pain score → one question → confirm.

## Left to the builder

- Exact Spanish wording of prompts, questions and confirmations (short, warm, es-MX).
- The extraction and revision prompt text, and how the patient's current plan is described to
  the model.
- The fuzzy-match details (for example a token match plus a small edit distance for typos) and
  what counts as "a long text" at the picker.
- How patient names are found in a transcript at the picker step (matching the clinic's
  patient names against the text is enough; no AI call needed).
- Logging and error messages, following `processIncoming`'s pattern.
