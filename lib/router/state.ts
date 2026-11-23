import "server-only";
import { db } from "@/lib/db/server";
import type { Conversation } from "@/lib/db/types";
import type { ConversationState } from "@/lib/agents/types";
import { normalizePhone } from "@/lib/whatsapp/phone";

/** A flow left idle this long starts over from the menu (PRD: conversations table). */
export const STATE_TTL_MS = 30 * 60 * 1000;

// State is keyed by the normalised phone, so a caller passing a stored number (e.g. the
// reminder scheduler with patient.phone) and the router passing WhatsApp's From agree.

export async function loadState(rawPhone: string, now = new Date()): Promise<ConversationState | null> {
  const phone = normalizePhone(rawPhone);
  const { data, error } = await db()
    .from("conversations")
    .select("*")
    .eq("phone", phone)
    .maybeSingle<Conversation>();
  if (error) throw new Error(`loadState: ${error.message}`);
  if (!data || !data.current_flow || !data.step) return null;
  if (now.getTime() - new Date(data.updated_at).getTime() > STATE_TTL_MS) return null;
  return { flow: data.current_flow, step: data.step, context: data.context ?? {} };
}

export async function saveState(
  rawPhone: string,
  role: Conversation["role"],
  state: ConversationState | null,
): Promise<void> {
  const phone = normalizePhone(rawPhone);
  if (state === null) {
    const { error } = await db().from("conversations").delete().eq("phone", phone);
    if (error) throw new Error(`saveState(clear): ${error.message}`);
    return;
  }
  const { error } = await db().from("conversations").upsert({
    phone,
    role,
    current_flow: state.flow,
    step: state.step,
    context: state.context,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`saveState: ${error.message}`);
}
