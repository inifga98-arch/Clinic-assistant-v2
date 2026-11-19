import { z } from "zod";

// SOAP + home plan extraction schema (PRD "Data model", first draft). Owner: Person 1.
// Used with OpenAI Structured Outputs (zodResponseFormat from "openai/helpers/zod").
// Structured Outputs needs every key present, so "unknown" is null, never a missing key.
// The clinic's paper form decides the final required fields (PRD open question).

const Exercise = z.object({
  name: z.string(),
  sets: z.number().int().nullable(),
  reps: z.number().int().nullable(),
  hold_seconds: z.number().int().nullable(),
  frequency_per_week: z.number().int().nullable(),
});

const Activity = z.object({
  name: z.string(), // e.g. "Correr"
  target: z.string().nullable(), // e.g. "20 min"
  frequency_per_week: z.number().int().nullable(),
  report: z.array(z.enum(["pain_nprs", "location", "onset_min"])),
});

export const SoapExtraction = z.object({
  subjective: z.object({
    summary: z.string(),
    pain_nprs: z.number().int().min(0).max(10).nullable(),
    aggravating: z.array(z.string()),
    functional_limits: z.array(z.string()),
  }),
  objective: z.object({
    rom: z.array(z.object({ joint: z.string(), movement: z.string(), degrees: z.number() })),
    strength: z.array(z.object({ muscle: z.string(), grade_0_5: z.number() })),
    special_tests: z.array(z.string()),
    treatment_given: z.array(z.string()),
  }),
  assessment: z.string().describe("Clinical language, only facts the therapist said"),
  plan: z.object({
    visits_per_week: z.number().int().nullable(),
    next_session_focus: z.string().nullable(),
    home_exercises: z.array(Exercise),
    activities: z.array(Activity),
  }),
  missing_required: z.array(z.string()).describe("Required fields the agent must ask about"),
});

export type SoapExtraction = z.infer<typeof SoapExtraction>;

/** Required on every note (T-5). Starting point; confirm against the clinic's paper form. */
export const REQUIRED_FIELDS = ["subjective.pain_nprs", "assessment", "plan"] as const;
