# How we build Bitácora

Read this before building anything. It is how the therapist agent (Flows A and B) was built,
what went wrong along the way and what we changed because of it. Following it keeps the
product cohesive: the same patterns, the same tone, the same safety rules, whoever builds.

Companion docs: `CLAUDE.md` (rules and folder ownership), `docs/prd.md` (spec),
`docs/conversation-design.md` (how the agents talk), `docs/team-guide.md` (who does what, git
workflow), `docs/handoff/` (what changed for each workstream).

## 1. The process for every feature

1. **Understand before building.** Write down what the user wants and why, the approaches you
   considered, and the one you picked. Designs live in `docs/superpowers/specs/`, plans in
   `docs/superpowers/plans/` (Flow A and Flow B are complete examples to copy).
2. **Branch** from the latest `main`: `feature/<thing>` or `fix/<thing>`.
3. **Test first** for anything with logic: write the check, see it fail, then write the code.
   Pure logic goes in files with no `server-only` import, tested by `scripts/check-*.mts`
   (`npm run check` runs them all).
4. **Simulate** the real conversation (section 6), including the awkward cases: messages sent
   at the same moment, voice notes, a wrong answer, a long pause.
5. **Review before merging.** For anything non-trivial, a fresh reviewer (a new Claude Code
   session or a teammate) reads the whole branch against the design and looks for bugs. Fix what
   it finds with a failing test first. In Flows A and B the review found real bugs every time.
6. **Gate:** `npm run typecheck` (count `error TS` lines: 0), `npm run lint`, `npm run check`.
7. **PR, green Vercel check, merge, verify:** check the deployed commit is the merge commit, then
   try it on real WhatsApp. Say in the PR what changed for the other workstreams.

## 2. Architecture patterns (reuse them)

- **The code drives the conversation; the AI only reads and fills in.** Every flow is a
  deterministic step machine (`lib/agents/therapist/session-note.ts`, `new-patient.ts`,
  `initial-eval.ts`). The model transcribes, extracts into a zod schema (Structured Outputs),
  and applies one correction at a time. It never decides what to ask, when to save, or what
  to send.
- **Corrections can't silently change anything else.** A revise call returns the whole object
  plus the paths it changed; `mergeRevision` (`note-draft.ts`) reverts every other difference.
  Reuse it for anything the user corrects in plain words.
- **Drafts live in the database, not in the conversation.** The conversation state expires
  after 30 minutes; a draft row (`status = 'draft'`, working data in a `draft` jsonb column)
  survives, so the user can resume. Confirmed rows are locked by a trigger; corrections after
  that are addenda.
- **Atomic writes go through Postgres functions** (`0002`, `0003`): append an input, merge draft
  fields, confirm. Execute is revoked from `anon`/`authenticated`, so only the server calls them.
- **Nothing reaches the record without an explicit confirm.** Show what will be saved, then save
  on ✅ Confirmar or a whole-message "sí". "Sí, pero …" is a correction, never a yes.
- **Migrations are additive and run before merging.** A new file in `supabase/migrations/`
  (never edit an applied one), run in the Supabase SQL editor, followed by a check script that
  runs inside `begin … rollback` (`supabase/tests/`). One database serves dev and production.

## 3. Lessons (each one came from a real bug)

**Concurrency.** Every WhatsApp message is processed on its own, in parallel, with no lock per
phone. A multi-select of 3 photos is 3 messages at the same instant; a therapist can send
"Listo" while a voice note is still being transcribed.
- Create the draft *before* the messages that fill it can arrive (Flow A creates it when the
  evaluation is offered, not when the first photo lands), and append with one SQL statement.
- Mark long operations ("reading", "Listo" being processed) in the draft, so anything that
  arrives meanwhile is detected as late and handled: added before saving, or deleted and
  reported.
- Our simulator sends messages one by one, so it can't show these bugs: run several
  `npm run simulate` commands at once (`&` … `wait`) to test them.

**The AI invents when it can't read.** On a blurry form photo the model returned a different,
made-up date of birth on every run, and a stricter prompt didn't stop it. Now:
- photos are read twice; any number, date or result the reads disagree on is blanked and listed
  as "No se pudo leer" (`reconcileReadings`);
- "Niega" (stated none) and empty (not mentioned) are different and stay different;
- the user always sees what was understood before it is saved;
- a form that names another person warns and fills nothing into the record.

**One identity per test.** The simulator and real WhatsApp share the conversation state of a
phone number. A simulator run as Iñigo cleared his live conversation in the middle of a test.
Never simulate as someone who may be using WhatsApp; use **Terapeuta Simulador**
(+52 55 0000 9999) for therapist flows and test patients for patient flows.

**WhatsApp limits.** 1,600 characters per message: split longer content and send the options
last. WhatsApp collapses long messages behind "Leer más", so the call to action goes at the top
and the options are repeated in a short last message. Free-form messages only reach someone who
wrote in the last 24 h; outside that, an approved template. In the Sandbox, a number only
receives anything after it sent "join east-people".

**Privacy.** No form photos are kept: they are read in memory and deleted from Twilio once the
reading is saved, on Descartar, when a draft is abandoned, or immediately if sent where unused.
Synthetic data only in tests and the repo; never commit a real patient's form, number or name.
In PRs and issues, don't write `@name` unless it is a real GitHub login.

**Small things that bit us.**
- Mexican mobiles are stored as `+521…` (WhatsApp's form); always use `normalizePhone` /
  `parsePatientPhone`, and look up with `phoneVariants`.
- Dates for the clinic use `clinicToday()` (America/Mexico_City), not the server's UTC date.
- Two reads may write the same thing differently ("20°" vs "20", "Flex. dorsal" vs "Flexión
  dorsal"): compare normalised values, not raw strings.
- A bare number after "Corregir" is a correction ("3" = pain 3/10), not option 3.
- On Windows, shell heredocs can turn `\n` inside a code string into a real line break; check
  the file after scripted edits.

## 4. Conversation design (summary)

Full rules in `docs/conversation-design.md`. In short: numbered options with one icon each;
information blocks with a bold title and plain `Label: value` lines; one question per message;
say what a good answer looks like (the S/O/A/P guide); echo what was understood from a voice
note with ✏️ Corregir; one acknowledgement for things sent together; the call to action at the
top; never a dead end; after saving, offer the likely next step, the menu and ✅ Es todo.

## 5. Data contracts

`lib/db/types.ts` is the shared shape of every table. Anything showing clinical data reads only
confirmed rows: `sessions.status = 'confirmed'`, `initial_evaluations.status = 'confirmed'`. The
`draft` columns are working data for the agents. `docs/handoff/marina.md` has the CRM details.

## 6. Testing

| What | How |
| --- | --- |
| Pure logic | `npm run check` (`scripts/check-helpers.mts`, `check-flow-b.mts`, `check-flow-a.mts`) |
| A conversation | `npm run simulate -- --as "terapeuta simulador"` (or a test patient); scripts in `test_inputs/ws1_intake/es/`, `test_inputs/ws2_sessions/es/` |
| Voice notes | `--audio file`; synthetic audio made with OpenAI TTS, committed next to the scripts |
| Photos | `--image file`; synthetic forms in `test_inputs/ws1_intake/forms/` (`scripts/make-test-forms.py`) |
| Things at the same moment | several simulate commands in parallel |
| A migration | the rolled-back check script, locally or in the SQL editor |
| The AI calls | `scripts/try-soap.ts`, `scripts/try-intake.ts` (real OpenAI key) |

Saving in a test writes permanent, locked rows: use the test patients (Lucía Prueba Uno,
Laura Méndez Ruiz, Carlos Méndez, Valeria Soto), never Ana López (the CRM and the patient agent
build against her data).
