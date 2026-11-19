import "server-only";
import { db } from "@/lib/db/server";
import { requireEnv } from "@/lib/env";
import { normalizePhone, toWhatsAppAddress } from "./phone";
import { twilioClient } from "./twilio";

// R-7: shared send helpers. Agents call these and never talk to Twilio directly, so we can
// switch to the Meta Cloud API later without touching the flows.

export interface Option {
  id: string; // what the agent gets back when the user picks it
  title: string; // shown to the user (WhatsApp limit: 20 chars for buttons, 24 for list rows)
}

/** Plain text. Only allowed within 24 h of the user's last message. */
export async function sendText(to: string, body: string): Promise<void> {
  const msg = await twilioClient().messages.create({
    from: requireEnv("TWILIO_WHATSAPP_FROM"),
    to: toWhatsAppAddress(to),
    body,
  });
  await logOutbound(to, msg.sid, body);
}

/**
 * Up to 3 quick-reply buttons (or a list picker for more).
 *
 * TODO(Person 3): real buttons need Twilio Content Templates (twilio/quick-reply,
 * twilio/list-picker) sent by ContentSid. Until then this sends a numbered list and the
 * agent accepts either the number or the title as the answer (see matchOption).
 */
export async function sendOptions(to: string, body: string, options: Option[]): Promise<void> {
  const lines = options.map((o, i) => `${i + 1}. ${o.title}`);
  await sendText(to, `${body}\n\n${lines.join("\n")}`);
}

/** Map a reply ("2", "nota de sesión", a button payload) to one of the options sent. */
export function matchOption(reply: string, options: Option[]): Option | null {
  const text = normalizeText(reply);
  const byNumber = /^\d+$/.test(text) ? options[Number(text) - 1] : undefined;
  if (byNumber) return byNumber;
  return options.find((o) => normalizeText(o.title) === text || o.id === reply.trim()) ?? null;
}

/**
 * Approved template (needed outside the 24 h window: welcome, reminders).
 * `contentSid` is the HX... id from Twilio Content Template Builder.
 */
export async function sendTemplate(
  to: string,
  contentSid: string,
  variables: Record<string, string> = {},
): Promise<void> {
  const msg = await twilioClient().messages.create({
    from: requireEnv("TWILIO_WHATSAPP_FROM"),
    to: toWhatsAppAddress(to),
    contentSid,
    contentVariables: JSON.stringify(variables),
  });
  await logOutbound(to, msg.sid, `[template ${contentSid}] ${JSON.stringify(variables)}`);
}

async function logOutbound(to: string, sid: string, body: string): Promise<void> {
  const { error } = await db()
    .from("messages")
    .insert({ twilio_sid: sid, phone: normalizePhone(to), direction: "out", body });
  // The message already went out; a logging failure must not make the agent retry it.
  if (error) console.error("[whatsapp] failed to log outbound message", sid, error.message);
}

export function normalizeText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.!¡?¿,]+$/g, "")
    .trim();
}
