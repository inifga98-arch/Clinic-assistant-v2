// What the therapist is offered after saving something (pure). The likely next step for the
// same patient, the main menu, and a way out. No runtime "@/" imports so the checks can test it.

import type { Option } from "../../whatsapp/options";

export type NextStepKind = "after_eval" | "after_note" | "after_later";

const MENU: Option = { id: "menu", title: "Menú principal", icon: "🏠" };
const DONE: Option = { id: "done", title: "Es todo", icon: "✅" };

export const NEXT_OPTIONS: Record<NextStepKind, Option[]> = {
  // An initial evaluation is usually the first visit: the session note comes next.
  after_eval: [{ id: "note_same", title: "Nota de esta sesión", icon: "📝" }, MENU, DONE],
  after_note: [{ id: "note_other", title: "Nota de otro paciente", icon: "📝" }, MENU, DONE],
  after_later: [{ id: "note_any", title: "Nota de sesión", icon: "📝" }, MENU, DONE],
};

export const DONE_TEXT = "Listo. Aquí estoy cuando me necesites.";

/** One message: what was just done, then the question. */
export function nextStepText(kind: NextStepKind, lead: string, patientName: string | null): string {
  const question = kind === "after_eval" && patientName ? `¿Algo más con *${patientName}*?` : "¿Algo más?";
  return `${lead}\n\n${question}`;
}
