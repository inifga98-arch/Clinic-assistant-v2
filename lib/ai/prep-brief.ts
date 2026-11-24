import "server-only";
import { zodResponseFormat } from "openai/helpers/zod";
import { optionalEnv } from "@/lib/env";
import { openai } from "./openai";
import { PrepBriefSchema, type PrepBriefAi } from "./prep-schema";

// Flow E AI call (T-10). The model only condenses the last note and suggests a focus; every
// fact in the brief is rendered by code (lib/agents/therapist/prep-format.ts) and the guards
// in prep-logic.ts drop any line that cites no fact or contains a number not in the facts.

const SYSTEM = `Eres el asistente de un fisioterapeuta en México. Antes de la sesión recibes hechos numerados sobre un paciente.
Devuelve:
- last_session: una línea corta (máximo 25 palabras) con lo clave de la última nota: hallazgos medidos (arcos, fuerza, pruebas) y lo acordado para la siguiente sesión. No repitas el dolor. Copia los números exactamente como aparecen. null si no hay nota.
- suggestions: hasta 3 focos para la sesión de hoy, de máximo 8 palabras cada uno, empezando con un verbo en infinitivo (revalorar, bajar, revisar, hablar de…). En "facts" pon los números de los hechos en que se basa cada uno.
Reglas: usa solo los hechos dados. No diagnostiques, no inventes datos, números, ejercicios ni cargas nuevas. Si hay una alerta, la primera sugerencia es revisarla. Español técnico de México, breve.`;

export async function writePrepBrief(facts: string[]): Promise<PrepBriefAi> {
  const completion = await openai().chat.completions.parse({
    model: optionalEnv("OPENAI_EXTRACT_MODEL", "gpt-4.1"),
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: numberedFacts(facts) },
    ],
    response_format: zodResponseFormat(PrepBriefSchema, "prep_brief"),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("prep: no parse");
  return parsed;
}

/** "1. …\n2. …": the same text the guards check numbers against. */
export function numberedFacts(facts: string[]): string {
  return facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
}
