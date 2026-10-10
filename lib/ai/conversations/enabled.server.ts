import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";

/** Default off. Turn on only after Phase 3 migration and staging RLS verification. */
export function isSupervisorChatConfigured(): boolean {
  return process.env.SUPERVISOR_CHAT_ENABLED === "true" &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
    isSupabaseConfigured();
}
