// Pure parsers for patient replies (es-MX). No DB or "@/" imports, so npm run check can test
// them without the app. Every parser returns null when it is not sure, and the flow asks
// again instead of guessing.

import { normalize } from "./signals";

// ---------------------------------------------------------------- yes / no

const YES = new Set(
  ["si", "sí", "acepto", "aceptar", "claro", "ok", "okay", "va", "sale", "dale", "de acuerdo",
   "por supuesto", "yes", "si acepto", "si claro", "si quiero", "quiero", "esta bien", "perfecto"].map(normalize),
);
const NO = new Set(
  ["no", "no acepto", "no gracias", "nel", "rechazo", "no quiero", "mejor no", "ahorita no"].map(normalize),
);

export function parseYesNo(text: string): "yes" | "no" | null {
  const t = normalize(text);
  if (NO.has(t) || /^no\b/.test(t)) return "no";
  if (YES.has(t) || /^si\b/.test(t)) return "yes";
  return null;
}

// ---------------------------------------------------------------- time of day

/**
 * "7 pm", "19:30", "a las 8 de la noche", "8:00", "mediodía" -> "HH:MM" (24 h).
 * A bare 1–6 with no am/pm is read as afternoon/evening: nobody wants a 3 a.m. reminder.
 * The flow repeats the time back, so the patient can correct a wrong guess.
 */
export function parseTime(text: string): string | null {
  const t = normalize(text);
  if (/\bmediodia\b/.test(t)) return "12:00";
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|a m|pm|p m|hrs|hr|h)?\b/.exec(t.replace(/(\d)\.(\d{2})/, "$1:$2"));
  if (!m) return null;
  let hour = Number(m[1]);
  let minute = m[2] ? Number(m[2]) : 0;
  if (!m[2] && /\by media\b/.test(t)) minute = 30;
  else if (!m[2] && /\by cuarto\b/.test(t)) minute = 15;
  if (hour > 23 || minute > 59) return null;
  const pm = /p ?m/.test(m[3] ?? "") || /\b(tarde|noche)\b/.test(t);
  const am = /a ?m/.test(m[3] ?? "") || /\b(manana|madrugada)\b/.test(t);
  if (pm && hour < 12) hour += 12;
  else if (am && hour === 12) hour = 0;
  else if (!am && !pm && hour >= 1 && hour <= 6) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "19:00" or "19:00:00" -> "7:00 pm" for messages. */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

// ---------------------------------------------------------------- exercise check-in (P-3)

export type CheckinStatus = "all" | "some" | "none";

/** Button ids on the reminder template (Done / Some / Not today). */
export const CHECKIN_PAYLOADS: Record<string, CheckinStatus> = {
  checkin_all: "all",
  checkin_some: "some",
  checkin_none: "none",
};

/**
 * Words that clearly answer "how did your exercises go?". `strict` (no saved state) leaves
 * out bare "sí" / "no" / "ya", which could be answers to something else.
 */
export function parseCheckinStatus(text: string, strict = false): CheckinStatus | null {
  const payload = CHECKIN_PAYLOADS[text.trim()];
  if (payload) return payload;
  const t = normalize(text);
  if (/^(hecho|listo|todos|todas|los hice todos|ya los hice|hice todos|complete|termine|done)\b/.test(t)) return "all";
  if (/\bhice (todos )?mis ejercicios\b/.test(t)) return "all";
  if (/^(algunos|algunas|some|unos|unas|la mitad|solo uno|solo una|nomas uno|nada mas uno)\b/.test(t)) return "some";
  if (/^(hoy no|ninguno|ninguna|no pude|no los hice|no hice|not today)\b/.test(t)) return "none";
  if (!strict) {
    if (/^(si|ya|todo)\b/.test(t)) return "all";
    if (/^(no|nada)\b/.test(t)) return "none";
  }
  return null;
}

/** "1, 3 y 4" -> [1, 3, 4]; only numbers from 1 to `max`, no repeats. */
export function parseNumberList(text: string, max: number): number[] {
  const nums = [...normalize(text).matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
  return [...new Set(nums)].filter((n) => n >= 1 && n <= max);
}

/**
 * Pain reply to "0 to 10?": "2", "2, las sentadillas costaron", "sin dolor".
 * Returns the score and whatever else they wrote as a comment.
 */
export function parsePainReply(text: string): { pain: number | null; comment: string | null } {
  const raw = text.trim();
  const t = normalize(raw);
  if (/^(sin dolor|nada|ninguno|cero|no me dolio|no dolio|no me duele)\b/.test(t)) {
    const rest = raw.replace(/^(sin dolor|nada|ninguno|cero|no me doli[oó]|no doli[oó]|no me duele)[\s,.;:-]*/i, "");
    return { pain: 0, comment: rest || null };
  }
  const m = /^\s*(10|[0-9])(?:\s*(?:\/|de)\s*10)?(?![0-9])[\s,.;:-]*([\s\S]*)$/.exec(raw);
  if (m) return { pain: Number(m[1]), comment: m[2].trim() || null };
  return { pain: null, comment: null };
}

/** Plan item as shown to the patient: "Elevación de pierna recta 3×12", "Sentadilla en pared 3×30 s". */
export function describeExercise(item: { name: string; sets: number | null; reps: number | null; hold_seconds: number | null }): string {
  const dose = item.sets && item.reps ? `${item.sets}×${item.reps}`
    : item.sets && item.hold_seconds ? `${item.sets}×${item.hold_seconds} s`
    : item.reps ? `${item.reps} rep.`
    : item.hold_seconds ? `${item.hold_seconds} s`
    : "";
  return dose ? `${item.name} ${dose}` : item.name;
}
