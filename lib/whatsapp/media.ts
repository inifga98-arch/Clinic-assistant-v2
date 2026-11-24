import "server-only";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requireEnv } from "@/lib/env";
import { mediaTypeForPath } from "./media-types";

export { mediaTypeForPath };

export interface DownloadedMedia {
  data: Buffer;
  contentType: string;
}

/** Kept for existing callers; covers images too now. */
export const audioTypeForPath = mediaTypeForPath;

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
    return { data: await readFile(path), contentType: mediaTypeForPath(path) };
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

/**
 * Delete a media file from Twilio (Flow A: form photos are not kept once they are read).
 * Best effort: never throws; 204 and 404 both mean it is gone. file:// URLs are a no-op.
 */
export async function deleteTwilioMedia(url: string): Promise<void> {
  if (url.startsWith("file:")) return;
  try {
    const auth = Buffer.from(
      `${requireEnv("TWILIO_ACCOUNT_SID")}:${requireEnv("TWILIO_AUTH_TOKEN")}`,
    ).toString("base64");
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Basic ${auth}` } });
    if (res.status !== 204 && res.status !== 404) {
      console.error("[media] could not delete Twilio media", url, res.status);
    }
  } catch (err) {
    console.error("[media] could not delete Twilio media", url, err);
  }
}
