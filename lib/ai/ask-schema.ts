import { z } from "zod";

// "Ask about a patient": what the model returns. Record statements cite the numbered entries of
// the patient's record; code drops any that cite nothing real or carry a number not in the cited
// entries, and renders the sources itself. The suggestion is the model's opinion, always labelled.

export const AskAnswerSchema = z.object({
  statements: z.array(
    z.object({
      text: z.string(),
      sources: z.array(z.number().int()),
    }),
  ),
  suggestion: z.string().nullable(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;
