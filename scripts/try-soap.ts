// Manual smoke test for Flow B's AI calls (uses the real OpenAI key, no DB).
//   node --conditions=react-server --env-file=.env.local --import tsx scripts/try-soap.ts
import { extractSoap, reviseSoap, type NoteContext } from "@/lib/ai/soap-extract";
import { mergeRevision, missingItems } from "@/lib/agents/therapist/note-draft";

const ctx: NoteContext = {
  patientName: "Ana López",
  diagnosis: "Esguince grado I del ligamento colateral medial, rodilla derecha",
  activePlan: ["Elevación de pierna recta 3×12, diario", "Sentadilla en pared 3×30 s, diario"],
};
const transcripts = [
  "Ana López, rodilla derecha. Refiere dolor al subir escaleras, corrió 15 minutos el domingo. Flexión 115, extensión menos 3, cuádriceps 4 de 5. Hicimos terapia manual.",
  "Plan: elevación de pierna recta 3 por 12 diario, sentadilla en pared 3 por 30 segundos diario, dos visitas por semana.",
];

async function main() {
  const x = await extractSoap(transcripts, ctx);
  console.log("EXTRACTION", JSON.stringify(x, null, 2));
  console.log("MISSING (expect pain_nprs, assessment):", missingItems(x));

  for (const instruction of ["Pregunta: ¿Qué dolor reportó hoy, del 0 al 10? Respuesta: más o menos 4", "quita la sentadilla"]) {
    const r = await reviseSoap(x, instruction, ctx);
    const merged = mergeRevision(x, r.note, r.changed);
    console.log(`\nREVISION «${instruction}» changed=`, r.changed, "applied=", merged.applied);
    console.log("  pain:", merged.note.subjective.pain_nprs, "exercises:", merged.note.plan.home_exercises.map((e) => e.name));
    console.log("  summary unchanged:", merged.note.subjective.summary === x.subjective.summary);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
