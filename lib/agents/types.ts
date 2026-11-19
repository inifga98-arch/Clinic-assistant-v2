// The contract between the router (Person 3) and the agents (Persons 1 and 3).
// Agreed in Phase 1. Change it only through a reviewed PR.

import type { Patient, Therapist } from "@/lib/db/types";

export interface IncomingMedia {
  url: string; // Twilio media URL; download with lib/whatsapp/media.ts
  contentType: string; // e.g. "audio/ogg" for a voice note
}

export interface IncomingMessage {
  sid: string; // Twilio MessageSid, unique per message
  phone: string; // sender, E.164
  body: string; // text as typed ("" for a voice note with no caption)
  buttonPayload: string | null; // id of the quick reply tapped, when Twilio sends one
  media: IncomingMedia[];
  receivedAt: Date;
}

/** Where the user is in a multi-turn flow. Saved per phone by the router. */
export interface ConversationState {
  flow: string; // e.g. "session_note"
  step: string; // e.g. "awaiting_confirmation"
  context: Record<string, unknown>; // anything the flow needs between messages (JSON only)
}

export interface TherapistContext {
  therapist: Therapist;
  message: IncomingMessage;
  /** Current flow state, or null when idle, expired, or the user typed "menu"/"cancelar". */
  state: ConversationState | null;
  /** True when the user typed "menu"/"cancelar" and the router cleared the state (X-3). */
  reset: boolean;
}

export interface PatientContext {
  patient: Patient;
  message: IncomingMessage;
  state: ConversationState | null;
  reset: boolean;
}

/**
 * What an agent returns. The agent sends its own replies (lib/whatsapp/send.ts);
 * the router saves `nextState` (null = flow finished, clear the state).
 */
export interface AgentResult {
  nextState: ConversationState | null;
}

export type TherapistHandler = (ctx: TherapistContext) => Promise<AgentResult>;
export type PatientHandler = (ctx: PatientContext) => Promise<AgentResult>;
