import "server-only";
import twilio from "twilio";
import { requireEnv } from "@/lib/env";

let client: ReturnType<typeof twilio> | null = null;

export function twilioClient() {
  if (!client) client = twilio(requireEnv("TWILIO_ACCOUNT_SID"), requireEnv("TWILIO_AUTH_TOKEN"));
  return client;
}

/**
 * R-1: check the X-Twilio-Signature header. Twilio signs the exact public URL it called,
 * so behind a tunnel or proxy we rebuild it from PUBLIC_BASE_URL.
 */
export function isValidTwilioRequest(
  signature: string | null,
  requestUrl: string,
  params: Record<string, string>,
): boolean {
  if (process.env.TWILIO_SKIP_SIGNATURE_CHECK === "true" && process.env.NODE_ENV !== "production") {
    return true;
  }
  if (!signature) return false;
  const url = publicUrl(requestUrl);
  return twilio.validateRequest(requireEnv("TWILIO_AUTH_TOKEN"), signature, url, params);
}

function publicUrl(requestUrl: string): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return requestUrl;
  const { pathname, search } = new URL(requestUrl);
  return `${base.replace(/\/+$/, "")}${pathname}${search}`;
}
