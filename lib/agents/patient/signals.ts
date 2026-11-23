// Pure text checks for the patient agent: opt-out (P-8) and red flags (P-6).
// No imports from the app (no DB, no "@/" paths) so scripts/check-helpers.mts can test it
// with plain Node.

/** Lowercase, strip accents, punctuation and extra spaces: "¡Me caí!" -> "me cai". */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- opt-out (P-8)

/**
 * Whole-message replies that mean "stop sending me reminders". Matched against the whole
 * message, so "para" inside a sentence ("para la rodilla") never triggers it.
 * "cancelar" alone is the router's reset word (X-3), not an opt-out.
 */
const OPT_OUT_MESSAGES = new Set(
  [
    "parar",
    "para",
    "stop",
    "alto",
    "basta",
    "baja",
    "detener",
    "darme de baja",
    "dame de baja",
    "no mas recordatorios",
    "ya no quiero recordatorios",
    "no quiero recordatorios",
    "cancelar recordatorios",
    "parar recordatorios",
    "detener recordatorios",
  ].map(normalize),
);

export function isOptOut(text: string): boolean {
  return OPT_OUT_MESSAGES.has(normalize(text));
}

// ---------------------------------------------------------------- red flags (P-6)

export type RedFlag = "severe_pain" | "swelling" | "numbness" | "fever" | "fall" | "much_worse" | "cant_bear_weight";

/** Short es-MX labels for the therapist alert. */
export const RED_FLAG_LABELS: Record<RedFlag, string> = {
  severe_pain: "dolor fuerte (8/10 o más)",
  swelling: "hinchazón",
  numbness: "entumecimiento u hormigueo",
  fever: "fiebre",
  fall: "caída",
  much_worse: "mucho peor",
  cant_bear_weight: "no puede apoyar o caminar",
};

/** Patterns run on normalize()d text (no accents, lowercase). */
const FLAG_PATTERNS: Array<{ flag: RedFlag; pattern: RegExp; negatable: boolean }> = [
  { flag: "swelling", pattern: /\b(hinchad[oa]s?|hinchazon|se (me )?hincho|inflamad[oa]s?|inflamacion)\b/, negatable: true },
  { flag: "numbness", pattern: /\b(entumid[oa]s?|entumecid[oa]s?|entumecimiento|adormecid[oa]s?|hormigueo|no siento (la|el|mi|los|las)\b)/, negatable: true },
  { flag: "fever", pattern: /\b(fiebre|calentura)\b/, negatable: true },
  { flag: "fall", pattern: /\b(me cai|me caigo|me resbale|una caida|tuve una caida|me fui al suelo)\b/, negatable: true },
  { flag: "much_worse", pattern: /\b(mucho peor|muchisimo peor|cada vez peor|peor que nunca)\b/, negatable: false },
  { flag: "cant_bear_weight", pattern: /\b(no puedo (apoyar|caminar|pisar)|no puedo ni caminar)\b/, negatable: false },
];

/** "no tengo fiebre", "sin hinchazon", "nada de fiebre": a negator in the 3 words before. */
const NEGATORS = new Set(["no", "sin", "nada", "ni", "nunca"]);

function isNegated(text: string, matchIndex: number): boolean {
  const before = text.slice(0, matchIndex).trim().split(" ").slice(-3);
  return before.some((w) => NEGATORS.has(w));
}

/**
 * Pain written as a score: "dolor 9", "dolor de 8", "9/10", "8 de 10".
 * Returns the highest score found, or null.
 */
export function painScoreIn(text: string): number | null {
  const t = normalize(text);
  const scores: number[] = [];
  for (const m of t.matchAll(/\b(10|[0-9])\s*(?:\/|de)\s*10\b/g)) scores.push(Number(m[1]));
  for (const m of t.matchAll(/\bdolor (?:de |como (?:un |de )?|en (?:un )?)?(10|[0-9])\b(?!\s*(?:min|minutos|km|dias|horas|veces))/g)) {
    scores.push(Number(m[1]));
  }
  return scores.length ? Math.max(...scores) : null;
}

/**
 * Red flags in a free-text patient message. `painScore` is a score the patient already gave
 * in a structured step (e.g. a check-in), checked alongside the text.
 * Errs on the side of flagging: a false alarm costs the therapist a glance, a miss costs more.
 */
export function detectRedFlags(text: string, painScore: number | null = null): RedFlag[] {
  const t = normalize(text);
  const flags = new Set<RedFlag>();

  const pain = Math.max(painScore ?? -1, painScoreIn(text) ?? -1);
  if (pain >= 8) flags.add("severe_pain");

  for (const { flag, pattern, negatable } of FLAG_PATTERNS) {
    const m = pattern.exec(t);
    if (m && !(negatable && isNegated(t, m.index))) flags.add(flag);
  }
  return [...flags];
}
