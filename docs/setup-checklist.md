# Setup checklist

Status as of 23 Nov 2026. Tick items off in a PR as they're done.

## Shared accounts (Iñigo, once)

- [x] GitHub repo `Clinic-assistant-v2` (public, `main` protected); Marina and Cherub have write access
- [x] Supabase project `Clinic-assistant-v2` (Propelia org): schema and synthetic seed loaded
- [ ] Invite Marina and Cherub to Supabase (Organization settings → Team)
- [x] Twilio account active, WhatsApp Sandbox number +1 415 523 8886
- [x] New OpenAI API key
- [ ] Put the full `.env.local` in the team password manager (never in chat or the repo)
- [ ] Submit the WhatsApp welcome and reminder templates in Twilio (Meta approval can take days)
- [x] Vercel project linked to the repo, env vars added, Sandbox webhook pointed at
      `https://clinic-assistant-v2.vercel.app/api/whatsapp` (one shared webhook for the whole team)
- [ ] Add Cherub's new vars in Vercel: `CRON_SECRET`, `TWILIO_TEMPLATE_WELCOME`,
      `TWILIO_TEMPLATE_REMINDER`, `PRIVACY_NOTICE_URL`

## Each person

1. Clone and install:

       git clone https://github.com/inifga98-arch/Clinic-assistant-v2.git
       cd Clinic-assistant-v2
       npm install

2. Copy `.env.local` from the password manager into the repo root (it is git-ignored).
3. Join the Twilio Sandbox from your phone: send the join code (Twilio console → Messaging →
   Try it out → WhatsApp) to +1 415 523 8886. Rejoin if it stops answering.
4. Add yourself as a therapist in Supabase (Table editor → `therapists`): your WhatsApp number
   in E.164 without spaces (Mexican mobiles with the 1: `+52155...`) and the email you'll use for the CRM, clinic
   `00000000-0000-4000-8000-000000000001`.
5. Check the setup: `npm run typecheck`, `npm run check`, then
   `npm run simulate -- --as <your name> "hola"`. You should see the therapist menu printed
   in the terminal. This is how you test flows day to day, with no phone or tunnel.
6. On real WhatsApp: send "hola" to the Sandbox number (works only when the webhook points
   at a running server: Vercel, or someone's tunnel).

## Working together

- Branch per feature, then a pull request. `main` is protected: changes arrive through a
  merged PR (no approval needed, so you can merge your own), no force pushes, no deletion.
  Every merge to `main` deploys to production on Vercel, and each PR gets a preview link.
- Stay in your folders (see `CLAUDE.md`); shared types, schema and `lib/agents/types.ts`
  change only through a reviewed PR.
- Schema changes are a new file in `supabase/migrations/`, run in the Supabase SQL editor
  after the PR is merged. Never edit `0001_init.sql`.
- Only one machine receives Sandbox messages at a time (whoever the webhook points to).
  Until Vercel is set up, agree who owns the tunnel, or deploy and test there.
