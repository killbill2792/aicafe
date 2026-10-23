import "server-only";
import { after } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import type { ConversationMessage, ConversationScope } from "@/lib/ai/conversations/contracts";
import type { AgentTurn, AgentAuditStep } from "@/lib/ai/agent/loop.server";

/** Diagnostics never contain tool argument/output values, auth headers or credentials.
 * Owners' questions/answers are redacted in the private database as well. */
export function redactAuditText(value: string, max = 4000): string {
  return value
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|(?:sb_secret|sb_publishable)_[a-zA-Z0-9_-]+)\b/g, "[secret]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [secret]")
    .replace(/\b(?:password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\s().-]*){10,15}\b/g, "[phone]")
    .slice(0, max);
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
  const input = Number(process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION);
  const output = Number(process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION);
  if (!process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION || !process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION ||
      !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return Math.round(((turn.usage.inputTokens * input + turn.usage.outputTokens * output) / 1_000_000) * 1_000_000) / 1_000_000;
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
    question: redactAuditText(a.owner.text ?? ""),
    final_answer: a.answer == null ? null : redactAuditText(a.answer, 15000),
    status: a.status,
    error_text: a.error ? redactAuditText(a.error, 120) : null,
    started_at: new Date(a.startedAt).toISOString(),
    ended_at: new Date(a.endedAt).toISOString(),
    duration_ms: Math.max(0, a.endedAt - a.startedAt),
    model: a.turn ? configuredSupervisorModel() : null,
    input_tokens: a.turn?.usage.inputTokens ?? null,
    output_tokens: a.turn?.usage.outputTokens ?? null,
    cost_usd: estimatedTurnCost(a.turn),
    retry_of: previous?.id ?? null,
  }).select("id").single();
  if (error) throw error;
  if (!a.steps.length) return;
  const { error: stepError } = await db.from("agent_turn_steps").insert(a.steps.map((step, index) => ({
    turn_id: data.id, step_order: index + 1, kind: step.kind,
    tool_name: step.toolName ?? null,
    input_summary: step.inputSummary ?? null,
    output_summary: step.outputSummary ?? null,
    duration_ms: step.durationMs,
    error: step.error ?? null,
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
