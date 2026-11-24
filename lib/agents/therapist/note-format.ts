// Flow B messages (pure): the review of the note and plan (T-7) and the per-note ack.
// No runtime "@/" imports so scripts/check-flow-b.mts can test it.

import type { SoapExtraction } from "../../ai/soap-schema";
import type { Option } from "../../whatsapp/send";
import { MISSING_LABELS, describePlanItem, planHeadline, toPlanItems, type MissingItem } from "./note-draft";

/** Twilio's cap for one WhatsApp message body. */
export const MAX_MESSAGE = 1600;
/** Room left in the last message for the numbered options. */
export const OPTIONS_ROOM = 60;

export const REVIEW_OPTIONS: Option[] = [
  { id: "confirm", title: "Confirmar", icon: "✅" },
  { id: "edit", title: "Editar", icon: "✏️" },
  { id: "discard", title: "Descartar", icon: "🗑️" },
];

export const RECORDING_OPTIONS: Option[] = [
  { id: "done", title: "Listo", icon: "✅" },
  { id: "more", title: "Agregar otra", icon: "➕" },
];

/** After a voice note: Corregir lets the therapist fix what the transcription got wrong. */
export const VOICE_OPTIONS: Option[] = [...RECORDING_OPTIONS, { id: "fix", title: "Corregir", icon: "✏️" }];

/** Sent when a note starts, so notes come in complete and in SOAP order. */
export const SOAP_GUIDE = [
  "Para una nota completa, cuéntame en este orden:",
  "🗣️ *S – Subjetivo:* qué refiere el paciente y su dolor de hoy (0 a 10).",
  "🔍 *O – Objetivo:* lo que mediste (arcos, fuerza, pruebas) y el tratamiento que diste.",
  "🧠 *A – Valoración:* cómo va y por qué.",
  "📋 *P – Plan:* visitas por semana y ejercicios para casa (series × repeticiones, frecuencia), o «sin cambios».",
  "",
  "Manda una nota de voz o varias, o escríbela. Cuando termines, responde *Listo*.",
].join("\n");

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-23" -> "23 nov 2026". */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Sent whenever the therapist is about to record: a new note (count 0) or a resumed draft.
 * Always carries the SOAP guide, so every note is guided the same way.
 */
export function recordingIntro(patientName: string, count: number): string {
  const head =
    count === 0
      ? `📝 Nota de *${patientName}*.`
      : `📝 Sigue la nota de *${patientName}* (${count} ${count === 1 ? "nota" : "notas"} hasta ahora).`;
  return `${head}\n\n${SOAP_GUIDE}`;
}

/**
 * The reply to each note. For a voice note it shows what was understood, so the therapist can
 * catch a transcription error before it reaches the record. Send all but the last body with
 * sendText and the last with sendOptions (VOICE_OPTIONS for voice, RECORDING_OPTIONS for text).
 */
export function formatAck(patientName: string, count: number, transcript?: string): string[] {
  if (!transcript) return [`Anotado para ${patientName} (nota ${count}).`];
  return pack(
    [`🎙️ Anotado para ${patientName} (nota ${count}). Esto entendí:`, `«${transcript.trim()}»`, "\n¿Algo mal? Elige *Corregir*."],
    MAX_MESSAGE - OPTIONS_ROOM,
  );
}

export function formatCorrectionAck(count: number): string {
  return `✏️ Corrección anotada para la nota ${count}.`;
}

export interface ReviewInput {
  patientName: string;
  date: string; // clinic date, YYYY-MM-DD
  note: SoapExtraction;
  missing: MissingItem[];
  hasActivePlan: boolean;
}

/**
 * The note and plan as one or more message bodies. Send all but the last with sendText and the
 * last with sendOptions(REVIEW_OPTIONS); every body leaves room for the options.
 */
export function formatReview({ patientName, date, note, missing, hasActivePlan }: ReviewInput): string[] {
  const s = note.subjective;
  const subjective = [
    s.summary.trim(),
    s.pain_nprs !== null && !mentionsPain(s.summary, s.pain_nprs) ? `Dolor ${s.pain_nprs}/10.` : "",
    s.aggravating.length ? `Agrava: ${s.aggravating.join(", ")}.` : "",
    s.functional_limits.length ? `Limitaciones: ${s.functional_limits.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  const o = note.objective;
  const objective = [
    ...o.rom.map((r) => `${r.movement} de ${r.joint} ${r.degrees}°`),
    ...o.strength.map((st) => `${st.muscle} ${st.grade_0_5}/5`),
    ...o.special_tests,
    o.treatment_given.length ? `Tratamiento: ${o.treatment_given.join(", ")}` : "",
  ].filter(Boolean).join("; ");

  const blocks = [
    `*${patientName}* · ${formatDate(date)}`,
    `*S:* ${subjective || "—"}`,
    `*O:* ${objective || "—"}`,
    `*A:* ${note.assessment.trim() || "—"}`,
    `*P:* ${planHeadline(note) || "—"}`,
  ];

  const items = toPlanItems(note);
  if (note.plan.keep_current_plan) {
    blocks.push(hasActivePlan ? "Plan en casa: sin cambios" : "Plan en casa: sin cambios (no hay plan activo)");
  } else if (items.length) {
    const header = hasActivePlan ? "Plan en casa (reemplaza el actual):" : "Plan en casa (nuevo):";
    blocks.push([header, ...items.map((it, i) => ` ${i + 1}. ${describePlanItem(it)}`)].join("\n"));
  }
  if (missing.length) blocks.push(`Falta: ${missing.map((m) => MISSING_LABELS[m]).join(", ")}`);

  return pack(blocks, MAX_MESSAGE - OPTIONS_ROOM);
}

/** Does the summary already state this pain score ("3/10", "3 de 10")? */
function mentionsPain(summary: string, pain: number): boolean {
  return new RegExp(String.raw`(^|\D)${pain}\s*(/|de)\s*10(\D|$)`).test(summary);
}

/** Greedy packing of blocks into messages of at most `limit` characters. */
export function pack(blocks: string[], limit: number): string[] {
  const pieces = blocks.flatMap((b) => cut(b, limit));
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length <= limit) current = next;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Split one block longer than `limit` at the last space before the limit. */
function cut(block: string, limit: number): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > limit) {
    const at = rest.lastIndexOf(" ", limit);
    const end = at > 0 ? at : limit;
    out.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
