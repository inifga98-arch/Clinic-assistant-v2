import "server-only";
import { db } from "@/lib/db/server";
import type { IncomingMessage } from "@/lib/agents/types";

/**
 * Save an incoming message to the log. Returns false when this MessageSid was already
 * stored (R-3: Twilio retries must not be processed twice). Throws on storage errors.
 * Shared by the webhook and the simulator so both behave the same way.
 */
export async function recordIncoming(message: IncomingMessage): Promise<boolean> {
  const { data, error } = await db()
    .from("messages")
    .upsert(
      {
        twilio_sid: message.sid,
        phone: message.phone,
        direction: "in",
        body: message.body || null,
        media_url: message.media[0]?.url ?? null,
        media_type: message.media[0]?.contentType ?? null,
      },
      { onConflict: "twilio_sid", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`recordIncoming: ${error.message}`);
  return Boolean(data && data.length > 0);
}
