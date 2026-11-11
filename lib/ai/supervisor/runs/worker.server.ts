import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getExistingSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { authorizedExternalConversation } from "@/lib/ai/conversations/authorizedTurn.server";
import { readOwnerMessage } from "@/lib/ai/agent/jobs.server";
import { runOneTurn, errorCode as agentTurnErrorCode } from "@/lib/ai/conversations/agentRunner.server";
import { assertCafeAiAccess } from "@/lib/access/access.server";
import { assertOwnerAgentTurnAvailable } from "@/lib/ai/conversations/usage.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentJob } from "@/lib/ai/agent/jobState";
import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import { resumeSupervisorRun } from "./resume";
import { SupabaseDurableRunRepository } from "./repository.server";
import { runScopeSchema, type DurableRun, type DurableRunRepository, type RunScope } from "./contracts";
import { withWorkerBudget, usageStopReason, currentWorkerUsage, workerBudgetExhausted,
  type WorkerBudget, type WorkerUsage } from "./usage.server"; const uuid = z.uuid(); const plan = [
  { key: "authorize_owner", retry: "idempotent" as const },
  // An uncertain effect can never be blindly repeated.
  { key: "owner_turn", retry: "reconcile" as const }, { key: "verify_report", retry: "idempotent" as const },
]; const rowSchema = z.object({ id: z.uuid(), business_id: z.uuid(), owner_user_id: z.uuid(),
  thread_id: z.uuid(), request_key: z.uuid(), status: z.enum(["pending", "running", "blocked", "completed"]),
});
export type WorkerRun = { id: string; scope: RunScope; requestKey: string };
export type VerifiedReply = { ref: string; endReason: string; usage: WorkerUsage };
export type WorkerOutcome = "completed" | "busy" | "blocked";
/** Only an authenticated, already saved owner message may become a durable
 * run. Its UUID is the request key; the plan and scope are not caller data. */
export async function startDurableOwnerRun(ownerMessageId: string): Promise<DurableRun> {
  const id = uuid.parse(ownerMessageId);
  const { data, error } = await createAdminSupabaseClient().from("ai_messages")
    .select("id,business_id,owner_user_id,thread_id,role,content_type")
    .eq("id", id).single(); if (error || !data || data.role !== "owner" || data.content_type !== "text")
    throw new Error("worker_owner_message_unavailable"); const scope = runScopeSchema.parse({
    businessId: data.business_id, ownerUserId: data.owner_user_id, threadId: data.thread_id, });
  await authorizedExternalConversation(scope, scope.threadId);
  await readOwnerMessage(scope, scope.threadId, id);
  return new SupabaseDurableRunRepository().start(scope, id, plan); }
/** The canonical grounded reply is the only valid final outcome receipt.
 * Partial, failed or timeout responses are never treated as finished work. */
async function verifiedReply(run: WorkerRun): Promise<VerifiedReply | null> {
  const owner = await readOwnerMessage(run.scope, run.scope.threadId, run.requestKey);
  const reply = await getExistingSupervisorReply(run.scope, owner);
  const meta = reply?.grounding?.agentMetadata; if (!reply || reply.grounding?.status !== "verified" ||
    !meta || typeof meta !== "object") return null;
  const { endReason, usage } = meta as { endReason?: unknown; usage?: unknown };
  if (typeof endReason !== "string" || !usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  if (!["modelCalls","toolCalls","inputTokens","outputTokens","latencyMs"]
    .every(k => typeof u[k] === "number" && Number.isSafeInteger(u[k]) && (u[k] as number) >= 0)) return null;
  return { ref: reply.id, endReason, usage: {
    elapsedMs: u.latencyMs as number, modelCalls: u.modelCalls as number,
    toolCalls: u.toolCalls as number, inputTokens: u.inputTokens as number,
    outputTokens: u.outputTokens as number, } }; }
/** Compare-and-set stop. The existing complete_step RPC locks the run first
 * and rejects blocked runs; late workers cannot report an uncertain effect
 * completed. An independently verified effect receipt is needed to unblock. */
async function blockRun(run: WorkerRun, reason: string, token?: string, stepKey?: string) {
  const db = createAdminSupabaseClient(); const { data, error } = await db.from("supervisor_runs")
    .update({ status: "blocked", updated_at: new Date().toISOString() })
    .eq("id", run.id).eq("business_id", run.scope.businessId)
    .eq("owner_user_id", run.scope.ownerUserId).eq("thread_id", run.scope.threadId)
    .in("status", ["pending", "running"]).select("id").maybeSingle();
  if (error) throw new Error("worker_stop_not_persisted", { cause: error }); if (!data) {
    const check = await db.from("supervisor_runs").select("status")
      .eq("id", run.id).eq("business_id", run.scope.businessId)
      .eq("owner_user_id", run.scope.ownerUserId).eq("thread_id", run.scope.threadId).maybeSingle();
    if (check.error || check.data?.status !== "blocked") throw new Error("worker_stop_conflict"); }
  // Persist a reason even when cancellation/budget denial precedes a claim.
  // The run is already blocked; no later claim or completion may succeed.
  const first = token && stepKey ? { step_key: stepKey } :
    (await db.from("supervisor_run_steps").select("step_key").eq("business_id", run.scope.businessId)
      .eq("run_id", run.id).neq("status", "completed")
      .order("step_index", { ascending: true }).limit(1)).data?.[0]; if (first) {
    let step = db.from("supervisor_run_steps").update({
      status: "blocked", error_code: reason, worker_id: null, claim_token: null,
      lease_until: null, updated_at: new Date().toISOString(),
    }).eq("business_id", run.scope.businessId).eq("run_id", run.id)
      .eq("step_key", first.step_key); step = token ? step.eq("claim_token", token).eq("status", "leased") :
      step.eq("status", "pending"); const { error: stepError } = await step;
    if (stepError) throw new Error("worker_stop_step_unavailable", { cause: stepError }); }
}
export type WorkerDependencies = { repository: DurableRunRepository; authorize: () => Promise<void>;
  verified: () => Promise<VerifiedReply | null>; executeTurn: () => Promise<void>;
  cancelled: () => Promise<boolean>; stop: (reason: string, token?: string, key?: string) => Promise<void>;
  clock?: () => number; };
/** Uses PR5's fenced resume runner, not a second lease implementation.
 * Each completed step stores a short canonical reference, never model text. */
export async function executeDurableRun(
  run: WorkerRun, budget: WorkerBudget, deps: WorkerDependencies, ): Promise<WorkerOutcome> {
  runScopeSchema.parse(run.scope); uuid.parse(run.id); uuid.parse(run.requestKey);
  const now = deps.clock ?? Date.now, started = now();
  const stop = async (reason: string, token?: string, key?: string): Promise<never> => {
    await deps.stop(reason, token, key); throw new Error("supervisor_worker_" + reason); };
  const check = async (token?: string, key?: string) => { try { await deps.authorize(); }
    catch { await stop("authorization_revoked", token, key); }
    if (await deps.cancelled()) await stop("cancelled", token, key);
    const u = (await deps.verified())?.usage ?? {
      elapsedMs: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, };
    const exceeded = usageStopReason({ ...u, elapsedMs: Math.max(u.elapsedMs, now() - started) }, budget);
    if (exceeded) await stop(exceeded === "timeout" ? "time_exceeded" : "budget_exceeded", token, key); };
  await check(); const { supervisorReplyIdFor } = await import("@/lib/ai/conversations/replyValidation");
  const finalRef = supervisorReplyIdFor(run.requestKey);
  return resumeSupervisorRun(deps.repository, run.scope, run.id, randomUUID(), 90,
    finalRef, async (claim, renew) => { if (!(await renew())) throw new Error("supervisor_worker_lease_lost");
      await check(claim.claimToken, claim.key);
      if (claim.key === "authorize_owner") return "owner:" + run.requestKey; if (claim.key === "owner_turn") {
        let receipt = await deps.verified(); if (!receipt) { try {
            // The lease/authorization steps already spent part of this run's
            // deadline. All continuation turns share what is left.
            const remaining = { ...budget,
              maxElapsedMs: Math.max(0, budget.maxElapsedMs - Math.max(0, now() - started)) };
            await withWorkerBudget(remaining, async () => { await deps.executeTurn();
              const spent = currentWorkerUsage(); if (spent) {
                const aggregate = { ...spent, elapsedMs: Math.max(spent.elapsedMs, now() - started) };
                const exceeded = usageStopReason(aggregate, budget);
                if (exceeded) throw new Error("supervisor_worker_chain_" + exceeded); }
            }); } catch (error) { await deps.stop("turn_failed", claim.claimToken, claim.key); throw error; }
          receipt = await deps.verified(); }
        if (!receipt || receipt.endReason !== "complete" || receipt.ref !== finalRef)
          return stop("turn_incomplete", claim.claimToken, claim.key);
        const reason = usageStopReason(receipt.usage, budget);
        if (reason) await stop(reason === "timeout" ? "time_exceeded" : "budget_exceeded", claim.claimToken, claim.key);
        // Owner access/cancellation may change while the model or tool runs.
        // Recheck before acknowledging the outcome in durable storage.
        await check(claim.claimToken, claim.key);
        if (!(await renew())) throw new Error("supervisor_worker_lease_lost"); return receipt.ref; }
      if (claim.key === "verify_report") { const receipt = await deps.verified();
        if (!receipt || receipt.ref !== finalRef || receipt.endReason !== "complete")
          return stop("report_unverified", claim.claimToken, claim.key); return receipt.ref; }
      return stop("unknown_step", claim.claimToken, claim.key); }); }
/** A crashed worker is never replayed for an uncertain effect.
 * Reconcile ONLY a PR5 lease-expiry with a verified scoped canonical receipt.
 * Owner cancellation and other blocked statuses never become runnable here. */
export async function reconcileVerifiedOwnerStep(
  run: WorkerRun, repository: DurableRunRepository, reason: string | null,
  authorize: () => Promise<void>, verified: () => Promise<VerifiedReply | null>, ): Promise<boolean> {
  if (reason !== "lease_expired") return false; try { await authorize(); }
  catch { return false; } // revoked or unverifiable owners never resume an effect
  const receipt = await verified();
  const { supervisorReplyIdFor } = await import("@/lib/ai/conversations/replyValidation");
  if (!receipt || receipt.endReason !== "complete" ||
    receipt.ref !== supervisorReplyIdFor(run.requestKey)) return false;
  await repository.reconcile(run.scope, run.id, "owner_turn", receipt.ref); return true; }
function configuredBudget(): WorkerBudget { const limit = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("invalid_worker_budget_setting"); return Number(value); }; return {
    maxElapsedMs: limit(process.env.SUPERVISOR_WORKER_MAX_ELAPSED_MS, 60000),
    maxModelCalls: limit(process.env.SUPERVISOR_WORKER_MAX_MODEL_CALLS, 6),
    maxToolCalls: limit(process.env.SUPERVISOR_WORKER_MAX_TOOL_CALLS, 8),
    maxInputTokens: limit(process.env.SUPERVISOR_WORKER_MAX_INPUT_TOKENS, 60000),
    maxOutputTokens: limit(process.env.SUPERVISOR_WORKER_MAX_OUTPUT_TOKENS, 7200), }; }
/** Match the browser/WhatsApp paid-turn gates with an explicit scoped
 * service-role client. A delayed durable turn must not bypass current café
 * entitlement or the owner's UTC daily model-call quota. */
export async function assertDurablePaidTurnAllowed(
  scope: RunScope, client: SupabaseClient, checks: { access: (businessId: string) => Promise<void>;
    quota: (scope: RunScope, client: SupabaseClient) => Promise<void>;
  } = { access: assertCafeAiAccess, quota: assertOwnerAgentTurnAvailable }, ): Promise<void> {
  await checks.access(scope.businessId); await checks.quota(scope, client); }
const CONTINUATION_BUDGET_MS = 75_000; // reuse the existing bounded chat continuation window
const MAX_CHAIN_TURNS = 3; // hard bound even if a test clock never advances
type AgentJobServices = Pick<typeof import("@/lib/ai/agent/jobs.server"),
  "finishAgentJob" | "readOwnerMessage">; type TurnOutcome = Awaited<ReturnType<typeof runOneTurn>>;
/** ai_agent_job_finish creates a running follow-up job atomically. The caller
 * MUST consume or explicitly fail it. Continue through the existing one-agent
 * turn runner, never a second model/effect pipeline.
 *
 * A failed continuation is marked failed, but does not erase the initiating
 * owner's already verified canonical report. */
export async function runDurableJobChain(input: { scope: RunScope; owner: ConversationMessage;
  initialJob: AgentJob; jobs: AgentJobServices; assertPaidAllowed: () => Promise<void>;
  runTurn: (owner: ConversationMessage, job: AgentJob) => Promise<TurnOutcome>; now?: () => number;
}): Promise<void> { const now = input.now ?? Date.now, since = now();
  let owner = input.owner, job: AgentJob | null = input.initialJob; for (let turns = 0; job; turns++) {
    const first = turns === 0;
    // A running continuation created by finishAgentJob must be explicitly
    // failed if this entire worker has no paid-call budget left.
    const spent = workerBudgetExhausted(); if (spent) {
      await input.jobs.finishAgentJob(job.id, { status: "failed", errorCode: spent });
      if (first) throw new Error("supervisor_worker_" + spent); return; }
    // The provider/owner message cannot select a different café or thread.
    if (job.threadId !== input.scope.threadId || job.ownerMessageId !== owner.id) {
      await input.jobs.finishAgentJob(job.id, { status: "failed", errorCode: "owner_scope_mismatch" });
      if (first) throw new Error("supervisor_owner_job_scope_mismatch"); return; }
    let result: TurnOutcome; try {
      await input.assertPaidAllowed(); // again, immediately before every paid call
      result = await input.runTurn(owner, job); } catch (error) { await input.jobs.finishAgentJob(job.id, {
        status: "failed", errorCode: agentTurnErrorCode(error), }); if (first) throw error;
      return; // continuation failure cannot revoke the original persisted reply
    }
    const next: AgentJob | null = (await input.jobs.finishAgentJob(job.id, "replyId" in result
        ? { status: "done", replyMessageId: result.replyId,
          absorbedOwnerMessageIds: result.absorbedOwnerMessageIds }
        : { status: "failed", errorCode: result.errorCode })).continuation; if ("errorCode" in result) {
      if (first) throw new Error("supervisor_agent_turn_failed"); return; }
    if (!next) return; const exhausted = workerBudgetExhausted();
    if (turns + 1 >= MAX_CHAIN_TURNS || now() - since >= CONTINUATION_BUDGET_MS || exhausted) {
      // An atomically started continuation is never left running after caps expire.
      await input.jobs.finishAgentJob(next.id, { status: "failed", errorCode: exhausted ?? "timeout" });
      return; }
    try { owner = await input.jobs.readOwnerMessage(input.scope, input.scope.threadId, next.ownerMessageId);
    } catch (error) { await input.jobs.finishAgentJob(next.id, {
        status: "failed", errorCode: agentTurnErrorCode(error), }); return; }
    job = next; }
}
/** Reads identities from durable storage. Only the fixed approved three-step
 * plan may drive the existing chat loop; arbitrary plans fail closed. */
export async function processDurableRun(runId: string): Promise<WorkerOutcome> {
  const id = uuid.parse(runId), db = createAdminSupabaseClient();
  const { data, error } = await db.from("supervisor_runs")
    .select("id,business_id,owner_user_id,thread_id,request_key,status")
    .eq("id", id).single(); if (error || !data) throw new Error("supervisor_run_unavailable");
  const row = rowSchema.parse(data); if (row.status === "completed") return "completed";
  const run: WorkerRun = { id: row.id,
    scope: { businessId: row.business_id, ownerUserId: row.owner_user_id, threadId: row.thread_id },
    requestKey: row.request_key };
  const stored = await db.from("supervisor_run_steps").select("step_key,retry_mode,step_index,status,error_code")
    .eq("business_id", run.scope.businessId).eq("run_id", run.id)
    .order("step_index", { ascending: true });
  if (stored.error || JSON.stringify((stored.data ?? []).map(s => ({ key: s.step_key, retry: s.retry_mode }))) !== JSON.stringify(plan))
    throw new Error("supervisor_worker_plan_unrecognized"); const authorize = async () => {
    await authorizedExternalConversation(run.scope, run.scope.threadId);
    await readOwnerMessage(run.scope, run.scope.threadId, run.requestKey); };
  const repository = new SupabaseDurableRunRepository(); if (row.status === "blocked") {
    // Only an expired uncertain claim with an independently verified canonical
    // reply may be reconciled. Cancellation/revocation/failed responses stay blocked.
    const blocked = (stored.data ?? []).filter(step => step.status === "blocked");
    if (blocked.length !== 1 || blocked[0].step_key !== "owner_turn" ||
      !(await reconcileVerifiedOwnerStep(run, repository, blocked[0].error_code,
        authorize, () => verifiedReply(run)))) return "blocked"; }
  return executeDurableRun(run, configuredBudget(), { repository, authorize,
    verified: () => verifiedReply(run), cancelled: async () => {
      const check = await db.from("supervisor_runs").select("status")
        .eq("id", run.id).eq("business_id", run.scope.businessId).maybeSingle();
      if (check.error || !check.data) throw new Error("supervisor_run_status_unavailable");
      return check.data.status === "blocked"; },
    stop: (reason, token, key) => blockRun(run, reason, token, key), executeTurn: async () => {
      const scope = run.scope, service = await authorizedExternalConversation(scope, scope.threadId);
      const owner = await readOwnerMessage(scope, scope.threadId, run.requestKey);
      const client = createAdminSupabaseClient(); const assertPaidAllowed = async () => {
        // Membership and the exact thread are revalidated independently of the
        // paid entitlement and quota, for every resumed/continuation turn.
        await authorizedExternalConversation(scope, scope.threadId);
        await assertDurablePaidTurnAllowed(scope, client); };
      // Check before even creating a running agent job. Recheck immediately
      // before each paid model call through the shared runner below.
      await assertPaidAllowed(); const jobs = await import("@/lib/ai/agent/jobs.server");
      const started = await jobs.startAgentJob(scope, scope.threadId, owner.id);
      if (started.mode === "done") return; // canonical reply verified independently
      if (started.mode !== "started") throw new Error("supervisor_existing_job_unfinished");
      await runDurableJobChain({ scope, owner, initialJob: started.job, jobs, assertPaidAllowed,
        runTurn: (nextOwner, job) => runOneTurn({ scope, threadId: scope.threadId, owner: nextOwner,
          ownerText: nextOwner.text ?? "", locale: "en", service,
          emit: () => {}, job, jobs, externalClient: client, }), }); }, }); }
export async function processOldestDurableRun(): Promise<{ processed: number; state: WorkerOutcome | null }> {
  const db = createAdminSupabaseClient();
  const { data, error } = await db.from("supervisor_runs").select("id")
    .in("status", ["pending", "running"]).order("updated_at", { ascending: true })
    .order("id", { ascending: true }).limit(1);
  if (error) throw new Error("supervisor_worker_queue_unavailable");
  let runId: string | undefined = data?.[0]?.id; let recovery = false; if (!runId) {
    // Sweep only the explicitly reconcilable lease-expiry queue when normal
    // work is idle. Never retry cancelled or budget-blocked owner turns.
    const pending = await db.from("supervisor_run_steps").select("run_id")
      .eq("status", "blocked").eq("step_key", "owner_turn")
      .eq("error_code", "lease_expired")
      .order("updated_at", { ascending: true }).limit(1);
    if (pending.error) throw new Error("supervisor_worker_recovery_unavailable");
    runId = pending.data?.[0]?.run_id; recovery = Boolean(runId); }
  if (!runId) return { processed: 0, state: null }; const state = await processDurableRun(runId);
  // Rotate held leases and uncertain receipts; neither may monopolize a café
  // queue. Only canonical SQL reconciliation can unblock expired effects.
  if (state === "busy" && !recovery) { const moved = await db.from("supervisor_runs")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", runId).in("status", ["pending", "running"]);
    if (moved.error) throw new Error("supervisor_worker_queue_rotate_failed"); }
  if (recovery && state === "blocked") { const moved = await db.from("supervisor_run_steps")
      .update({ updated_at: new Date().toISOString() }).eq("run_id", runId)
      .eq("step_key", "owner_turn").eq("status", "blocked")
      .eq("error_code", "lease_expired");
    if (moved.error) throw new Error("supervisor_worker_recovery_rotate_failed"); }
  return { processed: 1, state }; }
