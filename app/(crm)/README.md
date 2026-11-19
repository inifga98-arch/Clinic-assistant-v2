# CRM (Person 2)

Pages for clinic staff: login (C-1), patient list (C-2), patient page with timeline (C-3, C-4),
PDF export (C-7). See `docs/prd.md` → "CRM".

- Read data as the logged-in user with `@supabase/ssr` (anon key + session cookie), so the RLS
  policies in `supabase/migrations/0001_init.sql` limit staff to their own clinic. Do not use
  `lib/db/server.ts` (service role) to render CRM pages.
- Staff log in with a Supabase Auth magic link. A login only sees data if its email matches an
  active row in `therapists` (see `current_clinic_id()`). Reception staff without a therapist
  row is an open question for the team.
- Mobile first (C-11): therapists open this on their phones.
