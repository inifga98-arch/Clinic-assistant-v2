# Bitácora

A WhatsApp agent and simple CRM for physical therapy clinics in Mexico. Therapists record each
session with a voice note; patients log homework and pain between visits; the clinic gets one
clinical record it can search, hand over and print.

- Spec: [docs/prd.md](docs/prd.md)
- Build rules and folder ownership: [CLAUDE.md](CLAUDE.md)
- Accounts, keys and onboarding status: [docs/setup-checklist.md](docs/setup-checklist.md)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the keys (get them from the password
   manager, never from chat).
3. Create the database: in the Supabase SQL editor run `supabase/migrations/0001_init.sql`,
   then `supabase/seed.sql`. (With the Supabase CLI and a local stack: `supabase init`, then
   `supabase db reset` applies the migrations and the seed.)
4. Put your own WhatsApp number on a therapist row in the seed (see the comment at the top of
   `supabase/seed.sql`) so the router recognises you.
5. `npm run dev`, start a tunnel (`ngrok http 3000`) and point the Twilio Sandbox webhook at
   `https://<tunnel>/api/whatsapp`.
6. Send "hola" to the Sandbox number. A therapist gets the menu; anyone else gets a polite
   "contact the clinic" message.

## Status

Phase 0/1 skeleton: schema + seed, shared types, webhook with signature check, dedupe, sender
lookup and conversation state, agent stubs. The flows themselves are the next build steps
(see the Build plan in the PRD).

All patient data is synthetic.
