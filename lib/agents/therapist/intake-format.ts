// Flow A messages (pure): prompts, option lists, the registration card and the initial
// evaluation review. Rules: docs/conversation-design.md. No runtime "@/" imports so
// scripts/check-flow-a.mts can test it.

import type { EvaluationExtraction } from "../../ai/intake-schema";
import type { Option } from "../../whatsapp/options";
import { EVAL_GAP_LABELS, displayPhone, evaluationGaps } from "./intake-logic";
import { MAX_MESSAGE, OPTIONS_ROOM, formatDate, pack } from "./note-format";

// ---------------------------------------------------------------- prompts and options

export const REGISTRATION_PROMPT =
  "🆕 *Nuevo paciente*. Escribe o dime su *nombre completo* y su *WhatsApp*.\n" +
  "Ej.: *Laura Méndez, 55 1234 5678*. Si quieres, agrega el motivo (p. ej. rodilla derecha).";

export const REGISTRATION_OPTIONS: Option[] = [
  { id: "save", title: "Guardar", icon: "✅" },
  { id: "fix", title: "Corregir", icon: "✏️" },
  { id: "cancel", title: "Cancelar", icon: "🗑️" },
];

export const EVAL_SOURCE_OPTIONS: Option[] = [
  { id: "photo", title: "Foto del formato", icon: "📷" },
  { id: "voice", title: "Nota de voz", icon: "🎙️" },
  { id: "later", title: "Después", icon: "⏭️" },
];

export const PAGES_OPTIONS: Option[] = [
  { id: "done", title: "Listo", icon: "✅" },
  { id: "more", title: "Otra página", icon: "➕" },
];

export const EVAL_REVIEW_OPTIONS: Option[] = [
  { id: "confirm", title: "Confirmar", icon: "✅" },
  { id: "fix", title: "Corregir", icon: "✏️" },
  { id: "discard", title: "Descartar", icon: "🗑️" },
];

export const PHOTO_PROMPT =
  "📷 Mándame las fotos de la historia clínica, una por hoja, desde la primera hasta la de " +
  "*Plan de tratamiento*. No hace falta la de consentimiento ni la bitácora. " +
  "Que se lea bien: buena luz y sin sombras.";

export function evalVoiceGuide(patientName: string): string {
  return [
    `🩺 Valoración inicial de *${patientName}*. Sigue el orden de la historia clínica:`,
    "💬 *Motivo y mecanismo de lesión*, y el dolor: inicio, dónde, tipo, intensidad (0 a 10), irradiación.",
    "📚 *Antecedentes:* heredofamiliares, no patológicos (actividad física), patológicos (alergias, cirugías, trauma, enfermedades, medicamentos).",
    "🔍 *Exploración:* postura, marcha, goniometría, fuerza, pruebas ortopédicas.",
    "🧠 *Impresión diagnóstica* y *diagnóstico fisioterapéutico*.",
    "🎯 *Plan de tratamiento:* objetivos e indicaciones.",
    "",
    "Manda una nota de voz o varias, o escríbela. Cuando termines, responde *Listo*.",
  ].join("\n");
}

export function formatPageAck(count: number): string {
  return `📷 Recibí la página ${count}. ¿Hay más páginas?`;
}

// ---------------------------------------------------------------- registration card

/** "1991-03-14" -> "14/03/1991". */
function dmy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

export function formatRegistrationCard(
  r: { full_name: string; phone: string; reason: string | null },
  sameName?: { full_name: string; dob: string | null },
): string {
  const lines = [`🆕 *${r.full_name}*`, `📱 ${displayPhone(r.phone)}`];
  if (r.reason?.trim()) lines.push(`🩺 Motivo: ${r.reason.trim()}`);
  lines.push("👤 Terapeuta: tú");
  if (sameName) {
    const born = sameName.dob ? ` (nac. ${dmy(sameName.dob)})` : "";
    lines.push("", `⚠️ Ya existe *${sameName.full_name}*${born}. Si es otra persona, guárdala igual.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- evaluation review

const REGION_LABELS = { upper_limb: "miembro superior", lower_limb: "miembro inferior", spine: "columna" } as const;
const SEX_LABELS = { female: "femenino", male: "masculino" } as const;

/** "Label: value" when there is a value; nothing otherwise. */
const kv = (label: string, value: string | number | null | undefined) =>
  value === null || value === undefined || String(value).trim() === "" ? null : `${label}: ${String(value).trim()}`;

function block(title: string, lines: (string | null)[]): string | null {
  const body = lines.filter((l): l is string => !!l);
  return body.length ? [`*${title}*`, ...body].join("\n") : null;
}

const side = (right: string | number | null, left: string | number | null) =>
  `D ${right ?? "—"} / I ${left ?? "—"}`;

/**
 * The evaluation as message bodies, in the order of the paper form, so the therapist can check
 * it against the paper. Empty sections are left out; "Niega" is shown as written. Send all but
 * the last with sendText and the last with sendOptions(EVAL_REVIEW_OPTIONS).
 */
export function formatEvaluationReview(patientName: string, e: EvaluationExtraction): string[] {
  const id = e.identification;
  const meta = [
    e.form_region ? `Formato: ${REGION_LABELS[e.form_region]}` : null,
    e.form_date ? formatDate(e.form_date) : null,
    e.performed_by ? `Realizó: ${e.performed_by}` : null,
  ].filter(Boolean);

  const physician = [id.physician.name, id.physician.specialty && `(${id.physician.specialty})`, id.physician.phone]
    .filter(Boolean)
    .join(" ");
  const contact = [id.emergency_contact.name, id.emergency_contact.relationship && `(${id.emergency_contact.relationship})`, id.emergency_contact.phone]
    .filter(Boolean)
    .join(" ");
  const np = e.non_pathological;
  const activity = [np.activity_type, np.activity_frequency, np.activity_hours_daily && `${np.activity_hours_daily} h/día`]
    .filter(Boolean)
    .join(", ");
  const p = e.pathological;
  const vs = e.vital_signs;
  const vitals = [
    kv("T", vs.temperature),
    kv("TA", vs.blood_pressure),
    kv("FR", vs.respiratory_rate),
    kv("SatO2", vs.spo2),
    kv("FC", vs.heart_rate),
  ].filter(Boolean);
  const pain = e.pain;
  const x = e.exam;
  const scar = [x.surgical_scar.location, x.surgical_scar.features.join(", ")].filter(Boolean).join("; ");
  const edema = [x.edema.location, x.edema.type, x.edema.characteristics, x.edema.godet_sign && `Godet ${x.edema.godet_sign}`]
    .filter(Boolean)
    .join("; ");

  const blocks = [
    [`🩺 *Valoración inicial · ${patientName}*`, meta.length ? meta.join(" · ") : null].filter(Boolean).join("\n"),
    block("Ficha", [
      kv("Edad", id.age),
      id.dob ? kv("Nacimiento", dmy(id.dob)) : null,
      kv("Ocupación", id.occupation),
      kv("Sexo", id.sex ? SEX_LABELS[id.sex] : null),
      kv("Estado civil", id.marital_status),
      kv("Riesgo de caídas", id.fall_risk),
      kv("Médico", physician),
      kv("Contacto de emergencia", contact),
    ]),
    block("Antecedentes heredofamiliares", e.family_history.map((f) => `${f.condition}${f.relatives.length ? ` (${f.relatives.join(", ")})` : ""}`)),
    block("Antecedentes no patológicos", [kv("Toxicomanías", np.substance_use), kv("Actividad física", activity)]),
    block("Antecedentes patológicos", [
      kv("Alergias", p.allergies),
      kv("Transfusiones", p.transfusions),
      kv("Quirúrgicos", p.surgeries),
      kv("Quirúrgicos ortopédicos", p.orthopedic_surgeries),
      kv("Trauma", p.trauma),
      kv("Enfermedades", p.illnesses),
      kv("Medicamentos/suplementos", p.medications_supplements),
    ]),
    block("Signos vitales", [vitals.length ? vitals.join(" · ") : null]),
    block("Motivo", [e.chief_complaint, kv("Mecanismo de lesión", e.injury_mechanism)]),
    block("Dolor", [
      kv("Inicio", pain.onset),
      kv("Localización", pain.location),
      kv("Tipo", pain.type),
      pain.intensity_nprs !== null ? `Intensidad: ${pain.intensity_nprs}/10` : null,
      kv("Irradiación", pain.radiation),
      kv("Aumenta/disminuye con", pain.modifiers),
    ]),
    block("Exploración", [
      kv("Postura", x.posture),
      kv("Marcha", x.gait),
      kv("Observaciones", x.observations),
      ...x.goniometry.map((g) => `${g.joint} ${g.movement.toLowerCase()}: ${side(g.right, g.left)}`),
      ...x.strength_mrc.map((s) => `Fuerza ${s.muscle_or_movement.toLowerCase()}: ${side(s.right, s.left)}`),
      ...x.orthopedic_tests.map((t) => `${t.test}: ${side(t.right, t.left)}`),
      kv("Pruebas complementarias", x.complementary_tests),
      kv("Sensibilidad", x.sensation),
      kv("Reflejos", x.reflexes),
      kv("Espasmo/contractura", x.spasm_location),
      kv("Cicatriz quirúrgica", scar),
      kv("Edema", edema),
    ]),
    block("Estudios auxiliares", [e.auxiliary_studies]),
    block("Diagnóstico", [kv("Impresión diagnóstica", e.diagnostic_impression), kv("Diagnóstico fisioterapéutico", e.pt_diagnosis)]),
    block("Plan de tratamiento", [
      e.treatment_plan.goals.length ? `Objetivos: ${e.treatment_plan.goals.join("; ")}` : null,
      e.treatment_plan.instructions.length ? `Indicaciones: ${e.treatment_plan.instructions.join("; ")}` : null,
    ]),
    e.unreadable.length ? `⚠️ No se pudo leer: ${e.unreadable.join(", ")}` : null,
    evaluationGaps(e).length ? `Falta: ${evaluationGaps(e).map((g) => EVAL_GAP_LABELS[g]).join(", ")}` : null,
  ].filter((b): b is string => !!b);

  return pack(blocks, MAX_MESSAGE - OPTIONS_ROOM);
}
