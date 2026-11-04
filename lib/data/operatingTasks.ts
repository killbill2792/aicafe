import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import type { OperatingTask } from "@/lib/operating/tasks";

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
 * The one writer for an item the inbox computes on read (price reviews). Called only by an
 * owner decision on that item, never on page load. Idempotent on the stable key
 * (business_id, id): a repeat or a race inserts nothing.
 */
export async function storeDerivedOperatingTask(client: SupabaseClient, businessId: string, task: OperatingTask): Promise<void> {
  if (task.businessId !== businessId) throw new Error("Operating task business mismatch");
  const { error } = await client.from("operating_tasks").upsert({
    id: task.id, business_id: businessId, agent_id: task.agentId, kind: task.kind,
    entity_type: task.entityType ?? null, entity_id: task.entityId ?? null, status: task.status,
    payload: task.payload, confidence: task.confidence, evidence: task.evidence, created_at: task.createdAt,
  }, { onConflict: "business_id,id", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Phase 2 read-only projection of the SAME persisted operating_tasks inbox.
 * This never reconciles, inserts, updates,
 * expires, or responds to tasks. Future Supervisor summaries must use these
 * statuses, not raw engine signals, for Needs You / Handled / Watching claims.
 */
export async function readPersistedOperatingTasks(businessId: string, explicit?:{client:SupabaseClient;businessId:string}): Promise<OperatingTask[]> {
  if (!isSupabaseConfigured()) throw new Error("Persisted café tasks are unavailable");
  const supabase = explicit?.client ?? await createServerSupabaseClient();
  if (explicit) {
    if(businessId !== explicit.businessId)throw new Error("Café task access scope mismatch");
  } else {
    const {data:{user}}=await supabase.auth.getUser();
    if(!user || businessId !== await getActiveBusinessId(user.id))
      throw new Error("Café task access scope mismatch");
  }
  const { data, error } = await supabase
    .from("operating_tasks")
    .select("id, business_id, agent_id, kind, entity_type, entity_id, status, payload, confidence, evidence, created_at, resolved_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as TaskRow[]).map(fromRow);
}
