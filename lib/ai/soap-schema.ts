import { z } from "zod";

// SOAP + home plan schema for Flow B. Owner: Person 1.
// Used with OpenAI Structured Outputs (zodResponseFormat from "openai/helpers/zod").
// Structured Outputs needs every key present, so "unknown" is null, never a missing key.
// What counts as missing is decided by code (lib/agents/therapist/note-draft.ts), not the model.

const DaysOfWeek = z
  .array(z.number().int().min(0).max(6))
  .nullable()
  .describe("Solo si el terapeuta nombró días (0 = domingo … 6 = sábado); si no, null");

const Exercise = z.object({
  name: z.string(),
  sets: z.number().int().nullable(),
  reps: z.number().int().nullable(),
  hold_seconds: z.number().int().nullable(),
  frequency_per_week: z.number().int().nullable(),
  days_of_week: DaysOfWeek,
  instructions: z.string().nullable(),
});

const Activity = z.object({
  name: z.string(), // e.g. "Correr"
  target: z.string().nullable(), // e.g. "20 min"
  frequency_per_week: z.number().int().nullable(),
  report: z.array(z.enum(["pain_nprs", "location", "onset_min"])),
  days_of_week: DaysOfWeek,
  instructions: z.string().nullable(),
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
  assessment: z.string().describe("Lenguaje clínico, solo lo que dijo el terapeuta; vacío si no dio valoración"),
  plan: z.object({
    visits_per_week: z.number().int().nullable(),
    next_session_focus: z.string().nullable(),
    keep_current_plan: z.boolean().describe("true solo si el terapeuta dijo que el plan de casa no cambia"),
    home_exercises: z.array(Exercise),
    activities: z.array(Activity),
  }),
});

export type SoapExtraction = z.infer<typeof SoapExtraction>;

/** A correction or answer applied to a note: the whole note back, plus the paths changed. */
export const SoapRevision = z.object({
  note: SoapExtraction,
  changed: z
    .array(z.string())
    .describe("Rutas exactas que cambiaste, p. ej. objective.rom[0].degrees o plan.home_exercises[1]"),
});

export type SoapRevision = z.infer<typeof SoapRevision>;
