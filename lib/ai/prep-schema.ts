import { z } from "zod";

// Flow E (prepare a session): what the model writes. Code renders every fact; the model only
// condenses the last note into one line and suggests a focus, citing the facts it used
// (1-based numbers of the fact list). Code drops anything uncited or with invented numbers.

export const PrepBriefSchema = z.object({
  last_session: z.string().nullable(),
  suggestions: z.array(
    z.object({
      focus: z.string(),
      facts: z.array(z.number().int()),
    }),
  ),
});
export type PrepBriefAi = z.infer<typeof PrepBriefSchema>;
