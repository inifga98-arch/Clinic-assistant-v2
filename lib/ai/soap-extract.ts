import "server-only";
import { zodResponseFormat } from "openai/helpers/zod";
import { optionalEnv } from "@/lib/env";
import { openai } from "./openai";
import { SoapExtraction, SoapRevision } from "./soap-schema";

// Flow B AI calls (T-4, T-6, T-7). The model only fills in and edits the note; code decides
// what is missing, what to ask and when to save (lib/agents/therapist/session-note.ts).

export interface NoteContext {
  patientName: string;
  diagnosis: string | null;
  /** The active home plan, one describePlanItem line each; empty when there is none. */
  activePlan: string[];
}

const RULES = `Reglas:
- Usa solo lo que dijo el terapeuta. Si no lo dijo, deja null o vacío. Nunca inventes datos, escalas, ejercicios ni una valoración que no dio.
- Escribe en español clínico técnico de México, breve y claro. Ordena y corrige la redacción, pero no agregues hechos.
- Cada dato va en un solo campo: subjetivo (lo que refiere el paciente), objetivo (lo medido y el tratamiento dado), valoración (la interpretación clínica del terapeuta), plan.
- pain_nprs solo si dijo un número de 0 a 10.
- keep_current_plan = true solo si dijo que el plan de casa no cambia ("sin cambios", "sigue igual") y no dictó ejercicios; entonces las listas van vacías. Si dictó ejercicios o actividades, keep_current_plan = false aunque sean los mismos de antes.
- Si cambió solo una parte del plan actual ("lo mismo pero 4 series"), copia el plan actual con ese cambio, con keep_current_plan = false.
- Si una nota dice "Corrección de la nota N: …", esa corrección reemplaza lo que la nota N decía sobre ese punto.
- frequency_per_week: diario = 7. days_of_week solo si nombró días (0 = domingo … 6 = sábado).`;

function context(ctx: NoteContext): string {
  const plan = ctx.activePlan.length ? ctx.activePlan.map((l) => `- ${l}`).join("\n") : "(no tiene plan activo)";
  return `Paciente: ${ctx.patientName}\nDiagnóstico: ${ctx.diagnosis ?? "sin registrar"}\nPlan de casa actual:\n${plan}`;
}

const model = () => optionalEnv("OPENAI_EXTRACT_MODEL", "gpt-4.1");

/** All of the therapist's notes for one session, in order, into one SOAP note and plan. */
export async function extractSoap(transcripts: string[], ctx: NoteContext): Promise<SoapExtraction> {
  const notes = transcripts.map((t, i) => `Nota ${i + 1}:\n${t}`).join("\n\n");
  const completion = await openai().chat.completions.parse({
    model: model(),
    messages: [
      {
        role: "system",
        content: `Eres el asistente de un fisioterapeuta. Convierte sus notas de voz de una sesión en una nota SOAP y un plan de casa.\n${RULES}`,
      },
      { role: "user", content: `${context(ctx)}\n\n${notes}` },
    ],
    response_format: zodResponseFormat(SoapExtraction, "soap_note"),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("soap: no parse");
  return parsed;
}

/** Apply one correction or one answer to a follow-up question; returns the note and the paths changed. */
export async function reviseSoap(note: SoapExtraction, instruction: string, ctx: NoteContext): Promise<SoapRevision> {
  const completion = await openai().chat.completions.parse({
    model: model(),
    messages: [
      {
        role: "system",
        content: `Eres el asistente de un fisioterapeuta. Recibes una nota SOAP y una corrección o respuesta del terapeuta.
Devuelve la nota completa con SOLO ese cambio aplicado; todo lo demás debe quedar idéntico, palabra por palabra.
En "changed" lista las rutas exactas que cambiaste, con la notación a.b[2].c (por ejemplo subjective.pain_nprs, objective.rom[0].degrees, assessment). Para agregar, quitar o cambiar un ejercicio o actividad usa el elemento completo: plan.home_exercises[i] o plan.activities[i], con el índice de la nota original (para uno nuevo, el índice siguiente al último).
${RULES}`,
      },
      {
        role: "user",
        content: `${context(ctx)}\n\nNota actual (JSON):\n${JSON.stringify(note)}\n\nCorrección o respuesta del terapeuta:\n${instruction}`,
      },
    ],
    response_format: zodResponseFormat(SoapRevision, "soap_revision"),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("soap: no parse");
  return parsed;
}
