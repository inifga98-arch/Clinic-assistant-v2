// Quick self-check for the pure helpers (no network, no DB). Run: node scripts/check-helpers.mts
import { normalizePhone, toWhatsAppAddress } from "../lib/whatsapp/phone.ts";
import { SoapExtraction } from "../lib/ai/soap-schema.ts";
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

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
