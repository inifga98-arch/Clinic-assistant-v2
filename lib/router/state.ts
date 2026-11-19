import "server-only";
import { db } from "@/lib/db/server";
import type { Conversation } from "@/lib/db/types";
import type { ConversationState } from "@/lib/agents/types";

/** A flow left idle this long starts over from the menu (PRD: conversations table). */
export const STATE_TTL_MS = 30 * 60 * 1000;

export async function loadState(phone: string, now = new Date()): Promise<ConversationState | null> {
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
  phone: string,
  role: Conversation["role"],
  state: ConversationState | null,
): Promise<void> {
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
