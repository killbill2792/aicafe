import "server-only";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { TeamRulesService } from "./service";
import { SupabaseTeamRulesRepository } from "./repository.server";

/** Reuses Phase 3's authenticated owner and selected café authorization.
 * The session RLS client is never upgraded to service-role privileges.
 */
export async function authenticatedTeamRulesService(): Promise<TeamRulesService> {
  const { scope } = await authenticatedConversationContext();
  const client = await createServerSupabaseClient();
  return new TeamRulesService(new SupabaseTeamRulesRepository(client), scope);
}
