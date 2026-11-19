# Bitácora build rules

WhatsApp agent + CRM for physical therapy clinics in Mexico. Therapists record each session by
voice note; patients log homework and pain between visits; the clinic gets a searchable record
it can hand over and print. The spec is `docs/prd.md`. Read it before building a feature.

## Product rules

- All user-facing copy in Mexican Spanish (es-MX). Code, comments and docs in English.
- Ease of use beats features. One question per message. Quick replies over typing.
- Follow WhatsApp agent best practices: ack the webhook fast, process async, dedupe by
  MessageSid, validate Twilio signatures, respect the 24h window and opt-outs ("parar").
- Menus, patient selection and confirmations are a deterministic state machine. Use the LLM
  only for transcription, structured extraction (JSON schema) and briefs.
- Never write to the clinical record without therapist confirmation. Confirmed notes are
  immutable; corrections are addenda (`session_addenda`).
- The patient agent never gives clinical advice. It logs, reminds and escalates.
- Follow CRM best practices: searchable list, timeline view, clear empty states, mobile friendly.
- Secrets only in env vars (`.env.local`, never committed). Synthetic data only.

## Stack

TypeScript, Next.js App Router (one app: CRM pages + WhatsApp webhook), Supabase (Postgres,
Auth, RLS), Twilio WhatsApp, OpenAI (transcription + Structured Outputs). Deployed on Vercel.

## Who owns what (stay inside your folder; change shared files via a reviewed PR)

| Path | What | Owner |
| --- | --- | --- |
| `supabase/migrations/`, `supabase/seed.sql` | Schema and seed | Person 1 |
| `lib/db/` | Shared types, DB client, queries | Person 1 (shared: PR) |
| `lib/ai/` | Transcribe, SOAP extraction, briefs | Person 1 |
| `lib/agents/therapist/` | Flows A, B, E, F | Person 1 |
| `app/(crm)/` | CRM pages, PDF export | Person 2 |
| `app/api/whatsapp/route.ts` | Webhook entry | Person 3 |
| `lib/router/` | Sender lookup, conversation state, dispatch | Person 3 |
| `lib/whatsapp/` | Send helpers, media download, signature | Person 3 |
| `lib/agents/patient/` | Flows C, D, reminders | Person 3 |

The contract between the router and the agents is `lib/agents/types.ts`
(`AgentContext`, `handleTherapistMessage`, `handlePatientMessage`). Change it only by PR.

## How a message flows

1. Twilio POSTs to `/api/whatsapp`. The route validates the signature, saves the message
   (unique `twilio_sid` = retries are ignored) and returns 200 at once.
2. In `after()`, `lib/router` normalises the phone, finds the sender (therapist, patient or
   unknown), loads conversation state and calls the right agent.
3. The agent replies through `lib/whatsapp/send.ts` and returns the next state, which the
   router saves. State expires after 30 minutes idle.

## Database rules

- Never edit an applied migration. Add a new file in `supabase/migrations/`.
- Server code writes with the service-role client (`lib/db/server.ts`), which bypasses RLS.
  Never import it in client components.
- The CRM reads as the logged-in user, so RLS limits staff to their own clinic.
- Phones are stored in E.164 without the `whatsapp:` prefix (`+525512345678`).

## Commands

    npm run dev          # http://localhost:3000
    npm run typecheck    # must be clean before every PR (count "error TS" lines)
    npm run lint
    npm run build

Expose the webhook for Twilio with a tunnel (e.g. `ngrok http 3000`) and set the Sandbox
"When a message comes in" URL to `https://<tunnel>/api/whatsapp`. Set `PUBLIC_BASE_URL` to the
same origin so signature checks match.

## Reference material

- `docs/prd.md`: the spec.
- `docs/v1-reference/`: flow files from the class prototype (Clinic-assistant). Good edge cases
  for intake and session notes (never invent facts, "none" vs not mentioned, duplicate check,
  contradictions with the record). Reuse the learnings, not the code.
- `test_inputs/`: therapist message scripts and voice-note audio with expected outputs, from v1.
