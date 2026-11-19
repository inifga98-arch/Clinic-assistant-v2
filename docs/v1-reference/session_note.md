# Flow: session note

Owner: Workstream 2 (together with the Router section of `agent/AGENT.md`). Version 0: works
end to end, needs testing and tuning against `test_inputs/ws2_sessions/`.

Goal: the therapist sends one or more voice notes during or after a session. When they say
"done", you turn everything into ONE SOAP note on the right patient.

## When the therapist closes the draft

1. `draft-messages --draft-id ID` for everything said in this session.
2. `get-record --patient-id ID` to compare with what is already known.
3. Build the note:

```json
{
  "session_date": "YYYY-MM-DD (today unless the therapist said another day)",
  "subjective": "what the patient reports: pain, how they felt, adherence to home exercises",
  "objective": "what the therapist measured or observed: range of motion, strength, tests, what was done",
  "assessment": "the therapist's interpretation: progress, what is working, what is not",
  "plan": "next session and home exercises",
  "pain_score": 0
}
```

   - Each sentence the therapist said goes in exactly one field. Use their words; tidy, don't add.
   - `pain_score` only if a 0-10 number was said. Otherwise leave it out.
   - If the therapist gave no interpretation, `assessment` stays short and factual
     (for example "Pain down from 5 to 3 since last session"), using numbers from the record.
4. Look for two kinds of issues against the record:
   - **Contradictions**: the note disagrees with the record (left vs right knee, a different
     diagnosis, a surgery the record says never happened).
   - **Medical history changes**: something new for the history (new medication, new injury,
     new surgery, allergy, change of diagnosis or goals).

## Before saving: pain score and plan

The pain score feeds the patient's progress (the CRM and the summary chart pain over time), and
the plan is what the next therapist reads first. If the note has no `pain_score` or an empty
`plan`, ask for them ONCE before saving, instead of saving "not recorded":

- Store the note as the proposal with `"_waiting_for": "pain_and_plan"` added
  (`set-draft --status awaiting_confirmation --data-file ...`).
- Ask one question that names only what is missing, for example: "Before I save *Ana Lopez*'s
  note: pain score (0-10) and plan for next session? Or say *skip* to save it as is."
- If there is also a contradiction (below), put both in the same single question, and keep
  `"_waiting_for": "pain_and_plan"` so the answer is handled in one step.
- Skip this step when both are already there.

## Answer about pain and plan

The draft is `awaiting_confirmation` and its proposal has `"_waiting_for": "pain_and_plan"`.

1. `attach-message` so the answer is part of the note's source.
2. "skip", "no", "yes", "save", "save it as is": save the proposal unchanged.
3. Otherwise take the pain score (only a 0-10 number the therapist said) and the plan from the
   answer, and any answer to a contradiction you asked about. Update the proposal.
4. Save right away with `add-session-note` (do not show the note and ask again), then handle
   history changes as in "Saving". Confirm in 3-4 lines with the pain score and plan.

## Saving

- **No contradictions:** write the note to `tmp/<draft_id>.json`, then
  `add-session-note --therapist-id ID --patient-id ID --draft-id ID --data-file tmp/<draft_id>.json`.
  - No history changes: reply with a 3-4 line confirmation (date, pain, plan) and stop.
  - History changes: after saving the note, propose them. Store
    `{"history_changes": [{"field": "...", "value": "..."}]}` with
    `set-draft --status awaiting_confirmation --data-file ...` on a NEW session draft for the same
    patient (`open-draft --kind session --patient-id ID`, then `set-draft`).
    - `value` is the FULL new text of the field, because `apply-history-change` replaces the
      whole field. Start from the current value in `get-record` and add the new item, separated
      by "; ". Example: medications is "Losartan 50 mg daily" and the patient started naproxen,
      so `value` is "Losartan 50 mg daily; naproxen 250 mg twice a day". Only if the current
      value is empty or "None" does the new item replace it. Never drop what was already there
      unless the therapist said it stopped.
    - Reply with the current and the proposed value: "Note saved. Also update the medical
      history? *Medications* now: Losartan 50 mg daily. New: Losartan 50 mg daily; naproxen
      250 mg twice a day. Reply *yes* or *no*."
- **Contradictions:** do not save yet. Store the note as the proposal
  (`set-draft --status awaiting_confirmation --data-file ...`) and ask ONE question that names
  the contradiction. Example: "You said *left* knee; the record says *right*. Which is it?"

## On yes (draft awaiting confirmation)

- Proposal holds a note: save it with `add-session-note`, then handle history changes as above.
- Proposal holds `history_changes`: run `apply-history-change` for each, then
  `set-draft --status closed`. Reply listing what changed.
- On no: `set-draft --status closed` (or `cancelled`) and confirm nothing else changed.

## TODO (Workstream 2)

- [ ] Run the 3 sessions in `test_inputs/ws2_sessions/` and compare with `expected/`.
- [ ] Ambiguous name ("Ana"): the router must ask which Ana before opening a draft, then attach
      the first message once the therapist answers.
- [ ] New medication: note saved, history change waits for yes, Losartan kept in the new value.
- [ ] Tune the acknowledgement for each voice note: short, names the patient.
