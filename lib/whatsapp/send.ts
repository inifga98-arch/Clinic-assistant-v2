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

/** One outgoing message, before it reaches a channel. */
export type OutboundMessage =
  | { kind: "text"; to: string; body: string }
  | { kind: "template"; to: string; contentSid: string; variables: Record<string, string> };

/** Delivers an outbound message and returns its message id. */
export type Transport = (message: OutboundMessage) => Promise<string>;

const twilioTransport: Transport = async (message) => {
  const base = { from: requireEnv("TWILIO_WHATSAPP_FROM"), to: toWhatsAppAddress(message.to) };
  const sent =
    message.kind === "text"
      ? await twilioClient().messages.create({ ...base, body: message.body })
      : await twilioClient().messages.create({
          ...base,
          contentSid: message.contentSid,
          contentVariables: JSON.stringify(message.variables),
        });
  return sent.sid;
};

let transport: Transport = twilioTransport;

/**
 * Replace how messages are delivered (the simulator prints them instead of sending).
 * Production code never calls this.
 */
export function setTransport(next: Transport): void {
  transport = next;
}

/** Plain text. Only allowed within 24 h of the user's last message. */
export async function sendText(to: string, body: string): Promise<void> {
  const sid = await transport({ kind: "text", to, body });
  await logOutbound(to, sid, body);
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
  const sid = await transport({ kind: "template", to, contentSid, variables });
  await logOutbound(to, sid, `[template ${contentSid}] ${JSON.stringify(variables)}`);
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
    .replace(/^[¡¿]+/, "")
    .replace(/[.!¡?¿,]+$/g, "")
    .trim();
}
