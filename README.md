# Bitácora

A WhatsApp agent and simple CRM for physical therapy clinics in Mexico. Therapists record each
session with a voice note; patients log homework and pain between visits; the clinic gets one
clinical record it can search, hand over and print.

- **Start here before building: [docs/how-we-build.md](docs/how-we-build.md)** (process, patterns, lessons)
- Spec: [docs/prd.md](docs/prd.md)
- Build rules and folder ownership: [CLAUDE.md](CLAUDE.md)
- Accounts, keys and onboarding status: [docs/setup-checklist.md](docs/setup-checklist.md)
- Who builds what, and how to build, test and deploy: [docs/team-guide.md](docs/team-guide.md)
- How the agents talk on WhatsApp (icons, confirmations, tone): [docs/conversation-design.md](docs/conversation-design.md)
- What changed for each workstream: [Cherub, patient agent](docs/handoff/cherub.md) ·
  [Marina, CRM](docs/handoff/marina.md)
- Designs and plans of the built flows: [docs/superpowers/](docs/superpowers/)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the keys (get them from the password
   manager, never from chat).
3. Create the database: in the Supabase SQL editor run the files in `supabase/migrations/` in
   order (`0001_init.sql`, `0002_flow_b.sql`), then `supabase/seed.sql`. (With the Supabase CLI and a local stack: `supabase init`, then
   `supabase db reset` applies the migrations and the seed.)
4. Put your own WhatsApp number on a therapist row in the seed (see the comment at the top of
   `supabase/seed.sql`) so the router recognises you.
5. `npm run dev`, start a tunnel (`ngrok http 3000`) and point the Twilio Sandbox webhook at
   `https://<tunnel>/api/whatsapp`.
6. Send "hola" to the Sandbox number. A therapist gets the menu; anyone else gets a polite
   "contact the clinic" message.

## Status

- Therapist agent: Flow A (new patient + initial evaluation from photos of the clinic's form or
  voice), Flow B (session note + home plan) and Flow E (session prep brief) are live on
  WhatsApp. Flow F (handoff) is next.
- Patient agent: consent, check-ins, activity logs, red flags and opt-out are built; templates,
  the reminder schedule and patient self-completion of details are next
  ([docs/handoff/cherub.md](docs/handoff/cherub.md)).
- CRM: not started; what to show is in [docs/handoff/marina.md](docs/handoff/marina.md).

All patient data is synthetic.
