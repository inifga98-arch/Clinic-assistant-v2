// Patient name matching for the therapist agent (pure, T-3). Used by Flow B's picker and
// reusable by Flows E and F. No runtime "@/" imports so scripts/check-flow-b.mts can test it.

import { normalize } from "../patient/signals";

export interface PatientRef {
  id: string;
  full_name: string;
  dob: string | null; // YYYY-MM-DD
  diagnosis: string | null;
  assigned_therapist_id: string | null;
}

const tokens = (s: string) => normalize(s).split(" ").filter(Boolean);

/**
 * Patients whose name matches a typed or spoken query. Every query word must match a word of
 * the name, exactly or with one typo (words of 4+ letters). An exact full-name match wins alone.
 */
export function matchPatients(query: string, patients: PatientRef[]): PatientRef[] {
  const q = tokens(query);
  if (!q.length) return [];
  const exact = patients.filter((p) => normalize(p.full_name) === q.join(" "));
  if (exact.length) return exact;
  return patients.filter((p) => {
    const name = tokens(p.full_name);
    return q.every((w) => name.some((n) => n === w || (w.length >= 4 && n.length >= 4 && editDistance(w, n) <= 1)));
  });
}

/**
 * Patients named in a note ("Sesión con Carlos Méndez…"). Full names first; if none appear,
 * first names as whole words, which may return several (the caller then asks).
 */
export function namesInText(text: string, patients: PatientRef[]): PatientRef[] {
  const words = tokens(text);
  const contains = (seq: string[]) =>
    seq.length > 0 && words.some((_, i) => seq.every((t, j) => words[i + j] === t));
  const full = patients.filter((p) => contains(tokens(p.full_name)));
  if (full.length) return full;
  return patients.filter((p) => contains(tokens(p.full_name).slice(0, 1)));
}

/** "Ana López", or "Luis Pérez (nac. 02/01/1980)" when another shown patient has the same name. */
export function patientLabel(p: PatientRef, shown: PatientRef[]): string {
  const twin = shown.some((o) => o.id !== p.id && normalize(o.full_name) === normalize(p.full_name));
  if (!twin || !p.dob) return p.full_name;
  const [y, m, d] = p.dob.split("-");
  return `${p.full_name} (nac. ${d}/${m}/${y})`;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
