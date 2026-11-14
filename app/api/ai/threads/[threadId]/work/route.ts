import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput } from "@/lib/ai/conversations/http.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  projectOwnerWork, type RunRow, type StepRow, type ProposalRow, type AttemptRow, type JobRow,
} from "@/lib/ai/supervisor/runs/ownerWorkView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };

/**
 * Read-only status. Every source is filtered by the authenticated owner's café
 * and conversation; Postgres RLS independently applies the same owner gate.
 * This endpoint cannot approve, enqueue, retry or execute work.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const { scope, service } = await authenticatedConversationContext();
    await service.getThread(id); // 404 for a different owner's/café's thread
    const client = await createServerSupabaseClient();
    const [runs, jobs, proposals] = await Promise.all([
      client.from("supervisor_runs")
        .select("id,request_key,status,final_report_ref,updated_at,finished_at")
        .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
        .eq("thread_id", id).order("updated_at", { ascending: false }).limit(20),
      client.from("ai_agent_jobs")
        .select("id,owner_message_id,status,reply_message_id,error_code,attempt,heartbeat_at,created_at")
        .eq("business_id", scope.businessId).eq("thread_id", id)
        .order("created_at", { ascending: false }).limit(12),
      client.from("supervisor_proposals")
        .select("id,status,capability_id,effect_hash,updated_at")
        .eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId)
        .eq("thread_id", id).order("updated_at", { ascending: false }).limit(20),
    ]);
    if (runs.error || jobs.error || proposals.error) throw new Error("owner_work_read_failed");
    const runIds = (runs.data ?? []).map(row => row.id);
    const proposalIds = (proposals.data ?? []).map(row => row.id);
    // No empty IN clause, unscoped scan, admin bypass or cross-thread join.
    const [steps, attempts] = await Promise.all([
      runIds.length ? client.from("supervisor_run_steps")
        .select("run_id,step_key,step_index,status,attempts,error_code,updated_at")
        .eq("business_id", scope.businessId).in("run_id", runIds)
        .order("step_index", { ascending: true }) : Promise.resolve({ data: [], error: null }),
      proposalIds.length ? client.from("supervisor_effect_attempts")
        .select("proposal_id,effect_hash,state,receipt_ref,verified_at")
        .eq("business_id", scope.businessId).in("proposal_id", proposalIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (steps.error || attempts.error) throw new Error("owner_work_evidence_unavailable");
    return conversationJson({ work: projectOwnerWork({
      runs: (runs.data ?? []) as RunRow[],
      steps: (steps.data ?? []) as StepRow[],
      jobs: (jobs.data ?? []) as JobRow[],
      proposals: (proposals.data ?? []) as ProposalRow[],
      attempts: (attempts.data ?? []) as AttemptRow[],
    }) });
  } catch (error) {
    return conversationError(error);
  }
}
