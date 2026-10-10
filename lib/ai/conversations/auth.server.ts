import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { ConversationService } from "./service";
import { SupabaseConversationRepository } from "./supabase.server";
import type { ConversationScope } from "./contracts";

export class ConversationApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** API-specific auth. Unlike page guards, never redirect an XHR to HTML.
 * No demo fixture fallback and no manager/profit-bypass access.
 */
export async function authenticatedConversationService(): Promise<ConversationService> {
  if (!isSupabaseConfigured()) throw new ConversationApiError(503, "service_unavailable");
  const client = await createServerSupabaseClient();
  const { data: { user }, error: userError } = await client.auth.getUser();
  if (userError || !user) throw new ConversationApiError(401, "authentication_required");

  const businessId = await getActiveBusinessId(user.id);
  const { data: membership, error: membershipError } = await client.from("memberships")
    .select("role").eq("business_id", businessId).eq("user_id", user.id).maybeSingle();
  if (membershipError) throw membershipError;
  if (membership?.role !== "owner") throw new ConversationApiError(403, "owner_access_required");

  const scope: ConversationScope = { businessId, ownerUserId: user.id };
  return new ConversationService(new SupabaseConversationRepository(client), scope);
}
