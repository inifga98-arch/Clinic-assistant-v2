// "Ask about a patient" messages and guards (pure). No runtime "@/" imports so
// scripts/check-ask.mts can test it.

import type { Option } from "../../whatsapp/options";
import { normalize } from "../patient/signals";
import { groundedLine } from "./prep-logic";
import type { RecordEntry } from "./record-format";

export const ASK_OPTIONS: Option[] = [
  { id: "note_same", title: "Nota de esta sesión", icon: "📝" },
  { id: "menu", title: "Menú principal", icon: "🏠" },
];

export const ASK_PROMPT = "Escribe o di otra pregunta, o:";
export const NOT_IN_RECORD = "📂 No lo encuentro en el expediente.";
export const SUGGESTION_LABEL = "💡 *Sugerencia de la IA (no es del expediente):*";

const MAX_STATEMENTS = 6;
/** Advice phrased as a fact ("debe ser prioridad", "se recomienda"): it belongs in the 💡 suggestion. */
const ADVICE = /\b(debe|deben|deber[ií]a|deber[ií]an|se recomienda|recomiendo|recomendable|conviene|sugiero|se sugiere|es importante|hay que|prioridad|priorizar)\b/i;
/** The answer goes with ASK_PROMPT and the options in one message (1,600 characters). */
export const ANSWER_MAX = 1400;

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);
const sentence = (t: string) => {
  const s = t.trim().replace(/[.;\s]+$/, "");
  return s ? `${s}.` : "";
};

export function askIntro(patientName: string): string {
  return `💬 Pregúntame lo que quieras sobre *${patientName}*: sesiones, plan, dolor, ejercicios… por texto o nota de voz.`;
}

const NOT_QUESTIONS = new Set(
  ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "ok", "okay", "va", "gracias", "listo", "si", "no", "sale"].map(normalize),
);

/** "ok", "gracias", "hola": not a question even while asking. */
export function isSmallTalk(text: string): boolean {
  return NOT_QUESTIONS.has(normalize(text.trim()));
}

/** After the brief: is this typed text a question about the patient (rather than a greeting or one word)? */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || isSmallTalk(t)) return false;
  return /[?¿]/.test(t) || t.split(/\s+/).length >= 3;
}

/**
 * Record statements that cite at least one real entry (1-based) and whose numbers and dates all
 * appear in the entries they cite. The sources shown are those entries' labels, made by code.
 */
export function groundedStatements(
  statements: { text: string; sources: number[] }[],
  entries: RecordEntry[],
): { text: string; sources: string[] }[] {
  const out: { text: string; sources: string[] }[] = [];
  for (const s of statements) {
    const ids = [...new Set(s.sources)].filter((n) => Number.isInteger(n) && n >= 1 && n <= entries.length).sort((a, b) => a - b);
    if (!ids.length || ADVICE.test(s.text)) continue;
    const cited = ids.map((i) => `[${entries[i - 1].label}] ${entries[i - 1].text}`).join("\n");
    const text = groundedLine(s.text, cited);
    if (text) out.push({ text: clip(sentence(text), 220), sources: [...new Set(ids.map((i) => entries[i - 1].label))] });
    if (out.length === MAX_STATEMENTS) break;
  }
  return out;
}

/** The answer: what the record says (with sources), then the AI's suggestion, always labelled. */
export function formatAnswer(statements: { text: string; sources: string[] }[], suggestion: string | null): string {
  const lines = statements.length
    ? ["📂 *Según el expediente:*", ...statements.map((s) => `• ${s.text} (${s.sources.join("; ")})`)]
    : [NOT_IN_RECORD];
  const idea = suggestion?.trim();
  if (idea) {
    const text = sentence(clip(idea, 300)).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
    lines.push("", `${SUGGESTION_LABEL} ${text}`);
  }
  const answer = lines.join("\n");
  return answer.length > ANSWER_MAX ? clip(answer, ANSWER_MAX) : answer;
}
