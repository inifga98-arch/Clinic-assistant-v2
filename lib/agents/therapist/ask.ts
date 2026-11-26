import "server-only";
import type { AgentResult, TherapistContext } from "@/lib/agents/types";
import { answerFromRecord, type AskTurn } from "@/lib/ai/ask-record";
import { transcribeVoiceNote } from "@/lib/ai/transcribe";
import { deleteTwilioMedia } from "@/lib/whatsapp/media";
import { sendOptions, sendText } from "@/lib/whatsapp/send";
import { ASK_OPTIONS, ASK_PROMPT, askIntro, formatAnswer, groundedStatements, groundedSuggestion, isSmallTalk } from "./ask-format";
import { getPatient } from "./patient-store";
import { shortDate } from "./prep-format";
import { buildRecord, recordText } from "./record-format";
import { loadRecord } from "./record-store";

// Ask about a patient after the prep brief. Owner: Person 1.
// Design: docs/superpowers/specs/2026-11-26-ask-patient-design.md. The therapist asks by text or
// voice; each answer is built from the whole confirmed record, statements cite it, and the AI's
// opinion is labelled as a suggestion. Writes nothing. The options (📝 / 🏠) are handled in index.ts.

export const ASK_FLOW = "ask";
const HISTORY = 3;

interface AskState {
  patientId: string;
  history: AskTurn[];
}

const state = (context: AskState): AgentResult => ({
  nextState: { flow: ASK_FLOW, step: "asking", context: context as unknown as Record<string, unknown> },
});

/** From the brief: 💬 (no question yet), or a question typed or spoken straight away. */
export async function startAsk(ctx: TherapistContext, patientId: string, withQuestion: boolean): Promise<AgentResult> {
  if (withQuestion) return handleAsk({ ...ctx, state: { flow: ASK_FLOW, step: "asking", context: { patientId, history: [] } } });
  const patient = await getPatient(patientId);
  if (!patient) return lost(ctx.message.phone);
  await sendText(ctx.message.phone, askIntro(patient.full_name));
  return state({ patientId, history: [] });
}

/** A question while asking (the options were already matched in index.ts). */
export async function handleAsk(ctx: TherapistContext): Promise<AgentResult> {
  const { message } = ctx;
  const phone = message.phone;
  const c = (ctx.state?.context ?? {}) as Partial<AskState>;
  if (!c.patientId) return lost(phone);
  const current: AskState = { patientId: c.patientId, history: c.history ?? [] };

  // No question uses photos: delete them from Twilio and say so.
  const images = message.media.filter((m) => m.contentType.startsWith("image/"));
  for (const image of images) await deleteTwilioMedia(image.url).catch(() => undefined);
  const audio = message.media.find((m) => m.contentType.startsWith("audio/"));
  if (images.length) await sendText(phone, "No uso fotos para responder; la borré.");

  let question = message.body.trim();
  if (audio) {
    try {
      question = [question, (await transcribeVoiceNote(audio.url, { timeoutMs: 20_000 })).trim()].filter(Boolean).join(" ");
    } catch (err) {
      console.error("[ask] transcription failed", message.sid, err);
      await sendText(phone, "No pude escuchar tu nota de voz. ¿Me escribes la pregunta?");
      return state(current);
    }
  }
  if (!question || isSmallTalk(question)) {
    await sendOptions(phone, ASK_PROMPT, ASK_OPTIONS);
    return state(current);
  }

  const patient = await getPatient(current.patientId);
  if (!patient) return lost(phone);
  const data = await loadRecord(patient);
  const entries = buildRecord(data);
  const record = recordText(entries);

  let answer: string;
  try {
    const raw = await answerFromRecord(record, current.history, question, shortDate(data.today));
    const statements = groundedStatements(raw.statements, entries);
    // The opinion may propose new loads, but a date or measure it quotes must be in the record.
    const suggestion = groundedSuggestion(raw.suggestion, record);
    if (statements.length < raw.statements.length || (raw.suggestion && !suggestion)) {
      console.warn("[ask] dropped ungrounded lines", patient.id, {
        statements: raw.statements.length - statements.length,
        suggestion: raw.suggestion && !suggestion ? raw.suggestion : null,
      });
    }
    answer = formatAnswer(statements, suggestion, raw.statements.length > 0 && statements.length === 0);
  } catch (err) {
    console.error("[ask] answer failed", patient.id, err);
    await sendOptions(phone, `No pude responder ahora. Intenta de nuevo en un momento.\n\n${ASK_PROMPT}`, ASK_OPTIONS);
    return state(current);
  }

  await sendOptions(phone, `${answer}\n\n${ASK_PROMPT}`, ASK_OPTIONS);
  const history = [...current.history, { q: question.slice(0, 300), a: answer.slice(0, 600) }].slice(-HISTORY);
  return state({ ...current, history });
}

async function lost(phone: string): Promise<AgentResult> {
  await sendText(phone, "Perdí el hilo. Escribe *menu* para empezar de nuevo.");
  return { nextState: null };
}
