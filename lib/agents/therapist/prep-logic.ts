// Flow E facts (pure): the window since the last session, home-exercise adherence, activity
// lines and the guards that keep the AI's lines grounded in those facts. No runtime "@/"
// imports so scripts/check-flow-e.mts can test it.

export interface ExerciseLogLite {
  plan_item_id: string;
  log_date: string; // YYYY-MM-DD
  done: boolean;
  comment: string | null;
}

export interface ActivityLogLite {
  activity: string;
  duration_min: number | null;
  pain_nprs: number | null;
  pain_location: string | null;
  onset_min: number | null;
  red_flag: boolean;
  comment: string | null;
  logged_at: string;
}

export interface ExerciseSummary {
  complete: number; // days every logged exercise was done
  partial: number; // days some were
  none: number; // days the patient answered and did none
  noReply: number; // days without a log
  skipped: { name: string; times: number; comment: string | null }[];
  comments: string[]; // the patient's own words in the window, oldest first
}

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The days after the last session's clinic date through yesterday (today's check-in is usually still to come). */
export function prepWindow(lastSessionDate: string | null, today: string): { from: string | null; days: string[] } {
  if (!lastSessionDate) return { from: null, days: [] };
  const days: string[] = [];
  for (let d = addDays(lastSessionDate, 1); d < today; d = addDays(d, 1)) days.push(d);
  return { from: lastSessionDate, days };
}

/** Adherence over the window, counting only the active plan's exercises. */
export function exerciseSummary(
  days: string[],
  logs: ExerciseLogLite[],
  items: { id: string; name: string }[],
): ExerciseSummary {
  const inWindow = new Set(days);
  const names = new Map(items.map((i) => [i.id, i.name]));
  const relevant = logs
    .filter((l) => inWindow.has(l.log_date) && names.has(l.plan_item_id))
    .sort((a, b) => a.log_date.localeCompare(b.log_date));

  const byDay = new Map<string, ExerciseLogLite[]>();
  for (const l of relevant) byDay.set(l.log_date, [...(byDay.get(l.log_date) ?? []), l]);

  const out: ExerciseSummary = { complete: 0, partial: 0, none: 0, noReply: 0, skipped: [], comments: [] };
  for (const day of days) {
    const rows = byDay.get(day);
    if (!rows?.length) out.noReply++;
    else if (rows.every((r) => r.done)) out.complete++;
    else if (rows.some((r) => r.done)) out.partial++;
    else out.none++;
  }

  const skipped = new Map<string, { name: string; times: number; comment: string | null; order: number }>();
  items.forEach((item, order) => {
    const missed = relevant.filter((l) => l.plan_item_id === item.id && !l.done);
    if (missed.length) {
      const comment = missed.map((l) => l.comment?.trim()).filter(Boolean).pop() ?? null;
      skipped.set(item.id, { name: item.name, times: missed.length, comment, order });
    }
  });
  out.skipped = [...skipped.values()]
    .sort((a, b) => b.times - a.times || a.order - b.order)
    .map(({ name, times, comment }) => ({ name, times, comment }));

  for (const l of relevant) {
    const c = l.comment?.trim();
    if (c && !out.comments.includes(c)) out.comments.push(c);
  }
  return out;
}

/** One compact line per activity log: "correr 25 min, dolor 5/10 frente de la rodilla desde el min 20". */
export function describeActivity(a: ActivityLogLite): string {
  let s = a.activity.trim();
  if (a.duration_min != null) s += ` ${a.duration_min} min`;
  if (a.pain_nprs === 0) s += ", sin dolor";
  else if (a.pain_nprs != null) {
    s += `, dolor ${a.pain_nprs}/10`;
    if (a.pain_location) s += ` ${a.pain_location.trim()}`;
    if (a.onset_min != null) s += ` desde el min ${a.onset_min}`;
  }
  return s;
}

/** The newest `max` activities, how many more there are, and every red-flag log with its words. */
export function activityLines(logs: ActivityLogLite[], max = 3): { lines: string[]; more: number; flags: string[] } {
  const newest = [...logs].sort((a, b) => b.logged_at.localeCompare(a.logged_at));
  return {
    lines: newest.slice(0, max).map(describeActivity),
    more: Math.max(0, newest.length - max),
    flags: newest
      .filter((a) => a.red_flag)
      .map((a) => (a.comment?.trim() ? `${describeActivity(a)}: ${a.comment.trim()}` : describeActivity(a))),
  };
}

// ---------------------------------------------------------------- guards for the AI lines

/** Every number written in a text ("115°", "3/10" → "115", "3", "10"). */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}

/** The numbers in the facts, without the list's own "1." "2." numbering. */
function factNumbers(factsText: string): Set<string> {
  return new Set(numbersIn(factsText.replace(/^\s*\d+\.\s/gm, "")));
}

/** The AI's line if every number in it appears in the facts; null otherwise (or when empty). */
export function groundedLine(line: string | null | undefined, factsText: string): string | null {
  const t = line?.trim();
  if (!t) return null;
  const known = factNumbers(factsText);
  return numbersIn(t).every((n) => known.has(n)) ? t : null;
}

/** Suggestions that cite at least one real fact (1-based) and invent no numbers. */
export function groundedSuggestions(
  suggestions: { focus: string; facts: number[] }[],
  factCount: number,
  factsText: string,
): string[] {
  return suggestions
    .filter((s) => s.facts.some((f) => Number.isInteger(f) && f >= 1 && f <= factCount))
    .map((s) => groundedLine(s.focus, factsText))
    .filter((s): s is string => !!s);
}
