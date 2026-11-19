import "server-only";
import { requireEnv } from "@/lib/env";

export interface DownloadedMedia {
  data: Buffer;
  contentType: string;
}

/**
 * R-6: download a media file Twilio received (voice notes arrive as audio/ogg, Opus).
 * Twilio media URLs need the account credentials and redirect to the file.
 */
export async function downloadMedia(url: string): Promise<DownloadedMedia> {
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
