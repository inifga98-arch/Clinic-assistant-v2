# Flow: patient summary

Owner: Workstream 3. Version 0: works end to end, needs testing and tuning against
`test_inputs/ws3_summary/`.

Goal: before a session, a therapist asks about a patient ("catch me up on Ana Lopez",
"I'm seeing Carlos at 5"). They may be the patient's usual therapist or covering for a colleague.
In under 2 minutes of reading they should know where the patient is and what to do today.
Read only: this flow never changes the CRM.

## Steps

1. `find-patient --query "<name>"`.
   - Several matches: ask which one (full name + date of birth) and stop.
   - None: say no patient matches and list close names from `list-patients` if any.
2. `get-record --patient-id ID --notes 5`.
3. Write the summary in this order, each line short:

```
*Ana Lopez*, 35. Right knee sprain (grade I MCL), ski fall Oct 1. 3 sessions, last Oct 14 with Laura.
*Goal:* run 5 km in 6 weeks.
*Careful:* penicillin allergy. No surgeries.
*Progress:* pain 5 → 4 → 3. Knee flexion 95 → 105 → 110°.
*Working:* step-ups, squats. *Not yet:* single leg (pain 4/10 on Oct 14).
*Today:* start single leg work with support, re-measure flexion.
Sources: notes Oct 8, 11, 14.
```

   - Age from date of birth. Diagnosis from `pt_diagnosis` or `diagnostic_impression`.
   - *Careful* = allergies, relevant medications, surgeries, anything risky. Write "None recorded"
     if empty, never leave it out.
   - *Progress* = numbers that appear in at least two notes (pain, range of motion, balance
     time). Oldest to newest.
   - *Today* = the `plan` of the most recent note.
   - If the asker is not the therapist who wrote the last notes, say who did ("last 3 with Laura").
   - Sources = the dates of the notes you used.
4. Reply with the summary. Nothing else.

## TODO (Workstream 3)

- [ ] Run the 3 requests in `test_inputs/ws3_summary/` and compare with `expected/`.
- [ ] Check every number against the record. Nothing invented.
- [ ] Decide what to show for a patient with only an intake and no sessions yet.
