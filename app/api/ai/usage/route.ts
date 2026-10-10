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
    // Supabase/PostgREST defaults to a 1,000-row page. Never silently
    // undercount a busy café's AI usage once this ledger grows beyond it.
    const events: Array<{ input_tokens: number; output_tokens: number; estimated_cost_micros: number | null }> = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client.from("ai_usage_events")
        .select("input_tokens, output_tokens, estimated_cost_micros")
        .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      for (const row of data ?? []) {
        events.push({
          input_tokens: Number(row.input_tokens),
          output_tokens: Number(row.output_tokens),
          estimated_cost_micros: row.estimated_cost_micros === null ? null : Number(row.estimated_cost_micros),
        });
      }
      if (!data || data.length < pageSize) break;
    }
    return conversationJson({ businessId: scope.businessId, ...summarizeSupervisorUsage(events) });
  } catch (error) {
    return conversationError(error);
  }
}
