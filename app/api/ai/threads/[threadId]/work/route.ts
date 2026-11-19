import {z} from "zod";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { threadIdInput } from "@/lib/ai/conversations/contracts";
import { conversationError, conversationJson, parseInput, requireSameOrigin, readBoundedJson } from "@/lib/ai/conversations/http.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  projectOwnerWork, type RunRow, type StepRow, type ProposalRow, type AttemptRow, type JobRow, type InvestigationRow,
} from "@/lib/ai/supervisor/runs/ownerWorkView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ threadId: string }> };

const PAGE_SIZE = 200;
type Page = { data: unknown[] | null; error: { message: string } | null };
/** Read every unresolved row before recent-history limits; never silently
 * displace an older approval/exception with newer completed activity. */
async function allPages(load: (start: number, end: number) => PromiseLike<Page>) {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await load(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("owner_work_read_failed");
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

/** Read only. The existing owner authorization and Postgres RLS own scope.
 * No worker, provider, approval or retry can be invoked from this endpoint. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { threadId } = await context.params;
    const id = parseInput(threadIdInput, threadId);
    const { scope, service } = await authenticatedConversationContext();
    await service.getThread(id);
    // The owner-wide view is anchored in an authenticated thread; caller cannot supply a café or owner.
    const ownerWide = new URL(request.url).searchParams.get("scope") === "owner";
    const db = await createServerSupabaseClient();
    const v2=process.env.SUPERVISOR_DURABLE_CHAT_ENABLED==="true";
    const runFields = "thread_id,id,request_key,status,final_report_ref,updated_at,finished_at"+(v2?",execution_version":"");
    const jobFields = "thread_id,id,owner_message_id,status,reply_message_id,error_code,attempt,heartbeat_at,created_at";
    const proposalFields = "thread_id,id,status,capability_id,effect_hash,updated_at";
    const investigationFields = "thread_id,episode_id,phase,failure_count,lease_token,lease_until,last_error,updated_at";
    const owner = (table: "supervisor_runs" | "ai_agent_jobs" | "supervisor_proposals" | "supervisor_investigations", fields: string) =>
      {
        const query = db.from(table).select(fields).eq("business_id", scope.businessId)
          .eq("owner_user_id", scope.ownerUserId);
        return ownerWide ? query : query.eq("thread_id", id);
      };

    // Historical *completed* items are bounded. Every unfinished record,
    // including completed-without-report and terminal-without-effect-receipt,
    // is inspected independently of that recent-history window.
    const [openRuns, historyRuns, openJobs, historyJobs,
      openProposals, historyProposals, openInvestigations, historyInvestigations] = await Promise.all([
      allPages((a,b) => owner("supervisor_runs", runFields)
        .or("status.neq.completed,final_report_ref.is.null").order("updated_at",{ascending:false}).range(a,b)),
      owner("supervisor_runs", runFields).eq("status","completed").not("final_report_ref","is",null)
        .order("updated_at",{ascending:false}).limit(2),
      allPages((a,b) => owner("ai_agent_jobs", jobFields)
        .or("status.neq.done,reply_message_id.is.null").order("created_at",{ascending:false}).range(a,b)),
      owner("ai_agent_jobs", jobFields).eq("status","done").not("reply_message_id","is",null)
        .order("created_at",{ascending:false}).limit(2),
      // A committed proposal WITHOUT its exact verified receipt is still
      // uncertain; inspect all non-cancelled proposals before categorizing.
      allPages((a,b) => owner("supervisor_proposals", proposalFields)
        .not("status","in","(rejected,expired)").order("updated_at",{ascending:false}).range(a,b)),
      owner("supervisor_proposals", proposalFields).in("status",["rejected","expired"])
        .order("updated_at",{ascending:false}).limit(2),
      allPages((a,b) => owner("supervisor_investigations", investigationFields)
        .neq("phase","resolved").order("updated_at",{ascending:false}).range(a,b)),
      owner("supervisor_investigations", investigationFields).eq("phase","resolved")
        .order("updated_at",{ascending:false}).limit(2),
    ]);
    const history = [historyRuns,historyJobs,historyProposals,historyInvestigations];
    if (history.some(x => x.error)) throw new Error("owner_work_read_failed");

    const runs = [...openRuns,...(historyRuns.data ?? [])] as RunRow[];
    const jobs = [...openJobs,...(historyJobs.data ?? [])] as JobRow[];
    const proposals = [...openProposals,...(historyProposals.data ?? [])] as ProposalRow[];
    const investigations = [...openInvestigations,...(historyInvestigations.data ?? [])] as InvestigationRow[];

    // Chunk authorized IDs to avoid overlong IN URLs on long-lived threads;
    // each nested ledger remains business-scoped and independently RLS-bound.
    const steps: StepRow[] = [], attempts: AttemptRow[] = [];
    for (let n=0; n<runs.length; n+=100) {
      const res = await db.from("supervisor_run_steps")
        .select(v2?"run_id,step_key,step_index,status,attempts,error_code,updated_at,retry_mode,lease_until,checkpoint_phase,next_retry_at":"run_id,step_key,step_index,status,attempts,error_code,updated_at,retry_mode,lease_until")
        .eq("business_id",scope.businessId).in("run_id",runs.slice(n,n+100).map(r=>r.id))
        .order("step_index",{ascending:true});
      if (res.error) throw new Error("owner_work_evidence_unavailable");
      steps.push(...(res.data ?? []) as StepRow[]);
    }
    for (let n=0; n<proposals.length; n+=100) {
      const res = await db.from("supervisor_effect_attempts")
        .select("proposal_id,effect_hash,state,receipt_ref,verified_at")
        .eq("business_id",scope.businessId).in("proposal_id",proposals.slice(n,n+100).map(p=>p.id));
      if (res.error) throw new Error("owner_work_evidence_unavailable");
      attempts.push(...(res.data ?? []) as AttemptRow[]);
    }
    const work = projectOwnerWork({ runs, steps, jobs, proposals, attempts, investigations });
    if (ownerWide) {
      const ids = [...new Set(work.flatMap(item => item.threadId ? [item.threadId] : []))];
      const titles = new Map<string, string | null>();
      for (let n=0; n<ids.length; n+=100) {
        const res = await db.from("ai_threads").select("id,title").eq("business_id",scope.businessId)
          .eq("owner_user_id",scope.ownerUserId).in("id",ids.slice(n,n+100));
        if (res.error) throw new Error("owner_work_context_unavailable");
        for (const thread of res.data ?? []) titles.set(thread.id,thread.title);
      }
      // An investigation may not have a conversation yet; keep it visible.
      // Never navigate to a thread the current owner cannot read.
      return conversationJson({ work: work.filter(item => !item.threadId || titles.has(item.threadId))
        .map(item => ({...item,threadTitle:item.threadId ? titles.get(item.threadId) ?? null : null})) });
    }
    return conversationJson({ work });
  } catch (error) {
    return conversationError(error);
  }
}

/** Explicit owner control on existing Work endpoint. Cancellation is not an
 * undo of any already authorized provider action or a separate approval. */
export async function POST(request:Request,context:RouteContext){
  try{
    requireSameOrigin(request);
    const {threadId}=await context.params;
    const id=parseInput(threadIdInput,threadId);
    const input=parseInput(z.strictObject({action:z.literal("cancel"),runId:z.uuid()}),await readBoundedJson(request));
    const {scope,service}=await authenticatedConversationContext();
    await service.getThread(id);
    const {cancelOwnerRun}=await import("@/lib/ai/supervisor/runs/repository.server");
    const state=await cancelOwnerRun({...scope,threadId:id},input.runId);
    if(state==="not_found")throw new ConversationApiError(404,"thread_not_found");
    return conversationJson({state,runId:input.runId});
  }catch(error){return conversationError(error);}
}
