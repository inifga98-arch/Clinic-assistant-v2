import "server-only";
import OpenAI from "openai";
import { requireEnv } from "@/lib/env";

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY"), timeout: 45_000, maxRetries: 1 }); // stay inside the 60 s webhook limit
  return client;
}
