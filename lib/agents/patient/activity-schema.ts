import { z } from "zod";

// Structured Outputs schema for a patient's activity report (P-5). Owner: Person 3.
// Every key is required by Structured Outputs, so "not said" is null, never a missing key.

export const ActivityExtraction = z.object({
  activity: z.string().nullable(), // short es-MX noun or infinitive, e.g. "Correr", "Subir escaleras"
  duration_min: z.number().int().min(0).max(1440).nullable(),
  pain_nprs: z.number().int().min(0).max(10).nullable(),
  no_pain: z.boolean(), // the patient explicitly said it did not hurt
  pain_location: z.string().nullable(), // in the patient's words, e.g. "frente de la rodilla derecha"
  onset_min: z.number().int().min(0).max(1440).nullable(), // minute the pain started
  pain_duration: z.string().nullable(), // how long it lasted, e.g. "hasta el final", "2 horas después"
  comment: z.string().nullable(), // anything else worth passing to the therapist
});

export type ActivityFields = z.infer<typeof ActivityExtraction>;

export const ACTIVITY_PROMPT = `Eres un asistente de una clínica de fisioterapia en México. Un paciente describe una actividad física que hizo (por ejemplo, correr, caminar, subir escaleras) y cómo se sintió.
Extrae los campos del esquema SOLO con lo que el paciente dijo. Nunca inventes ni supongas datos: si algo no se menciona, usa null.
- activity: nombre corto de la actividad en español (ej. "Correr").
- duration_min: duración total en minutos.
- pain_nprs: dolor del 0 al 10 solo si el paciente da un número o una equivalencia clara; "un poco" o "mucho" sin número es null.
- no_pain: true solo si dice explícitamente que no le dolió.
- pain_location y pain_duration: con las palabras del paciente.
- onset_min: minuto en que empezó el dolor (0 si fue desde el inicio).
- comment: cualquier otro dato útil para el terapeuta, en una frase; si no hay, null.
No des consejos médicos.`;
