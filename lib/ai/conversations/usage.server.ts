import { standardModelTokenRates } from "@/lib/calc/supervisorTokenCost";
import {modelFamily} from "@/lib/ai/conversations/modelFamily";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { authenticatedConversationContext, ConversationApiError } from "./auth.server";
import type { ConversationScope } from "./contracts";
import {currentDurableUsageAccounting} from "@/lib/ai/supervisor/runs/usage.server";
import type {ProviderUsageReceipt,ToolUsageReceipt} from "@/lib/ai/agent/executionPolicy";
export type SupervisorUsage = {model:string;inputTokens:number;outputTokens:number;modelCallCount:number;toolCallCount:number;executionMetrics?:{requests:ProviderUsageReceipt[];tools:ToolUsageReceipt[]}};

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
  const primaryModel = configuredSupervisorModel();
  const fallbackModel = process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim();
  // Token rates are model-specific. Unknown/snapshot-mismatched model identities,
  // or unconfigured fallback rates, must produce NULL rather than primary pricing.
  const fallbackUsed = Boolean(fallbackModel && fallbackModel!==primaryModel && usage.model===fallbackModel);
  const primaryUsed = usage.model===primaryModel;
  const inputRate = fallbackUsed
    ? process.env.SUPERVISOR_FALLBACK_INPUT_USD_PER_MILLION_TOKENS
    : primaryUsed ? process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS : undefined;
  const outputRate = fallbackUsed
    ? process.env.SUPERVISOR_FALLBACK_OUTPUT_USD_PER_MILLION_TOKENS
    : primaryUsed ? process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS : undefined;
  const family=modelFamily(usage.model);
  if(!family)console.error("unpriced_model",{model:usage.model});
  const standard=family?standardModelTokenRates(usage.model,null,usage.inputTokens):null;
  const known=usage.executionMetrics?.requests;
  const cost=usage.modelCallCount===0&&usage.inputTokens===0&&usage.outputTokens===0?0:
    known?known.length===usage.modelCallCount&&known.every(x=>x.estimatedCostMicros!==null)?known.reduce((sum,x)=>sum+(x.estimatedCostMicros??0),0):null:
    family?estimateSupervisorCostMicros(usage.inputTokens,usage.outputTokens,
      inputRate??standard?.input,outputRate??standard?.output):null;
  const admin = createAdminSupabaseClient();
  // Atomic additive write: failed attempt plus Retry never discard previously incurred usage.
  const accounting=currentDurableUsageAccounting({...scope,threadId,ownerMessageId},usage.modelCallCount);
  const name=accounting?"supervisor_record_durable_usage_increment":"record_supervisor_usage_increment";
  const args={
    ...(accounting?{p_run_id:accounting.runId,p_attempt_ids:accounting.attemptIds}:{}),
    p_business_id:scope.businessId,p_owner_user_id:scope.ownerUserId,
    p_thread_id:threadId,p_owner_message_id:ownerMessageId,
    p_model:usage.model,p_input_tokens:usage.inputTokens,p_output_tokens:usage.outputTokens,
    p_model_call_count:usage.modelCallCount,p_tool_call_count:usage.toolCallCount,
    p_estimated_cost_micros:cost,
  };
  let {error}=await admin.rpc(name,usage.executionMetrics?{...args,p_execution_metrics:usage.executionMetrics}:args);
  // Only a missing signature means the old database has not migrated yet.
  // Never retry an uncertain write or a rejected owner/attempt fence.
  if(usage.executionMetrics&&(error?.code==="PGRST202"||error?.code==="42883"))({error}=await admin.rpc(name,args));
  if(error)throw error;
}

/** Read via the owner's cookie-authenticated, RLS-enforced client, not service role.
 * The caller is authenticatedConversationContext() with exact owner/café checks.
 */
/** Owner-scoped ledger gate before launching a billable agent turn.
 * Uses existing RLS-protected usage records; no migration is needed.
 * A future finite entitlement counts attempts per owner and UTC day, including retries. Current Max is unlimited.
 */
/** All current owners are Max. Future commercial allowances must come from a trusted server policy, not a browser or obsolete global environment cap. */
export function ownerModelCallsLimit(): number | null { return null; }
export async function assertOwnerAgentTurnAvailable(scope: ConversationScope, scopedClient?:SupabaseClient, dailyCap: number | null = ownerModelCallsLimit()): Promise<void> {
  const session = scopedClient ?? await createServerSupabaseClient();
  // allowed: UTC quota bucket. ai_usage_events.attempt_day is an existing UTC quota key,
  // not a café calendar date or a date shown to the owner.
  const utcQuotaBucketDay = new Date().toISOString().slice(0, 10);
  const [interactive,proactive] = await Promise.all([
    session.from("ai_usage_events").select("model_call_count,reserved_model_call_count")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .eq("attempt_day", utcQuotaBucketDay),
    session.from("supervisor_system_usage_events").select("model_call_count")
      .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
      .eq("attempt_day", utcQuotaBucketDay),
  ]);
  if (interactive.error || proactive.error || !interactive.data || !proactive.data)
    throw new ConversationApiError(503, "usage_unavailable");
  // The owner daily quota covers BOTH user-requested turns and unprompted
  // model calls. Attempts count even after a timeout/provider failure; they
  // are reserved before transport, not erased by failed investigations.
  const calls = interactive.data.reduce((total,entry)=>
    total+Number(entry.model_call_count)-Number(entry.reserved_model_call_count??0),0)
    +proactive.data.reduce((total,entry)=>total+Number(entry.model_call_count),0);
  if (dailyCap !== null && calls >= dailyCap)
    throw new ConversationApiError(429, "owner_usage_limit_reached");
}

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

export type OwnerUsageSummary={periodStart:string;ownerRequests:number;proactiveItems:number};
export async function readOwnerSupervisorUsage():Promise<OwnerUsageSummary>{
  const {scope}=await authenticatedConversationContext();
  const client=await createServerSupabaseClient();
  const {data,error}=await client.rpc("supervisor_owner_usage_summary",{p_business_id:scope.businessId});
  if(error||!data||typeof data.periodStart!=="string"||
    ![data.ownerRequests,data.proactiveItems].every(n=>Number.isSafeInteger(n)&&n>=0))
    throw new Error("usage_unavailable");
  return {periodStart:data.periodStart,ownerRequests:data.ownerRequests,proactiveItems:data.proactiveItems};
}
