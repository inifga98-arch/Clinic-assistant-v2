# Flow: new patient intake

Owner: Workstream 1. Version 1: tuned for `test_inputs/ws1_intake/`.

Goal: the therapist describes a new patient in one or more voice notes. You build the patient
record (the clinic's historia clínica), ask ONCE for any missing required field, check for
duplicates, show a summary, and save only after the therapist says yes.

Order of steps: build the record -> missing fields (one grouped question) -> duplicate check ->
summary -> save on yes.

## 1. Build the record (when the therapist closes the draft)

1. `draft-messages --draft-id ID` to read everything collected, in order.
2. Build the record as JSON with three parts, using ONLY what was said:

```json
{
  "patient": {
    "full_name": "", "date_of_birth": "YYYY-MM-DD", "phone": "", "email": "",
    "occupation": "", "gender": "", "marital_status": "", "clinic": "",
    "emergency_contact": {"name": "", "relationship": "", "phone": ""},
    "referring_doctor": {"name": "", "specialty": "", "phone": ""},
    "fall_risk": ""
  },
  "history": {
    "reason_for_visit": "", "mechanism_of_injury": "",
    "body_region": "upper_limb | lower_limb | spine",
    "pain": {"location": "", "intensity_0_10": 0, "onset": "", "type": "", "radiates": "", "better_worse": ""},
    "allergies": "", "medications": "", "surgeries": "", "orthopedic_surgeries": "", "trauma": "",
    "illnesses": "", "transfusions": "",
    "family_history": {}, "lifestyle": {"substance_use": "", "activity": "", "frequency": ""},
    "vital_signs": {}, "exam_findings": "", "studies": "", "diagnostic_impression": "",
    "pt_diagnosis": "", "treatment_goals": "", "treatment_instructions": ""
  },
  "assessment": {"summary": "2-3 sentence summary of the first assessment"}
}
```

### Never invent

- Every value must be something the therapist said. If you cannot point to the words, leave
  the key out.
- Drop every key that was not mentioned (also empty objects like `family_history: {}`).
- Said out loud that there is none ("no allergies", "takes no medications", "never had
  surgery") = the value `"None"`. Not mentioned = leave the key out. These are different.
- If the therapist corrects themselves ("left knee, sorry, right knee"), keep the last version.
- Keep names, numbers and phone numbers exactly as said. Do not add a country code, do not
  reformat, do not fix spelling of a name (the therapist will correct it in the summary).

### Where each fact goes

| The therapist says | Field |
| --- | --- |
| Name, date of birth, phone, email | `patient.full_name`, `date_of_birth`, `phone`, `email` |
| Job ("she's a chef, works standing") | `patient.occupation`, short: "Chef, works standing all day" |
| Emergency contact, referring doctor | `patient.emergency_contact`, `patient.referring_doctor` |
| Why they came, short: complaint + side + body part (+ how long, if said) | `history.reason_for_visit`, e.g. "Right shoulder pain" |
| What caused it, or that it started gradually / with no injury | `history.mechanism_of_injury`. "No injury, started gradually when mileage went up" IS the mechanism: do not ask for it |
| Where it hurts | `history.pain.location`, e.g. "front and side of the right shoulder" |
| Pain number 0-10 | `history.pain.intensity_0_10`, a number |
| When the pain started ("about a month ago") | `history.pain.onset` |
| Sharp, dull, burning... / spreads to... | `history.pain.type`, `history.pain.radiates` |
| What makes it worse or better, when it appears | `history.pain.better_worse` |
| Allergies, medications | `history.allergies`, `history.medications`. Supplements go in `medications` as "Supplements: ..." |
| Surgeries | `history.surgeries`; bone/joint surgeries also in `orthopedic_surgeries` |
| Past fractures or injuries, illnesses, transfusions | `history.trauma`, `illnesses`, `transfusions` |
| Family history | `history.family_history`, keys `cancer`, `diabetes`, `high_blood_pressure`, `heart_disease`, `heart_attack_or_stroke`, `rheumatic_disease`, `arthritis`; value = who ("mother") |
| Sport or exercise and how often; smoking, alcohol | `history.lifestyle.activity`, `frequency`, `substance_use` |
| Temperature, blood pressure, breathing rate, oxygen, heart rate | `history.vital_signs`, keys `temperature`, `blood_pressure`, `respiratory_rate`, `oxygen_saturation`, `heart_rate` |
| Anything examined: posture, gait, range of motion, strength, special tests, swelling | `history.exam_findings`, as one line of text: "Painful arc 80 to 120 degrees, Hawkins positive right, external rotation strength 4/5" |
| X-ray, MRI, other studies | `history.studies` |
| The doctor's diagnosis | `history.diagnostic_impression` |
| "My diagnosis is..." / "I think it's..." | `history.pt_diagnosis` |
| Goals, with their time frame | `history.treatment_goals`, e.g. "Reach overhead without pain in 4 weeks; return to soccer" |
| Plan: sessions per week, what will be done | `history.treatment_instructions`, e.g. "2 sessions a week" |

- `body_region` comes from the body part named: shoulder, elbow, wrist, hand = `upper_limb`;
  hip, knee, ankle, foot = `lower_limb`; neck, back = `spine`. Only missing if no body part was
  named at all.
- A sport the patient plays is lifestyle, not occupation ("runs marathons" =
  `lifestyle.activity`), unless the therapist says it is their job.
- `assessment.summary`: 2-3 sentences that repeat facts already in the record (who, what hurts,
  diagnosis, plan). No new interpretation, no prognosis, nothing that is not in the fields.

### Dates

- Convert spoken dates to YYYY-MM-DD ("born June 12 1985" = `1985-06-12`).
- Only an age ("she's 34") or no year: do NOT calculate a date. Leave `date_of_birth` out so it
  is asked for as missing.
- A number-only date where day and month could be swapped (3/4/1990): leave it out and ask.

## 2. Missing fields: ONE grouped question

1. Write the record to `tmp/<draft_id>.json`, run `check-intake --data-file tmp/<draft_id>.json`.
2. If `missing_required` is empty, go to "3. Duplicate check".
3. If something is missing and the draft's `missing_rounds` is 0:
   - `set-draft --draft-id ID --status awaiting_answers --missing-rounds 1 --data-file tmp/<draft_id>.json`
   - Reply with ONE message. Group the missing fields under these labels, in this order, and
     leave out any group with nothing missing. Use these plain words, never the field names:

     | Group | Field -> words |
     | --- | --- |
     | *Patient* | `full_name` name, `date_of_birth` date of birth, `phone` phone |
     | *Injury* | `reason_for_visit` reason for visit, `mechanism_of_injury` how it started, `body_region` body part, `pain.location` where it hurts, `pain.intensity_0_10` pain score 0-10 |
     | *History* | `allergies` allergies, `medications` medications, `surgeries` previous surgeries |
     | *Plan* | `pt_diagnosis` your PT diagnosis, `treatment_goals` treatment goals |

     If only an age was given, write "date of birth (you said 34, I need the full date)".

     Example (Valeria, missing phone, medications, surgeries, goals):

     ```
     Almost done with *Valeria Soto*. Missing:
     *Patient:* phone
     *History:* medications, previous surgeries
     *Plan:* treatment goals
     Answer by voice or text, or say *skip* to save without them.
     ```

## Answers to missing fields

The router sends the next message here when the draft is `awaiting_answers`.

1. Read the stored proposal from the draft (`context` shows it as `proposal`) and the new
   message.
2. Merge the answers into the proposal, using the same rules as step 1 ("no medications" =
   "None"). If the answer also corrects an earlier fact, apply the correction.
3. "Skip" (alone) = everything still missing stays not recorded. "Skip the phone" = only that
   one stays not recorded.
4. Do NOT ask a second time. Whatever is still missing is listed as *Not recorded* in the
   summary, and the therapist can still add it there as a correction.
5. Write the merged record to `tmp/<draft_id>.json` and go to "3. Duplicate check".

## 3. Duplicate check

1. `find-patient --query "<full_name>"`.
2. It is a possible duplicate if a match has the same full name (accents and case ignored) AND
   either the same date of birth or one of the two dates is unknown.
3. If so, `get-record --patient-id <match id> --notes 0` and compare it with the new record on
   phone, allergies, medications, surgeries, body region and PT diagnosis. A difference is a
   field both records have with a different meaning ("None" vs "Penicillin"). A field only one
   of them has is not a difference.
4. Add `"_possible_duplicate": {"id": "...", "full_name": "...", "date_of_birth": "...",
   "differences": ["allergies: you said none, the record says penicillin"]}` at the top level of
   the record (next to `patient`, `history`, `assessment`); `differences` is `[]` when there are
   none. Without a duplicate, make sure that key is not there.

## 4. Confirm

1. `set-draft --draft-id ID --status awaiting_confirmation --data-file tmp/<draft_id>.json`
2. Reply with a summary the therapist can check in 20 seconds. Use EXACTLY these lines, in
   this order, with these labels and no others. Leave out a line only when it has nothing to
   show (the first line, *Careful* and the last line are always there). Translate the labels
   when the language is `es`.

   ```
   New patient: *Diego Herrera*
   *Born:* 12 Jun 1985 · *Phone:* 55 4000 0001
   *Job:* chef, works standing all day
   *Reason:* right shoulder pain, after lifting a heavy pot about a month ago
   *Pain:* front and side of right shoulder, 6/10, worse reaching overhead
   *Exam:* painful arc 80-120°, Hawkins positive right, ER strength 4/5
   *PT diagnosis:* rotator cuff tendinopathy, right shoulder
   *Careful:* allergies none · medications none · surgeries none
   *Activity:* soccer, weekends
   *Goals:* reach overhead without pain in 4 weeks; back to soccer
   *Plan:* 2 sessions a week
   *Not recorded:* email, emergency contact, referring doctor
   Save? Reply *yes*, or tell me what to fix.
   ```

   - Source of each line: *Job* = occupation; *Reason* = reason for visit + how it started;
     *Pain* = location, score, what makes it worse or better; *Exam* = exam findings, shortened;
     *Activity* = lifestyle (sport, frequency, substance use); *Plan* = treatment instructions.
     Anything else that was recorded (family history, vital signs, studies, contacts) is saved
     but not shown.
   - *Careful* always shows allergies, medications and surgeries, with "not recorded" for any
     that are missing. Put an allergy first, it matters most.
   - *Not recorded*: first any required field still missing, then whichever of email,
     emergency contact and referring doctor were not mentioned. Nothing else.
   - With `_possible_duplicate`, replace the last line with:
     ```
     Already in the CRM: *Ana Lopez*, born 3 Mar 1991.
     Differs from that record: allergies (you said none, the record says penicillin)
     Reply *new* to save as a different patient, *same* to keep the existing record, or tell me what to fix.
     ```
     Leave out the "Differs" line when `differences` is empty.
3. A correction at this point ("her phone is 55 4000 0009", "it's the left knee"): update the
   record, run "3. Duplicate check" again if the name or date of birth changed, store it with
   `set-draft`, and show the full summary again.

## On yes

1. Without `_possible_duplicate`, "yes" (or "save", "sí", "va"):
   `create-patient --therapist-id ID --draft-id ID --data-file tmp/<draft_id>.json`
2. With `_possible_duplicate`:
   - "new" (or "different", "yes, new one"): same command with `--force`.
   - "same": `set-draft --draft-id ID --status cancelled`. Nothing from this intake is saved,
     and the existing record is not changed. Reply "Kept the existing record for *Name*. Nothing
     from this intake was saved. You can send session notes for them." If `differences` is not
     empty, add one line: "Still different: allergies (you said none, the record says
     penicillin). Send a session note if the record needs updating."
   - A plain "yes": ask once more, "Is this a *new* patient or the *same* *Ana Lopez*?"
3. If `create-patient` still reports a duplicate, ask the question in step 2.
4. Reply: "Saved *Name*. You can now send session notes or ask for a summary."

## Checklist (Workstream 1)

- [ ] `i1_complete`: no missing-fields question, saved record matches `expected/i1_record.json`.
- [ ] `i2_missing` + `i2_answers`: ONE question asking exactly phone, medications, previous
      surgeries, treatment goals; saved record matches `expected/i2_record.json`.
- [ ] `i3_age_only`: asks for the date of birth, never calculates it.
- [ ] `i4_duplicate`: the summary flags the seeded Ana Lopez; "same" saves nothing.
- [ ] Every saved field appears in the voice notes.
