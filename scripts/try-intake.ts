// Manual smoke test for Flow A's AI calls (real OpenAI key, no DB, synthetic forms only).
//   node --conditions=react-server --env-file=.env.local --import tsx scripts/try-intake.ts [blurry]
import { readFileSync } from "node:fs";
import { extractEvaluation, extractRegistration, reviseEvaluation } from "@/lib/ai/intake-extract";
import { evaluationGaps, parsePatientPhone } from "@/lib/agents/therapist/intake-logic";
import { mergeRevision } from "@/lib/agents/therapist/note-draft";

const page = (name: string) => ({ data: readFileSync(`test_inputs/ws1_intake/forms/${name}`), contentType: "image/jpeg" });

async function main() {
  if (process.argv[2] === "blurry") {
    const e = await extractEvaluation({ images: [page("mi_p1_borrosa.jpg")] }, "Laura Méndez");
    console.log("BLURRY unreadable:", e.unreadable);
    console.log("  name:", e.identification.full_name, "dob:", e.identification.dob, "allergies:", e.pathological.allergies);
    return;
  }

  const r = await extractRegistration("Laura Méndez, 55 1234 5678, viene por la rodilla derecha");
  console.log("REGISTRATION", r, "→ phone", parsePatientPhone(r.phone));
  const fixed = await extractRegistration("el número termina en 79, no en 78", { ...r, phone: "55 1234 5678" });
  console.log("REGISTRATION FIX", fixed);

  const e = await extractEvaluation({ images: [page("mi_p1.jpg"), page("mi_p2.jpg"), page("mi_p3.jpg")] }, "Laura Méndez");
  console.log("EVALUATION", JSON.stringify(e, null, 1));
  console.log("GAPS (expect []):", evaluationGaps(e));

  const rev = await reviseEvaluation(e, "la dorsiflexión izquierda fue 12 grados, no 10", "Laura Méndez");
  const merged = mergeRevision(e, rev.evaluation, rev.changed);
  console.log("REVISION changed:", rev.changed, "applied:", merged.applied);
  console.log("  goniometry:", JSON.stringify(merged.note.exam.goniometry));
  console.log("  chief complaint unchanged:", merged.note.chief_complaint === e.chief_complaint);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
