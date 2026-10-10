import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { conversationError, conversationJson } from "@/lib/ai/conversations/http.server";
import { summarizeSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Private, RLS-filtered per-owner/per-café token and cost aggregates.
 * Does not return prompts, generated replies, credentials or other owners' usage.
 * This GET cannot write or trigger an OpenAI call.
 */
export async function GET() {
  try {
    const { scope } = await authenticatedConversationContext();
    const client = await createServerSupabaseClient();
    const { data, error } = await client.from("ai_usage_events")
      .select("input_tokens, output_tokens, estimated_cost_micros")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId);
    if (error) throw error;
    return conversationJson({
      businessId: scope.businessId,
      ...summarizeSupervisorUsage((data ?? []).map((row) => ({
        input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens),
        estimated_cost_micros: row.estimated_cost_micros === null ? null : Number(row.estimated_cost_micros),
      }))),
    });
  } catch (error) {
    return conversationError(error);
  }
}
