"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { storeDerivedOperatingTask } from "@/lib/data/operatingTasks";
import { applyTaskResponse, type OperatingTask, type OperatingTaskResponse } from "@/lib/operating/tasks";

const ownerDecisionSchema = z.object({ taskId: z.string().min(1).max(500), decision: z.enum(["keep_price", "later_7", "later_30", "later_change"]) });
/** The price review the inbox shows right now for this id, from the same projection. */
async function currentPriceReview(taskId: string): Promise<OperatingTask | null> {
  const [{ getSnapshot }, { getMenuControlCenter }, { buildOperationsTeamViewModel }] = await Promise.all([
    import("@/lib/data/getSnapshot"), import("@/lib/data/getMenuControlCenter"), import("@/lib/viewmodels/operationsTeam")]);
  const [snapshot, menu] = await Promise.all([getSnapshot(), getMenuControlCenter()]);
  return buildOperationsTeamViewModel(snapshot, menu).needsYou.find((task) => task.id === taskId && task.kind === "price_review") ?? null;
}
export type OwnerTaskDecisionResult = { ok: true } | { ok: false; error: string };

export async function respondToPriceReview(input: unknown): Promise<OwnerTaskDecisionResult> {
  const parsed = ownerDecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_signed_in" };
  const businessId = await getActiveBusinessId(user.id);
  const readRow = () => supabase.from("operating_tasks")
    .select("id, business_id, agent_id, kind, entity_type, entity_id, status, payload, confidence, evidence, created_at, resolved_at")
    .eq("business_id", businessId).eq("id", parsed.data.taskId).maybeSingle();
  let { data: row, error: readError } = await readRow();
  if (!readError && !row) {
    // Price reviews are computed on read; the owner's decision is what stores one.
    const derived = await currentPriceReview(parsed.data.taskId);
    if (!derived || derived.businessId !== businessId) return { ok: false, error: "task_not_available" };
    try { await storeDerivedOperatingTask(supabase, businessId, derived); } catch { return { ok: false, error: "task_not_available" }; }
    ({ data: row, error: readError } = await readRow());
  }
  if (readError || !row || row.kind !== "price_review" || row.status !== "needs_owner") return { ok: false, error: "task_not_available" };

  const task: OperatingTask = { id: row.id, businessId: row.business_id, agentId: row.agent_id, kind: row.kind,
    ...(row.entity_type ? { entityType: row.entity_type } : {}), ...(row.entity_id ? { entityId: row.entity_id } : {}),
    status: row.status, payload: row.payload, confidence: row.confidence, evidence: row.evidence, createdAt: row.created_at };
  const respondedAt = new Date().toISOString();
  const response: OperatingTaskResponse = { taskId: task.id, actor: "owner", responseCode: parsed.data.decision, respondedAt };
  const next = applyTaskResponse(task, response);
  const { data: inserted, error: responseError } = await supabase.from("operating_task_responses").insert({ business_id: businessId, task_id: task.id,
    actor_type: "owner", employee_id: null, response_code: response.responseCode, responded_at: respondedAt }).select("id").single();
  if (responseError || !inserted) return { ok: false, error: "response_not_saved" };

  const { data: updated, error: updateError } = await supabase.from("operating_tasks").update({ status: next.status, payload: next.payload,
    resolved_at: next.resolvedAt ?? null, updated_at: respondedAt }).eq("business_id", businessId).eq("id", task.id).eq("status", "needs_owner").select("id").maybeSingle();
  if (updateError || !updated) {
    await supabase.from("operating_task_responses").delete().eq("business_id", businessId).eq("id", inserted.id);
    return { ok: false, error: "task_not_updated" };
  }
  revalidatePath("/operations");
  revalidatePath("/");
  return { ok: true };
}

/**
 * A terminal experiment report is a notification, not a request to change
 * the POS price. Only its owning cafe's owner can mark it reviewed.
 * A conditional update keeps repeated clicks/competing clients idempotent;
 * subsequent report refreshes update evidence without reopening the task.
 */
export async function acknowledgeExperimentReport(input: unknown): Promise<OwnerTaskDecisionResult> {
  const parsed = z.object({ taskId: z.string().min(1).max(500) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const { authenticatedConversationContext } = await import("@/lib/ai/conversations/auth.server");
  let businessId: string;
  try {
    businessId = (await authenticatedConversationContext()).scope.businessId;
  } catch {
    return { ok: false, error: "owner_access_required" };
  }
  const supabase = await createServerSupabaseClient();
  const { data: row, error: readError } = await supabase.from("operating_tasks")
    .select("id,kind,status").eq("business_id", businessId)
    .eq("id", parsed.data.taskId).maybeSingle();
  if (readError || !row || row.kind !== "price_experiment_report" || row.status !== "needs_owner")
    return { ok: false, error: "task_not_available" };

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase.from("operating_tasks")
    .update({ status: "handled", resolved_at: now, updated_at: now })
    .eq("business_id", businessId).eq("id", row.id)
    .eq("kind", "price_experiment_report").eq("status", "needs_owner")
    .select("id").maybeSingle();
  if (error || !updated) return { ok: false, error: "task_not_updated" };
  revalidatePath("/operations");
  revalidatePath("/");
  return { ok: true };
}
