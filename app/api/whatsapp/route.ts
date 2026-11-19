import { after, NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db/server";
import type { IncomingMessage } from "@/lib/agents/types";
import { routeMessage } from "@/lib/router";
import { normalizePhone } from "@/lib/whatsapp/phone";
import { sendText } from "@/lib/whatsapp/send";
import { isValidTwilioRequest } from "@/lib/whatsapp/twilio";

// Twilio WhatsApp webhook. Owner: Person 3.
// R-1 validate signature · R-3 dedupe by MessageSid · R-2 return 200 fast, work in after().

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds for the after() work (transcription can be slow)

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") params[key] = value;
  });

  if (!isValidTwilioRequest(req.headers.get("x-twilio-signature"), req.url, params)) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const sid = params.MessageSid;
  const from = params.From;
  if (!sid || !from) return twiml(); // status callbacks or malformed posts: nothing to do

  const message = parseMessage(params, sid, from);

  // Insert first; the unique twilio_sid makes Twilio retries a no-op.
  const { data: inserted, error } = await db()
    .from("messages")
    .upsert(
      {
        twilio_sid: sid,
        phone: message.phone,
        direction: "in",
        body: message.body || null,
        media_url: message.media[0]?.url ?? null,
        media_type: message.media[0]?.contentType ?? null,
      },
      { onConflict: "twilio_sid", ignoreDuplicates: true },
    )
    .select("id");
  if (error) {
    console.error("[webhook] could not save message", sid, error.message);
    return new NextResponse("Storage error", { status: 500 });
  }
  if (!inserted || inserted.length === 0) return twiml(); // duplicate delivery

  after(async () => {
    try {
      await routeMessage(message);
    } catch (err) {
      console.error("[webhook] routing failed", sid, err);
      try {
        await sendText(message.phone, "Algo salió mal de nuestro lado. Intenta de nuevo en un momento.");
      } catch (sendErr) {
        console.error("[webhook] could not send the error notice", sid, sendErr);
      }
    }
  });

  return twiml();
}

function parseMessage(params: Record<string, string>, sid: string, from: string): IncomingMessage {
  const numMedia = Number.parseInt(params.NumMedia ?? "0", 10) || 0;
  const media = Array.from({ length: numMedia }, (_, i) => ({
    url: params[`MediaUrl${i}`],
    contentType: params[`MediaContentType${i}`] ?? "application/octet-stream",
  })).filter((m) => Boolean(m.url));
  return {
    sid,
    phone: normalizePhone(from),
    body: (params.Body ?? "").trim(),
    buttonPayload: params.ButtonPayload || null,
    media,
    receivedAt: new Date(),
  };
}

function twiml() {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
}
