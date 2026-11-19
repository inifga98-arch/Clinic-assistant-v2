import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";

let client: SupabaseClient | null = null;

/**
 * Service-role client for server code (webhook, agents, cron). Bypasses RLS, so never
 * import this from a client component or pass its results to the browser unfiltered.
 * The CRM reads as the logged-in user instead (Person 2: @supabase/ssr).
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return client;
}
