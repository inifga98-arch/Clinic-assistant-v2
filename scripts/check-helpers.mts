// Quick self-check for the pure helpers (no network, no DB). Run: node scripts/check-helpers.mts
import { normalizePhone, toWhatsAppAddress } from "../lib/whatsapp/phone.ts";
import { SoapExtraction } from "../lib/ai/soap-schema.ts";
import { detectRedFlags, isOptOut, painScoreIn } from "../lib/agents/patient/signals.ts";
import { zodResponseFormat } from "openai/helpers/zod";
import twilio from "twilio";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(pass ? "ok  " : "FAIL", label, pass ? "" : `got ${JSON.stringify(actual)}`);
}

eq(normalizePhone("whatsapp:+5215512345678"), "+525512345678", "MX legacy +521 is stripped");
eq(normalizePhone("whatsapp:+525512345678"), "+525512345678", "MX plain number kept");
eq(normalizePhone("whatsapp:+16175551234"), "+16175551234", "US number kept");
eq(normalizePhone("+52 55 1234 5678"), "+525512345678", "spaces removed");
eq(normalizePhone("5215512345678"), "+525512345678", "missing plus added");
eq(toWhatsAppAddress("+5215512345678"), "whatsapp:+525512345678", "Twilio address");

const format = zodResponseFormat(SoapExtraction, "soap_note");
eq(format.type, "json_schema", "SOAP schema converts to an OpenAI response format");
const sample = {
  subjective: { summary: "Dolor 3/10", pain_nprs: 3, aggravating: [], functional_limits: [] },
  objective: { rom: [], strength: [], special_tests: [], treatment_given: [] },
  assessment: "Progresa",
  plan: {
    visits_per_week: 2,
    next_session_focus: null,
    home_exercises: [{ name: "SLR", sets: 3, reps: 12, hold_seconds: null, frequency_per_week: 7 }],
    activities: [],
  },
  missing_required: [],
};
eq(SoapExtraction.safeParse(sample).success, true, "valid SOAP sample parses");
eq(SoapExtraction.safeParse({ ...sample, subjective: { ...sample.subjective, pain_nprs: 11 } }).success, false, "pain 11 rejected");

const token = "test_token";
const url = "https://example.test/api/whatsapp";
const params = { From: "whatsapp:+5215512345678", Body: "hola", MessageSid: "SM1" };
const signature = twilio.getExpectedTwilioSignature(token, url, params);
eq(twilio.validateRequest(token, signature, url, params), true, "Twilio signature accepted");
eq(twilio.validateRequest(token, signature, url, { ...params, Body: "x" }), false, "tampered body rejected");

// Patient opt-out (P-8): whole-message only.
for (const t of ["parar", "Parar.", "PARA", "stop", "¡Basta!", "darme de baja", "No más recordatorios"]) {
  eq(isOptOut(t), true, `opt-out: "${t}"`);
}
for (const t of ["para la rodilla hice 3 series", "cancelar", "menu", "ya no me duele", "hola"]) {
  eq(isOptOut(t), false, `not opt-out: "${t}"`);
}

// Patient red flags (P-6).
const flagCases: Array<[string, string[]]> = [
  ["me duele muchísimo, dolor 9", ["severe_pain"]],
  ["fui a correr y el dolor fue de 8/10", ["severe_pain"]],
  ["tengo la rodilla muy hinchada", ["swelling"]],
  ["se me hinchó el tobillo", ["swelling"]],
  ["siento hormigueo en el pie", ["numbness"]],
  ["no siento la pierna", ["numbness"]],
  ["creo que tengo fiebre", ["fever"]],
  ["¡Me caí en las escaleras!", ["fall"]],
  ["estoy mucho peor que la semana pasada", ["much_worse"]],
  ["no puedo apoyar el pie", ["cant_bear_weight"]],
  ["me caí y ahora está hinchado, dolor 8 de 10", ["severe_pain", "swelling", "fall"]],
];
for (const [text, expected] of flagCases) eq(detectRedFlags(text).sort(), [...expected].sort(), `red flag: "${text}"`);
const noFlagCases = [
  "hice mis ejercicios, dolor 3",
  "corrí 25 minutos, dolor 5/10",
  "dolor 2 después de 10 minutos",
  "no tengo fiebre ni hinchazón",
  "sin hinchazón, todo bien",
  "no me caí, solo me cansé",
  "parar",
];
for (const text of noFlagCases) eq(detectRedFlags(text), [], `no red flag: "${text}"`);
eq(detectRedFlags("hice 2 de 3 ejercicios", 9), ["severe_pain"], "structured pain score 9 flags");
eq(painScoreIn("corrí 30 min, dolor de 6, luego 7/10"), 7, "highest pain score found");
eq(painScoreIn("corrí 30 minutos"), null, "no pain score");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
