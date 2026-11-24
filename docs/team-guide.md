# Team guide: who builds what, and how

Status as of 24 Nov 2026. Read with `CLAUDE.md` (rules, folder ownership) and `docs/prd.md` (spec).

| Person | Workstream | Folder |
| --- | --- | --- |
| Iñigo | Therapist agent: flows A (new patient), B (session note + plan), E (prep), F (handoff) | `lib/agents/therapist/`, `lib/ai/` |
| Cherub | Patient agent: consent, check-ins, activity logs, red flags, reminders | `lib/agents/patient/`, `app/api/cron/` |
| Marina | CRM: login, patient list, patient page, timeline, PDF export | `app/(crm)/` |

## Where each workstream stands

| Workstream | Built | Still to build |
| --- | --- | --- |
| Patient agent (Cherub) | P-1 consent, P-3/P-4 check-ins, P-5 activity logs (incl. voice), P-6 red flags, P-8 opt-out, P-2 reminder code | A schedule that calls `/api/cron/reminders` (Vercel Hobby cron runs at most once a day); approved Twilio templates; P-7 forward questions to the therapist; P-9 pause after missed reminders; red-flag alert outside the therapist's 24 h window |
| CRM (Marina) | Nothing yet | All of it (order below) |
| Therapist agent (Iñigo) | Menu, Flow B (session note + home plan) | Flows A, E, F |

## The database is the contract

Nobody calls anyone else's code. Each workstream writes some tables and reads others.

| | Writes | Reads |
| --- | --- | --- |
| Therapist agent | `patients` (Flow A), `sessions`, `plans`, `plan_items` (Flow B) | Everything, for prep and handoff briefs |
| Patient agent | `exercise_logs`, `activity_logs`, `reminders`; `consent_at`, `reminders_opt_in` on `patients` | The active plan and its items |
| CRM | Nothing yet (later: `session_addenda`, patient edits) | Everything, as the logged-in staff member |

- **Don't wait for each other.** The seed patient **Ana López** already has 2 confirmed notes, an
  active plan with 3 items, 6 exercise logs and a run with knee pain. Build against her.
- **`sessions` holds drafts.** Flow B saves a note as `status = 'draft'` while the therapist
  records it, and `'confirmed'` once they tap Confirmar (then it is locked). **The CRM and any
  brief must show only `status = 'confirmed'`.** The `draft` column is working data; ignore it.
- **New plans come from Flow B.** Confirming a note with home exercises supersedes the active
  plan and creates a new one with its `plan_items`; "sin cambios" keeps the current plan.
- **Shared files** (`lib/agents/types.ts`, `lib/db/types.ts`, `lib/whatsapp/send.ts`,
  `lib/router/`, `supabase/migrations/`): change them in a small separate PR and tell the others.
- **Schema changes**: a new file in `supabase/migrations/` inside the PR. Production uses the
  same database, so whoever has Supabase access runs it in the SQL editor right after merging.
  Keep changes additive (new nullable columns, new tables) so live code doesn't break meanwhile.

## The daily loop

1. `git pull`, then `git checkout -b feature/<thing>`.
2. Build in your folder with Claude Code (it reads `CLAUDE.md`).
3. Test:
   - Agents: the simulator, no phone needed.
     `npm run simulate -- --as <name>` (interactive) or `--audio test_inputs/...` for voice
     notes; compare with `test_inputs/*/expected/`.
   - CRM: `npm run dev`, then http://localhost:3000.
   - Always: `npm run typecheck` (0 `error TS` lines), `npm run lint`, `npm run check`.
4. Open a PR. Wait for the Vercel check to go green (it proves the build works), then merge it
   yourself; no approval is required.
5. About a minute later it is live: try it on real WhatsApp (send to +1 415 523 8886) or at
   https://clinic-assistant-v2.vercel.app.

Real WhatsApp only reaches production: the Sandbox has one webhook. Test unmerged code in the
simulator.

### How often: pull when you start, push when you stop, merge when a small piece works

| Action | What it does | When |
| --- | --- | --- |
| **Pull** | Brings everyone's latest merged work to your laptop | Every time you sit down to work, before starting anything; also after someone says they merged. On a branch, update it from `main` at least daily. |
| **Push** | Backs up your branch to GitHub. It does not touch the live app. | Often, unfinished work included; at least at the end of every session |
| **Merge** | Puts your branch into `main`, which goes live for everyone | When one small piece works (one feature per PR, e.g. "patient list", not "the whole CRM"), usually every day or two. Only on a green Vercel tick. Not right before a demo. |

### How to do it: just ask Claude Code

You don't need to type git commands. Ask Claude Code in plain words:

| You want to | Say to Claude Code |
| --- | --- |
| Start the day | "Pull the latest changes from main." |
| Start a new piece | "Create a branch called feature/patient-list from the latest main." |
| Keep your branch current | "Update my branch with the latest main." |
| Save and back up | "Commit my changes and push my branch." |
| Hand it in | "Run typecheck, lint and check, then open a pull request for this branch." |
| Check the build | "Is the Vercel check on my pull request green?" |
| Go live | "Merge my pull request." (only once the tick is green) |

Claude Code may ask your permission before pushing or merging; that's expected, approve it.
Opening and merging pull requests from Claude Code uses the GitHub CLI (`gh`); if it isn't
logged in, run `gh auth login` once in a terminal. You can also open and merge pull requests on
github.com (the repo's **Pull requests** tab).

If two people changed the same lines, git reports a conflict. Ask Claude Code to "resolve the
conflict, keeping both changes", check the result, and tell the other person.

Same thing in a terminal, inside the repo folder, if you prefer:

    git pull                                  # start the day (on main)
    git checkout -b feature/patient-list      # new piece of work
    git add -A && git commit -m "..."         # save
    git push -u origin feature/patient-list   # back up / share
    gh pr create --fill                       # hand it in
    gh pr merge --squash --delete-branch      # go live, once the tick is green

**Shared risk:** one database and one WhatsApp number serve development and production. A bad
merge breaks the demo for everyone, and test rows are real rows. Keep PRs small, merge only on a
green build, and don't delete rows you didn't create.

## Marina: CRM order

Follows the PRD's P0 requirements first:

1. C-1 login with a Supabase magic link (`@supabase/ssr`, session cookie).
2. C-2 patient list: search, filter by therapist, sort by last visit.
3. C-3 / C-4 patient page and timeline (notes and patient logs, newest first).
4. C-7 PDF export by date range, with patient name, date and time, therapist and cédula,
   and a signature line.
5. Then C-5 plan panel, C-6 pain chart, C-8 addenda, C-11 mobile layout.

Read data as the logged-in user so the access rules apply (see `app/(crm)/README.md`), never
with the service-role key. A login only sees data if its email matches an active therapist row.

## Cherub: next steps

1. **Register Bitácora's own WhatsApp sender** (start now: Meta's checks take days). The Sandbox
   can't send our own templates, so welcome and daily reminders outside the 24 h window only
   work from a registered sender.
   - Twilio console → Messaging → Senders → WhatsApp senders → Create new sender, then follow
     the Meta signup (it creates or links a Meta Business portfolio and WhatsApp Business account).
   - You need: a phone number that is **not** already on WhatsApp (a Twilio number bought in the
     console is simplest), the business name and website to show, and a Facebook login with admin
     rights on the Meta Business portfolio.
   - Twilio user roles: if your Developer role can't create senders, ask Iñigo to raise it to
     Administrator for this step.
   - The clinic owns the Meta Business account: register the sender under the clinic's
     business portfolio, not a personal one.
   - Display name: something Meta accepts for a clinic service (e.g. "Bitácora"); the real
     clinic's name needs proof it is theirs.
   - When it's approved: set `TWILIO_WHATSAPP_FROM` (Vercel and `.env.local`) to the new
     number, point its incoming-message webhook at `https://clinic-assistant-v2.vercel.app/api/whatsapp`,
     and tell the team (everyone then messages the new number instead of the Sandbox).
2. **Templates**: create the welcome (P-1) and daily reminder (P-2) templates in Twilio →
   Messaging → Content Template Builder, category Utility, Spanish (es-MX) copy from the PRD.
   Submit them for WhatsApp approval once the sender exists, then add their `HX...` ids to Vercel
   as `TWILIO_TEMPLATE_WELCOME` / `TWILIO_TEMPLATE_REMINDER`. Until then the code sends plain
   text, which only arrives inside the patient's 24 h window.
3. **Schedule the reminders**: nothing calls `/api/cron/reminders` yet. Vercel Hobby cron runs at
   most once a day; the PRD wants every 15 min. Pick a design (daily cron at a fixed hour, an
   external scheduler calling the endpoint with `Authorization: Bearer <CRON_SECRET>`, or Pro),
   then add `CRON_SECRET` in Vercel.
4. P-7 forward questions to the therapist, P-9 pause after missed reminders, and the red-flag
   alert to the therapist outside their 24 h window (needs a template too).

Demo until the sender exists: the patient messages first (check-in or activity log), so
reminders and replies stay inside the 24 h window.

## Iñigo: next steps

1. Flow B: built (design in `docs/superpowers/specs/2026-11-23-flow-b-design.md`, simulator
   scripts in `test_inputs/ws2_sessions/es/`).
2. Flow A, then E and F.

## Access (done 24 Nov 2026)

- [x] Supabase: Marina and Cherub invited (Propelia org).
- [x] `.env.local` shared through the password manager.
- [x] Supabase Auth for the CRM: Site URL `https://clinic-assistant-v2.vercel.app`; redirect URLs
      `https://clinic-assistant-v2.vercel.app/**` and `http://localhost:3000/**`.
- [x] CRM logins: active therapist rows for ifernandez@mba2027.hbs.edu,
      mfyrigoukoulouri@mba2027.hbs.edu, ckapoor@mba2027.hbs.edu and
      cherub.kapoor.c2021@iitbombay.org (Cherub's rows have no phone, so his WhatsApp stays a
      patient). Remove Cherub's therapist rows before a real pilot.
- [x] Vercel: Marina and Cherub are members of the Propelia team (build and error logs).
- [x] Twilio: Cherub invited to the Clinic Assistant account (messages, logs, templates).
