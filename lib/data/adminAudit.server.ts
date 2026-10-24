import { modelFamily } from "@/lib/ai/conversations/modelFamily";
import { standardModelTokenRates } from "@/lib/calc/supervisorTokenCost";
import "server-only";
import { after } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { classifyOwnerQuestion, TOPIC_VERSION } from "@/lib/admin/topics";
import { estimateSupervisorCostMicros } from "@/lib/ai/conversations/usage.server";
import type { ConversationMessage, ConversationScope } from "@/lib/ai/conversations/contracts";
import type { AgentTurn, AgentAuditStep } from "@/lib/ai/agent/loop.server";

/** Audit records contain ONLY controlled diagnostics. Raw prompts, answers,
 * receipts, personal names, addresses, bank lines and free-form feedback are
 * NEVER persisted here; regex-only redaction cannot reliably identify PII. */
export function redactAuditText(value: string, _max = 4000): string {
  return value ? "[content withheld]" : "";
}
const stepInputs = new Set(["Final response; no tools","Model request; prompts withheld",
  "Draft request"]);
const stepOutputs = new Set(["Completed","Incomplete","Tool failed","Missing input(s)",
  "Awaiting owner approval"]);
const stepErrors = new Set(["model_call_failed","invalid_arguments","invalid_json",
  "deadline_exceeded","tool_unavailable"]);
function safeStepSummary(value: string | undefined, allowed: Set<string>): string | null {
  return value && allowed.has(value) ? value : null;
}
function safeToolName(value: string | undefined): string | null {
  return value && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}
export type TurnAudit = {
  scope: ConversationScope;
  owner: ConversationMessage;
  replyId?: string;
  answer?: string;
  status: "ok" | "failed" | "timeout" | "cancelled";
  error?: string;
  startedAt: number;
  endedAt: number;
  turn?: AgentTurn;
  steps: readonly AgentAuditStep[];
};
export function estimatedTurnCost(turn: AgentTurn | undefined): number | null {
  if (!turn) return null;
  // Provider pricing changes. Only show a cost if BOTH actual rates were explicitly set.
  // Reuse the existing supervisor model prices, unless an explicit *pair* of
  // admin-specific prices was set. Missing or invalid prices remain NULL.
  const customInput=process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
  const customOutput=process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
  const adminOverride=customInput!==undefined || customOutput!==undefined;
  const family=turn.usage.model?modelFamily(turn.usage.model):null;
  if(!family){console.error("unpriced_model",{model:turn.usage.model??"unknown"});return null;}
  const rates=standardModelTokenRates(turn.usage.model!,null,turn.usage.inputTokens);
  const micros=estimateSupervisorCostMicros(turn.usage.inputTokens,turn.usage.outputTokens,
    adminOverride ? customInput : process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS??rates?.input,
    adminOverride ? customOutput : process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS??rates?.output);
  return micros===null?null:micros/1_000_000;
}
async function writeTurnAudit(a: TurnAudit): Promise<void> {
  const db = createAdminSupabaseClient();
  const { data: previous, error: previousError } = await db.from("agent_turn_logs").select("id")
    .eq("business_id", a.scope.businessId).eq("owner_message_id", a.owner.id)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (previousError) throw previousError;
  const { data, error } = await db.from("agent_turn_logs").insert({
    business_id: a.scope.businessId,
    owner_user_id: a.scope.ownerUserId,
    thread_id: a.owner.threadId,
    owner_message_id: a.owner.id,
    message_id: a.replyId ?? null,
    question: "Owner question withheld",
    question_topic: classifyOwnerQuestion(a.owner.text ?? ""),
    topic_version: TOPIC_VERSION,
    final_answer: a.answer == null ? null : "Assistant answer withheld",
    status: a.status,
    error_text: a.error ? "agent_turn_failed" : null,
    started_at: new Date(a.startedAt).toISOString(),
    ended_at: new Date(a.endedAt).toISOString(),
    duration_ms: Math.max(0, a.endedAt - a.startedAt),
    model: a.turn ? a.turn.usage.model??"unknown" : null,
    input_tokens: a.turn?.usage.inputTokens ?? null,
    output_tokens: a.turn?.usage.outputTokens ?? null,
    cost_usd: estimatedTurnCost(a.turn),
    retry_of: previous?.id ?? null,
  }).select("id").single();
  if (error) throw error;
  if (!a.steps.length) return;
  const { error: stepError } = await db.from("agent_turn_steps").insert(a.steps.map((step, index) => ({
    turn_id: data.id, step_order: index + 1, kind: step.kind,
    tool_name: safeToolName(step.toolName),
    input_summary: safeStepSummary(step.inputSummary, stepInputs),
    output_summary: safeStepSummary(step.outputSummary, stepOutputs),
    duration_ms: step.durationMs,
    error: step.error && stepErrors.has(step.error) ? step.error : step.error ? "step_failed" : null,
  })));
  if (stepError) throw stepError;
}
/** Work begins only after the reply is settled. Never await, throw or delay SSE.
 * next/after keeps this best-effort task alive after the response is sent. */
export function scheduleTurnAudit(a: TurnAudit): void {
  try {
    after(async () => {
      try { await writeTurnAudit(a); } catch { console.error("admin_turn_log_write_failed"); }
    });
  } catch {
    // Non-Next test harness: no request context to register after().
    void writeTurnAudit(a).catch(() => console.error("admin_turn_log_write_failed"));
  }
}
