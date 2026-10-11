import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { ConversationScope } from "./contracts";
import type { SupervisorUsage } from "./runSupervisorTurn.server";

/** A dollar rate is configured per million tokens; cost is stored in millionths of a USD.
 * A missing rate is NULL, not a fabricated "$0" estimate. No financial business math is touched.
 */
export function estimateSupervisorCostMicros(
  inputTokens: number, outputTokens: number, inputRate: string | undefined, outputRate: string | undefined,
): number | null {
  if (!inputRate || !outputRate) return null;
  const inRate = Number(inputRate), outRate = Number(outputRate);
  if (![inputRate, outputRate].every((s) => s?.trim()) ||
    ![inRate, outRate].every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) return null;
  if (![inputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  const micros = Math.round(inputTokens * inRate + outputTokens * outRate);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : null;
}

export function deriveInitialThreadTitle(text: string): string {
  const normalized = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  // Avoid an extra model request or storing any generated business claims.
  const slice = Array.from(normalized).slice(0, 66).join("");
  const title = slice.length < normalized.length ? slice.trimEnd() + "…" : slice;
  return title.slice(0, 120) || "Conversation";
}

/** Server-only, tenant-scoped initial title. Never overwrite owner-provided titles.
 * Failing to assign a title must never corrupt a persisted message or reply.
 */
export async function labelSupervisorThread(scope: ConversationScope, threadId: string, ownerText: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin.from("ai_threads").update({
    title: deriveInitialThreadTitle(ownerText),
  }).eq("id", threadId).eq("business_id", scope.businessId)
    .eq("owner_user_id", scope.ownerUserId).is("title", null);
  if (error) throw error;
}

export async function recordSupervisorUsage(params: {
  scope: ConversationScope; threadId: string; ownerMessageId: string; usage: SupervisorUsage;
}): Promise<void> {
  const { scope, threadId, ownerMessageId, usage } = params;
  const cost = estimateSupervisorCostMicros(usage.inputTokens, usage.outputTokens,
    process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS,
    process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS);
  const admin = createAdminSupabaseClient();
  const { error } = await admin.from("ai_usage_events").upsert({
    business_id: scope.businessId, owner_user_id: scope.ownerUserId,
    thread_id: threadId, owner_message_id: ownerMessageId,
    provider: "openai", model: usage.model,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    model_call_count: usage.modelCallCount, tool_call_count: usage.toolCallCount,
    estimated_cost_micros: cost,
  }, { onConflict: "owner_message_id", ignoreDuplicates: true });
  if (error) throw error;
}

/** Read via the owner's cookie-authenticated, RLS-enforced client, not service role.
 * The caller is authenticatedConversationContext() with exact owner/café checks.
 */
export function summarizeSupervisorUsage(rows: Array<{
  input_tokens: number; output_tokens: number; estimated_cost_micros: number | null;
}>) {
  return {
    requests: rows.length,
    inputTokens: rows.reduce((n, row) => n + row.input_tokens, 0),
    outputTokens: rows.reduce((n, row) => n + row.output_tokens, 0),
    estimatedCostMicros: rows.every((row) => row.estimated_cost_micros !== null)
      ? rows.reduce((n, row) => n + (row.estimated_cost_micros ?? 0), 0) : null,
  };
}
