// "Ask about a patient" messages and guards (pure). No runtime "@/" imports so
// scripts/check-ask.mts can test it.

import type { Option } from "../../whatsapp/options";
import { normalize } from "../patient/signals";
import { groundedLine, groundedOpinion } from "./prep-logic";
import type { RecordEntry } from "./record-format";

export const ASK_OPTIONS: Option[] = [
  { id: "note_same", title: "Nota de esta sesión", icon: "📝" },
  { id: "menu", title: "Menú principal", icon: "🏠" },
];

export const ASK_PROMPT = "Escribe o di otra pregunta, o:";
export const NOT_IN_RECORD = "📂 No lo encuentro en el expediente.";
/** The model answered from the record but nothing passed the checks: don't claim the record lacks it. */
export const NOT_CONFIRMED = "📂 No pude confirmarlo en el expediente.";
/** A statement counts at most this many sources (citing everything would allow any number). */
const MAX_SOURCES = 3;
export const SUGGESTION_LABEL = "💡 *Sugerencia de la IA (no es del expediente):*";

const MAX_STATEMENTS = 6;
/** Advice phrased as a fact ("debe ser prioridad", "se recomienda"): it belongs in the 💡 suggestion. */
const ADVICE = /\b(debe|deben|deber[ií]a|deber[ií]an|se recomienda|recomiendo|recomendable|conviene|sugiero|se sugiere|es importante|hay que|prioridad|priorizar)\b/i;
/** The answer goes with ASK_PROMPT and the options in one message (1,600 characters). */
export const ANSWER_MAX = 1400;

/** Cut between words, never inside a value like "3/10". */
const clip = (t: string, max: number) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:]$/, "")}…`;
};
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
  if (/^nota\b/i.test(normalize(t))) return false; // "nota para Laura…" is about a session note
  return /[?¿]/.test(t) || t.split(/\s+/).length >= 3;
}

/** The 💡 suggestion, unless it states a record fact (date, score, degrees) that isn't in the record. */
export function groundedSuggestion(suggestion: string | null | undefined, recordText: string): string | null {
  return groundedOpinion(suggestion, recordText);
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
    const ids = [...new Set(s.sources)]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= entries.length)
      .slice(0, MAX_SOURCES)
      .sort((a, b) => a - b);
    if (!ids.length) continue;
    const cited = ids.map((i) => `[${entries[i - 1].label}] ${entries[i - 1].text}`).join("\n");
    // Advice phrased as a fact goes to the suggestion, unless it is quoted from the record ("A: Debe evitar correr").
    const advice = s.text.match(ADVICE)?.[0];
    if (advice && !cited.toLowerCase().includes(advice.toLowerCase())) continue;
    const text = groundedLine(s.text, cited);
    if (text) out.push({ text: clip(sentence(text), 220), sources: [...new Set(ids.map((i) => entries[i - 1].label))] });
    if (out.length === MAX_STATEMENTS) break;
  }
  return out;
}

/** The answer: what the record says (with sources), then the AI's suggestion, always labelled. */
export function formatAnswer(
  statements: { text: string; sources: string[] }[],
  suggestion: string | null,
  /** The model gave record statements but none passed the checks. */
  allDropped = false,
): string {
  const lines = statements.length
    ? ["📂 *Según el expediente:*", ...statements.map((s) => `• ${s.text} (${s.sources.join("; ")})`)]
    : [allDropped ? NOT_CONFIRMED : NOT_IN_RECORD];
  const idea = suggestion?.trim();
  if (idea) {
    const text = sentence(clip(idea, 300)).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
    lines.push("", `${SUGGESTION_LABEL} ${text}`);
  }
  const answer = lines.join("\n");
  return answer.length > ANSWER_MAX ? clip(answer, ANSWER_MAX) : answer;
}
