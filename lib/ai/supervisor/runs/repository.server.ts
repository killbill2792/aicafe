import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  decodeClaim, decodeRun, runScopeSchema, stepSpecSchema,
  type DurableRunRepository, type RunScope, type StepClaim, type StepSpec,
  type DurableRun,
} from "./contracts";

const uuid = z.uuid();
const shortRef = z.string().min(1).max(256);
const lease = z.number().int().min(1).max(3600);

function parseIdentity(scope: RunScope, runId: string) {
  return { scope: runScopeSchema.parse(scope), runId: uuid.parse(runId) };
}
async function callRpc<T>(name: string, params: Record<string, unknown>, decode: (v: unknown) => T): Promise<T> {
  const { data, error } = await createAdminSupabaseClient().rpc(name, params);
  if (error) throw new Error("Supervisor durable run storage unavailable", { cause: error });
  return decode(data);
}

/** All state transitions are atomic, service-role-only SQL RPCs.
 * Never point this repository at ai_agent_jobs: that table owns chat turns. */
export class SupabaseDurableRunRepository implements DurableRunRepository {
  async start(scope: RunScope, requestKey: string, steps: readonly StepSpec[]): Promise<DurableRun> {
    const s = runScopeSchema.parse(scope);
    const key = uuid.parse(requestKey);
    const parsed = z.array(stepSpecSchema).min(1).max(32).parse(steps);
    if (new Set(parsed.map(step => step.key)).size !== parsed.length)
      throw new Error("Duplicate Supervisor run step");
    // The ordered step contract is immutable for any retried request key.
    const planHash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const result = await callRpc("supervisor_run_start", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_request_key: key,
      p_plan_hash: planHash, p_steps: parsed,
    }, decodeRun);
    if (result.businessId !== s.businessId || result.ownerUserId !== s.ownerUserId ||
      result.threadId !== s.threadId || result.requestKey !== key)
      throw new Error("Supervisor run outside owner scope");
    return result;
  }

  claim(scope: RunScope, runId: string, workerId: string, leaseSeconds: number): Promise<StepClaim> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_claim", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_worker_id: uuid.parse(workerId), p_lease_seconds: lease.parse(leaseSeconds),
    }, decodeClaim);
  }

  renew(scope: RunScope, runId: string, key: string, token: string, leaseSeconds: number): Promise<boolean> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_renew", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id, p_step_key: stepSpecSchema.shape.key.parse(key),
      p_claim_token: uuid.parse(token), p_lease_seconds: lease.parse(leaseSeconds),
    }, value => z.boolean().parse(value));
  }

  async complete(scope: RunScope, runId: string, key: string, token: string, resultRef: string): Promise<void> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    await callRpc("supervisor_run_complete_step", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_step_key: stepSpecSchema.shape.key.parse(key),
      p_claim_token: uuid.parse(token), p_result_ref: shortRef.parse(resultRef),
    }, value => z.object({ status: z.literal("completed") }).parse(value));
  }

  async reconcile(scope: RunScope, runId: string, key: string, verifiedResultRef: string): Promise<void> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    await callRpc("supervisor_run_reconcile", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id,
      p_step_key: stepSpecSchema.shape.key.parse(key),
      p_verified_result_ref: shortRef.parse(verifiedResultRef),
    }, value => z.object({ status: z.literal("completed") }).parse(value));
  }

  finish(scope: RunScope, runId: string, finalReportRef: string): Promise<DurableRun> {
    const { scope: s, runId: id } = parseIdentity(scope, runId);
    return callRpc("supervisor_run_finish", {
      p_business_id: s.businessId, p_owner_user_id: s.ownerUserId,
      p_thread_id: s.threadId, p_run_id: id, p_final_report_ref: shortRef.parse(finalReportRef),
    }, value => {
      const r = decodeRun(value);
      if (r.id !== id || r.businessId !== s.businessId ||
        r.ownerUserId !== s.ownerUserId || r.threadId !== s.threadId ||
        r.status !== "completed" || r.finalReportRef !== finalReportRef)
        throw new Error("Supervisor report outside owner scope");
      return r;
    });
  }
}
