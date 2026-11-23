import "server-only";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "@/lib/env";

export interface DownloadedMedia {
  data: Buffer;
  contentType: string;
}

const AUDIO_TYPES: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export function audioTypeForPath(path: string): string {
  return AUDIO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

let localMediaAllowed = false;

/**
 * Let downloadMedia read file:// URLs. Only the simulator calls this. The web server never
 * does, so a forged webhook can't make it read files from the machine it runs on.
 */
export function allowLocalMedia(): void {
  localMediaAllowed = true;
}

/**
 * R-6: download a media file Twilio received (voice notes arrive as audio/ogg, Opus).
 * Twilio media URLs need the account credentials and redirect to the file.
 * The simulator passes local voice notes as file:// URLs (see allowLocalMedia).
 */
export async function downloadMedia(url: string): Promise<DownloadedMedia> {
  if (url.startsWith("file:")) {
    if (!localMediaAllowed) throw new Error("file:// media is only allowed in the simulator");
    const path = fileURLToPath(url);
    return { data: await readFile(path), contentType: audioTypeForPath(path) };
  }
  const auth = Buffer.from(
    `${requireEnv("TWILIO_ACCOUNT_SID")}:${requireEnv("TWILIO_AUTH_TOKEN")}`,
  ).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: "follow" });
  if (!res.ok) throw new Error(`Media download failed: ${res.status} ${res.statusText}`);
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}
