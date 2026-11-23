// Quick self-check for the pure helpers (no network, no DB). Run: npm run check
import { normalizePhone, toWhatsAppAddress } from "../lib/whatsapp/phone.ts";
import { SoapExtraction } from "../lib/ai/soap-schema.ts";
import { detectRedFlags, isOptOut, painScoreIn } from "../lib/agents/patient/signals.ts";
import {
  describeExercise, formatTime, parseCheckinStatus, parseNumberList, parsePainReply, parseTime, parseYesNo,
} from "../lib/agents/patient/parse.ts";
import { clinicTimeToUtc, clinicToday } from "../lib/agents/patient/time.ts";
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

// Welcome flow parsers (P-1).
for (const t of ["sí", "Si, acepto", "acepto", "Claro!", "ok", "va"]) eq(parseYesNo(t), "yes", `yes: "${t}"`);
for (const t of ["no", "No acepto", "no gracias", "mejor no"]) eq(parseYesNo(t), "no", `no: "${t}"`);
eq(parseYesNo("¿qué es esto?"), null, "unclear yes/no");
const timeCases: Array<[string, string | null]> = [
  ["7 pm", "19:00"],
  ["7:30 pm", "19:30"],
  ["19:30", "19:30"],
  ["a las 8 de la noche", "20:00"],
  ["8 de la mañana", "08:00"],
  ["8:00 am", "08:00"],
  ["a las 6", "18:00"],
  ["mediodía", "12:00"],
  ["como a las 7 y media de la noche", "19:30"],
  ["8 y cuarto", "08:15"],
  ["12 am", "00:00"],
  ["Noche (7:00 pm)", "19:00"],
  ["cuando sea", null],
  ["25:00", null],
];
for (const [text, expected] of timeCases) eq(parseTime(text), expected, `time: "${text}"`);
eq(formatTime("19:00:00"), "7:00 pm", "format 19:00");
eq(formatTime("08:05"), "8:05 am", "format 08:05");
eq(formatTime("00:00"), "12:00 am", "format midnight");

// Exercise check-in parsers (P-3).
const statusCases: Array<[string, boolean, string | null]> = [
  ["checkin_some", true, "some"],
  ["Hecho", true, "all"],
  ["ya hice mis ejercicios", true, "all"],
  ["algunos", true, "some"],
  ["Hoy no", true, "none"],
  ["no pude, mucho trabajo", true, "none"],
  ["sí", true, null],
  ["no", true, null],
  ["sí", false, "all"],
  ["no", false, "none"],
  ["hola", false, null],
];
for (const [text, strict, expected] of statusCases) eq(parseCheckinStatus(text, strict), expected, `checkin status: "${text}"`);
eq(parseNumberList("1 y 3", 2), [1], "numbers outside the list dropped");
eq(parseNumberList("1, 2, 2", 3), [1, 2], "repeats dropped");
eq(parseNumberList("ninguno", 3), [], "no numbers");
eq(parsePainReply("2"), { pain: 2, comment: null }, "pain 2");
eq(parsePainReply("2, las sentadillas costaron mucho"), { pain: 2, comment: "las sentadillas costaron mucho" }, "pain + comment");
eq(parsePainReply("3/10"), { pain: 3, comment: null }, "pain 3/10");
eq(parsePainReply("sin dolor"), { pain: 0, comment: null }, "sin dolor = 0");
eq(parsePainReply("10"), { pain: 10, comment: null }, "pain 10");
eq(parsePainReply("me dolió un poco"), { pain: null, comment: null }, "no score asks again");
eq(parsePainReply("25"), { pain: null, comment: null }, "25 is not a pain score");
eq(describeExercise({ name: "Elevación de pierna recta", sets: 3, reps: 12, hold_seconds: null }), "Elevación de pierna recta 3×12", "describe sets×reps");
eq(describeExercise({ name: "Sentadilla en pared", sets: 3, reps: null, hold_seconds: 30 }), "Sentadilla en pared 3×30 s", "describe sets×hold");

// Clinic time (America/Mexico_City, UTC-6).
eq(clinicToday(new Date("2026-11-24T03:00:00Z")), { date: "2026-11-23", weekday: 1 }, "9 pm Monday in CDMX is still Monday");
eq(clinicTimeToUtc("2026-11-23", "19:00:00").toISOString(), "2026-11-24T01:00:00.000Z", "7 pm CDMX = 01:00 UTC next day");

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
