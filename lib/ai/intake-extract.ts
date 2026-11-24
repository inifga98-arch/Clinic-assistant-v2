import "server-only";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { reconcileReadings } from "@/lib/agents/therapist/intake-logic";
import { optionalEnv } from "@/lib/env";
import { EvaluationExtraction, EvaluationRevision, RegistrationExtraction } from "./intake-schema";
import { openai } from "./openai";

// Flow A AI calls. The model only reads and fills in; code decides what is missing, what to show
// and when to save (lib/agents/therapist/new-patient.ts, initial-eval.ts).

const model = () => optionalEnv("OPENAI_EXTRACT_MODEL", "gpt-4.1");

const READING_RULES = `Reglas:
- Usa solo lo que está escrito o lo que dijo el terapeuta. Nunca inventes ni deduzcas datos.
- Si un campo está vacío o no se mencionó: null (o lista vacía).
- Si dice "niega", "negado", "ninguno", "no", o está tachado: escribe exactamente "Niega".
- Si un campo está escrito pero no se puede leer: null, y agrega el nombre del campo a "unreadable".
- Números, fechas y teléfonos: solo si puedes leer CADA dígito con certeza. Si un dígito está borroso o
  dudas, deja el campo en null y agrégalo a "unreadable" (p. ej. "fecha de nacimiento"). Un dato
  equivocado en un expediente clínico es mucho peor que uno vacío: nunca adivines ni completes.
- Fechas en formato YYYY-MM-DD. Copia nombres, números y unidades tal como están (p. ej. "110°", "6/10" → 6).
- Copia los nombres propios letra por letra, sin agregar ni quitar acentos (si dice "Ruiz", escribe "Ruiz").
- form_region según el título: "HISTORIA CLÍNICA MS" = upper_limb, "MI" = lower_limb, "Columna" = spine.
- AHF: una entrada por padecimiento marcado, con los familiares marcados.
- Goniometría, fuerza y pruebas: una fila por movimiento o prueba con algún valor; derecha e izquierda por separado.
- No incluyas la evaluación final, la bitácora de sesiones ni el consentimiento.`;

function parsed<T>(value: T | null | undefined): T {
  if (!value) throw new Error("intake: no parse");
  return value;
}

/** Name, WhatsApp and reason from what the therapist said; with `current`, apply a correction. */
export async function extractRegistration(
  text: string,
  current?: RegistrationExtraction,
): Promise<RegistrationExtraction> {
  const user = current
    ? `Datos actuales (JSON): ${JSON.stringify(current)}\nCorrección del terapeuta: ${text}\nDevuelve los datos con la corrección aplicada; lo demás igual.`
    : `Mensaje del terapeuta: ${text}`;
  const completion = await openai().chat.completions.parse({
    model: model(),
    messages: [
      {
        role: "system",
        content:
          "Un fisioterapeuta registra a un paciente nuevo. Extrae el nombre completo, el número de WhatsApp " +
          "(solo dígitos y +, tal como lo dijo; si lo dijo con palabras, escríbelo en dígitos) y el motivo breve " +
          "si lo dijo. Si falta algo, null. No inventes.",
      },
      { role: "user", content: user },
    ],
    response_format: zodResponseFormat(RegistrationExtraction, "registration"),
  });
  return parsed(completion.choices[0]?.message.parsed);
}

/**
 * The clinic's Historia Clínica, from photos of the paper form or from voice-note transcripts.
 * Photos are read twice in parallel: on a blurry page the model guesses digits differently each
 * time, so any number, date or test result the two reads disagree on is blanked and listed as
 * unreadable (reconcileReadings). Voice transcripts are read once.
 */
export async function extractEvaluation(
  input: { images: { data: Buffer; contentType: string }[] } | { transcripts: string[] },
  patientName: string,
): Promise<EvaluationExtraction> {
  if ("images" in input) {
    const [a, b] = await Promise.all([readOnce(input, patientName), readOnce(input, patientName)]);
    return reconcileReadings(a, b);
  }
  return readOnce(input, patientName);
}

async function readOnce(
  input: { images: { data: Buffer; contentType: string }[] } | { transcripts: string[] },
  patientName: string,
): Promise<EvaluationExtraction> {
  const content: ChatCompletionContentPart[] =
    "images" in input
      ? [
          { type: "text", text: `Paciente: ${patientName}. Estas son las hojas de su historia clínica, en orden.` },
          ...input.images.map(
            (img): ChatCompletionContentPart => ({
              type: "image_url",
              image_url: { url: `data:${img.contentType};base64,${img.data.toString("base64")}`, detail: "high" },
            }),
          ),
        ]
      : [
          {
            type: "text",
            text: `Paciente: ${patientName}. Notas del terapeuta sobre la valoración inicial, en orden:\n\n${input.transcripts
              .map((t, i) => `Nota ${i + 1}:\n${t}`)
              .join("\n\n")}`,
          },
        ];
  const completion = await openai().chat.completions.parse({
    model: model(),
    messages: [
      {
        role: "system",
        content:
          "Eres el asistente de una clínica de fisioterapia en México. Llena la historia clínica estructurada " +
          `a partir de ${"images" in input ? "las fotos del formato en papel" : "lo que dictó el terapeuta"}.\n${READING_RULES}` +
          ("images" in input
            ? ""
            : '\nEn notas de voz no hay secciones ilegibles: "unreadable" va vacío. Si una nota dice "Corrección de la nota N", esa corrección reemplaza lo que decía la nota N.'),
      },
      { role: "user", content },
    ],
    response_format: zodResponseFormat(EvaluationExtraction, "evaluation"),
  });
  return parsed(completion.choices[0]?.message.parsed);
}

/** Apply one correction; returns the whole evaluation and the paths changed. */
export async function reviseEvaluation(
  e: EvaluationExtraction,
  instruction: string,
  patientName: string,
): Promise<EvaluationRevision> {
  const completion = await openai().chat.completions.parse({
    model: model(),
    messages: [
      {
        role: "system",
        content:
          "Recibes la historia clínica estructurada de un paciente y una corrección del fisioterapeuta. " +
          "Devuelve la historia completa con SOLO ese cambio aplicado; todo lo demás idéntico, palabra por palabra. " +
          'En "changed" lista las rutas exactas que cambiaste con la notación a.b[2].c (p. ej. exam.goniometry[0].left, ' +
          "pathological.allergies). Para agregar o quitar una fila de una lista usa el elemento completo, p. ej. " +
          "exam.orthopedic_tests[3], con el índice de la historia original (para una fila nueva, el índice siguiente al último).\n" +
          READING_RULES,
      },
      {
        role: "user",
        content: `Paciente: ${patientName}\n\nHistoria actual (JSON):\n${JSON.stringify(e)}\n\nCorrección del terapeuta:\n${instruction}`,
      },
    ],
    response_format: zodResponseFormat(EvaluationRevision, "evaluation_revision"),
  });
  return parsed(completion.choices[0]?.message.parsed);
}
