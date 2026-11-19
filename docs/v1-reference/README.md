# v1 reference (class prototype)

Flow files from the first prototype (`inifga98-arch/Clinic-assistant`), where a headless Claude
Code agent ran each flow from these plain-English instructions. Bitácora replaces that design
with a state machine plus focused LLM calls, so the commands they mention (`crm.py`,
`set-draft`, ...) no longer exist.

Keep them for the product learnings, which carry over directly:

- `intake.md`: never invent a value; "no allergies" (None) vs not mentioned; ask ONCE for all
  missing fields, grouped; never compute a date of birth from an age; duplicate check by name +
  date of birth; a 20-second summary card before saving.
- `session_note.md`: one sentence goes in exactly one SOAP field; ask for pain score and plan
  before saving; flag contradictions with the record (left vs right knee); propose medical
  history changes separately and keep existing values.
- `patient_summary.md`, `AGENT.md`: summary format and routing edge cases (ambiguous names).
