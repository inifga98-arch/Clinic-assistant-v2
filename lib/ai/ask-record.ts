import "server-only";
import { zodResponseFormat } from "openai/helpers/zod";
import { optionalEnv } from "@/lib/env";
import { AskAnswerSchema, type AskAnswer } from "./ask-schema";
import { openai } from "./openai";

// "Ask about a patient" AI call. The model answers a therapist's question from the numbered
// record; code keeps only statements grounded in the entries they cite
// (lib/agents/therapist/ask-format.ts) and labels the suggestion as the AI's opinion.

const SYSTEM = `Eres el asistente clínico de un fisioterapeuta en México. Respondes sus preguntas sobre el expediente de un paciente.
Recibes el expediente en entradas numeradas ([etiqueta] texto), las preguntas anteriores de esta conversación y la pregunta nueva.
Devuelve:
- statements: lo que dice el expediente para responder, en frases cortas (máximo 25 palabras cada una, máximo 5 frases). En "sources" pon los números de las entradas en que se basa cada frase. Copia números, escalas y fechas exactamente como aparecen en esas entradas (fechas como «20 nov»). Nada que no esté en las entradas citadas. No escribas la fuente ni la fecha entre paréntesis al final de la frase: el sistema agrega la fuente. Si la pregunta es sobre qué hacer, pon aquí los datos del expediente que importan para decidir (plan actual, cumplimiento y comentarios del paciente, dolor, alertas). Si el expediente no tiene nada relacionado, deja statements vacío; no adivines.
- suggestion: tu opinión clínica breve (máximo 40 palabras) solo si la pregunta pide qué hacer o una opinión, o si ves algo en el expediente que el terapeuta debería considerar para esta pregunta; si no, null. Es una sugerencia para el terapeuta, razonada con el expediente, nunca un diagnóstico definitivo.
Español técnico de México, directo.`;

export interface AskTurn {
  q: string;
  a: string;
}

export async function answerFromRecord(record: string, history: AskTurn[], question: string): Promise<AskAnswer> {
  const previous = history.length
    ? `Preguntas anteriores:\n${history.map((t) => `P: ${t.q}\nR: ${t.a}`).join("\n\n")}\n\n`
    : "";
  const completion = await openai().chat.completions.parse(
    {
      model: optionalEnv("OPENAI_EXTRACT_MODEL", "gpt-4.1"),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Expediente:\n${record}\n\n${previous}Pregunta: ${question}` },
      ],
      response_format: zodResponseFormat(AskAnswerSchema, "ask_answer"),
    },
    // Inside the webhook's 60 s even after a voice transcription; no retry.
    { timeout: 25_000, maxRetries: 0 },
  );
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("ask: no parse");
  return parsed;
}
