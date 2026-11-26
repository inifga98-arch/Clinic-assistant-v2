import "server-only";
import { toFile } from "openai";
import { optionalEnv } from "@/lib/env";
import { downloadMedia } from "@/lib/whatsapp/media";
import { openai } from "./openai";

/** Download a WhatsApp voice note from Twilio and transcribe it (Spanish). */
/**
 * `timeoutMs`: for short questions or names, where a slow transcription must leave room in the
 * 60 s webhook for the next call (one try, no retry). Without it, the client's 45 s + 1 retry.
 */
export async function transcribeVoiceNote(mediaUrl: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const { data, contentType } = await downloadMedia(mediaUrl);
  const file = await toFile(data, `voice.${extensionFor(contentType)}`, { type: contentType });
  const result = await openai().audio.transcriptions.create(
    {
      file,
      model: optionalEnv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe"),
      language: "es",
    },
    opts.timeoutMs ? { timeout: opts.timeoutMs, maxRetries: 0 } : undefined,
  );
  return result.text.trim();
}

function extensionFor(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const known: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  return known[type] ?? "ogg";
}
