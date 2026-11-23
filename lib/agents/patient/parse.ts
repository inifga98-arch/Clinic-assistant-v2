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
