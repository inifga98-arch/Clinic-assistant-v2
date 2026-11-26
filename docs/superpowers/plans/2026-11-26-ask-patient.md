# Ask about a patient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** after the prep brief, the therapist can ask questions about the patient's record; answers cite the record and mark opinions as suggestions.

**Architecture:** pure record builder and answer guard/format (`record-format.ts`, `ask-format.ts`), one AI call (`lib/ai/ask-record.ts`), a loader (`record-store.ts`) and a small flow (`ask.ts`) entered from the after-prep next step.

**Spec:** `docs/superpowers/specs/2026-11-26-ask-patient-design.md`

## Global Constraints

- es-MX; one answer per message, ≤ 1,600 chars with options. Confirmed rows only; writes nothing.
- Record statements cite entries; their numbers must be in the cited entries; sources rendered by code.
- The suggestion always carries "💡 *Sugerencia de la IA (no es del expediente):*".

## Review Focus

- A question with no answer in the record → "No lo encuentro", never an invented fact.
- A statement citing entry 99 or with a number from another entry → dropped.
- Follow-up ("¿y antes?") uses history; history is bounded.
- A patient with 40 notes / 300 logs: record stays within size; answer still fits.
- After the brief, "hola" still shows the menu; an option number still works; a question starts asking.

### Task 1: Record entries (pure) — `lib/agents/therapist/record-format.ts`

**Produces:** `RecordEntry { label: string; text: string }`; `buildRecord(r: RecordData): RecordEntry[]`; `recordText(entries): string` ("1. [nota 20 nov] …"); `weeklyAdherence(...)`.
- [ ] Checks in `scripts/check-ask.mts` (labels and order, caps of 25 notes / 60 activities, weekly adherence, empty patient). Fail → implement → pass → commit.

### Task 2: Answer guard and format (pure) — `lib/agents/therapist/ask-format.ts`, `lib/ai/ask-schema.ts`

**Produces:** `groundedStatements(stmts, entries)`, `formatAnswer({ statements, suggestion })`, `ASK_OPTIONS`, `askIntro(name)`; `NEXT_OPTIONS.after_prep` gains 💬 first.
- [ ] Checks: invalid source dropped; number not in cited entries dropped; sources rendered from labels; nothing left → "No lo encuentro"; suggestion label; length ≤ 1,600 with options; schema valid. Fail → implement → pass → commit.

### Task 3: AI call, loader, flow, routing

`lib/ai/ask-record.ts` (`answerFromRecord(record, history, question)`, 25 s, no retry), `record-store.ts` (`loadRecord(patient)`), `ask.ts` (`startAsk(ctx, patientId, question?)`, `handleAsk`), `index.ts` (after_prep: 💬 → ask; unmatched non-greeting text or voice → ask with that question). Seed marks rows in `pain_duration`.
- [ ] Typecheck 0, lint, check; simulate: record question, opinion question, follow-up, not-in-record, voice, option exit, "hola". Commit.

### Task 4: Review and ship

- [ ] Fresh opus review, fixes test-first, docs (how-we-build, marina: none), PR.
