import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import type { OperatingTask, OperatingTaskResponse } from "@/lib/operating/tasks";
import { reconcileOperatingTasks } from "@/lib/operating/reconcileTasks";

type TaskRow = {
  id: string; business_id: string; agent_id: OperatingTask["agentId"]; kind: OperatingTask["kind"];
  entity_type: string | null; entity_id: string | null; status: OperatingTask["status"];
  payload: OperatingTask["payload"]; confidence: OperatingTask["confidence"];
  evidence: OperatingTask["evidence"]; created_at: string; resolved_at: string | null;
};

function fromRow(row: TaskRow): OperatingTask {
  return { id: row.id, businessId: row.business_id, agentId: row.agent_id, kind: row.kind,
    ...(row.entity_type ? { entityType: row.entity_type } : {}), ...(row.entity_id ? { entityId: row.entity_id } : {}),
    status: row.status, payload: row.payload, confidence: row.confidence, evidence: row.evidence,
    createdAt: row.created_at, ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}) };
}

/**
 * Stores today's deterministic discoveries, then returns the business's complete persisted inbox.
 * Existing rows only receive refreshed evidence/payload/entity fields: lifecycle fields are never
 * overwritten, so handled history cannot spring back to "Needs you" on the next page load.
 */
export async function syncAndGetOperatingTasks(derived: OperatingTask[]): Promise<{ tasks: OperatingTask[]; responses: OperatingTaskResponse[] }> {
  if (!isSupabaseConfigured()) return { tasks: derived, responses: [] };
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { tasks: [], responses: [] };
  const businessId = await getActiveBusinessId(user.id);
  if (derived.some((task) => task.businessId !== businessId)) throw new Error("Operating task business mismatch");

  {
    const { data: existingRows, error: existingError } = await supabase.from("operating_tasks").select("id, business_id, agent_id, kind, entity_type, entity_id, status, payload, confidence, evidence, created_at, resolved_at").eq("business_id", businessId);
    if (existingError) throw existingError;
    const plan = reconcileOperatingTasks((existingRows as TaskRow[]).map(fromRow), derived, new Date());
    const missing = plan.insert.map((task) => ({
      id: task.id, business_id: businessId, agent_id: task.agentId, kind: task.kind,
      entity_type: task.entityType ?? null, entity_id: task.entityId ?? null, status: task.status,
      payload: task.payload, confidence: task.confidence, evidence: task.evidence, created_at: task.createdAt,
    }));
    if (missing.length > 0) {
      const { error } = await supabase.from("operating_tasks").upsert(missing, { onConflict: "business_id,id", ignoreDuplicates: true });
      if (error) throw error;
    }
    await Promise.all(plan.refresh.map(async (task) => {
      const { error } = await supabase.from("operating_tasks").update({ agent_id: task.agentId, kind: task.kind,
        entity_type: task.entityType ?? null, entity_id: task.entityId ?? null, payload: task.payload,
        confidence: task.confidence, evidence: task.evidence, updated_at: new Date().toISOString() })
        .eq("business_id", businessId).eq("id", task.id);
      if (error) throw error;
    }));
    await Promise.all(plan.expire.map(async (task) => {
      const { error } = await supabase.from("operating_tasks").update({ status: "expired", resolved_at: task.resolvedAt, updated_at: task.resolvedAt })
        .eq("business_id", businessId).eq("id", task.id).in("status", ["watching", "needs_response", "needs_owner"]);
      if (error) throw error;
    }));
  }

  const [taskResult, responseResult] = await Promise.all([
    supabase.from("operating_tasks").select("id, business_id, agent_id, kind, entity_type, entity_id, status, payload, confidence, evidence, created_at, resolved_at").eq("business_id", businessId).order("created_at", { ascending: false }),
    supabase.from("operating_task_responses").select("task_id, actor_type, employee_id, respondent_name, response_code, short_text, responded_at").eq("business_id", businessId).order("responded_at", { ascending: false }),
  ]);
  if (taskResult.error) throw taskResult.error;
  if (responseResult.error) throw responseResult.error;
  return {
    tasks: (taskResult.data as TaskRow[]).map(fromRow),
    responses: (responseResult.data ?? []).map((row) => ({ taskId: row.task_id, actor: row.actor_type as "employee" | "owner", responseCode: row.response_code as OperatingTaskResponse["responseCode"],
      ...(row.employee_id ? { respondentId: row.employee_id } : {}), ...(row.respondent_name ? { respondentName: row.respondent_name } : {}),
      ...(row.short_text ? { shortText: row.short_text } : {}), respondedAt: row.responded_at })),
  };
}
