import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeDurableRun, reconcileVerifiedOwnerStep, type WorkerDependencies, type WorkerRun } from "./worker.server";
import type { DurableRun, DurableRunRepository, RunScope, StepClaim, StepSpec } from "./contracts";
import type { WorkerBudget, WorkerUsage } from "./usage.server";
import { supervisorReplyIdFor } from "@/lib/ai/conversations/replyValidation";
import { runAgentTurn, type AgentProvider } from "@/lib/ai/agent/loop.server";
import { withWorkerBudget } from "./usage.server";
import type { AgentToolContext } from "@/lib/ai/agent/tools";

const scope: RunScope = { businessId: randomUUID(), ownerUserId: randomUUID(), threadId: randomUUID() };
const run: WorkerRun = { id: randomUUID(), scope, requestKey: randomUUID() };
const reportRef = supervisorReplyIdFor(run.requestKey);
const usage: WorkerUsage = { elapsedMs: 10, modelCalls: 1, toolCalls: 0, inputTokens: 50, outputTokens: 5 };
const budget: WorkerBudget = {
  maxElapsedMs: 60000, maxModelCalls: 6, maxToolCalls: 8,
  maxInputTokens: 60000, maxOutputTokens: 7200,
};
const keys = ["authorize_owner", "owner_turn", "verify_report"] as const;
type Row = { key: string; state: "pending" | "leased" | "completed" | "blocked";
  retry: "idempotent" | "reconcile"; token?: string; ref?: string; expired?: boolean };
class Ledger implements DurableRunRepository {
  rows: Row[] = keys.map((key, i) => ({ key, state: "pending", retry: i === 1 ? "reconcile" : "idempotent" }));
  status: DurableRun["status"] = "pending";
  finalRef: string | null = null;
  errors: string[] = [];
  async start(_scope: RunScope, _requestKey: string, _steps: readonly StepSpec[]): Promise<DurableRun> {
    return { id: run.id, ...scope, requestKey: run.requestKey, status: this.status, finalReportRef: this.finalRef };
  }
  async claim(_scope: RunScope, _runId: string, _workerId: string, _seconds: number): Promise<StepClaim> {
    if (this.status === "blocked") return { kind: "blocked" };
    if (this.status === "completed") return { kind: "completed" };
    const row = this.rows.find(r => r.state !== "completed");
    if (!row) return { kind: "ready_for_report" };
    if (row.state === "blocked") return { kind: "blocked" };
    if (row.state === "leased" && !row.expired) return { kind: "busy" };
    if (row.state === "leased" && row.expired && row.retry === "reconcile") {
      row.state = "blocked"; this.status = "blocked"; return { kind: "blocked" };
    }
    row.state = "leased"; row.token = randomUUID(); row.expired = false; this.status = "running";
    return { kind: "claimed", key: row.key, retry: row.retry, claimToken: row.token,
      leaseUntil: new Date().toISOString(), attempt: 1, idempotencyKey: run.id + ":" + row.key };
  }
  async renew(_scope: RunScope, _runId: string, key: string, token: string) {
    const row = this.rows.find(r => r.key === key);
    return Boolean(row?.state === "leased" && row.token === token && !row.expired && this.status === "running");
  }
  async complete(_scope: RunScope, _runId: string, key: string, token: string, ref: string) {
    const row = this.rows.find(r => r.key === key);
    if (this.status !== "running" || row?.state !== "leased" || row.token !== token || row.expired)
      throw new Error("step_claim_conflict");
    row.state = "completed"; row.ref = ref;
  }
  async reconcile(_scope: RunScope, _runId: string, key: string, ref: string) {
    const row = this.rows.find(r => r.key === key);
    if (this.status !== "blocked" || row?.state !== "blocked" || row.retry !== "reconcile")
      throw new Error("step_not_reconcilable");
    row.state = "completed"; row.ref = ref; this.status = "running";
  }
  async finish(_scope: RunScope, _runId: string, ref: string): Promise<DurableRun> {
    if (this.rows.some(r => r.state !== "completed") || this.status === "blocked")
      throw new Error("not_finished");
    if (this.finalRef && this.finalRef !== ref) throw new Error("report_conflict");
    this.finalRef = ref; this.status = "completed";
    return { id: run.id, ...scope, requestKey: run.requestKey, status: this.status, finalReportRef: ref };
  }
  stop = async (reason: string, token?: string, key?: string) => {
    this.status = "blocked"; this.errors.push(reason);
    const row = this.rows.find(r => r.key === key && r.token === token);
    if (row) { row.state = "blocked"; row.token = undefined; }
  };
}
function setup(db: Ledger, extra: Partial<WorkerDependencies> = {}) {
  let reply: WorkerDependencies extends never ? never : { ref: string; endReason: string; usage: WorkerUsage } | null = null;
  const calls = { execute: 0, authorize: 0 };
  const deps: WorkerDependencies = {
    repository: db,
    authorize: async () => { calls.authorize++; },
    verified: async () => reply,
    cancelled: async () => db.status === "blocked",
    stop: db.stop,
    executeTurn: async () => { calls.execute++; reply = { ref: reportRef, endReason: "complete", usage }; },
    ...extra,
  };
  return { deps, calls, setReply: (next: typeof reply) => { reply = next; } };
}
describe("durable owner worker (uses Task 5 fenced repository)", () => {
  it("isolates worker token limits inside the existing registered agent loop", async () => {
    const provider: AgentProvider = async function* () {
      yield { type: "response.output_text.delta", delta: "Verified plain reply" };
      yield { type: "response.completed", response: { usage: {
        input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 0 },
      } } };
    };
    const context = { timezone: "America/Los_Angeles", asOf: "2026-11-10",
      locale: "en", tools: {} } as AgentToolContext;
    const normal = await runAgentTurn({ ownerText: "Hello", context, provider });
    const capped = await withWorkerBudget({ ...budget, maxInputTokens: 20 },
      () => runAgentTurn({ ownerText: "Hello", context, provider }));
    expect(normal.endReason).toBe("complete");
    expect(capped.endReason).toBe("budget");
    expect(capped.usage.inputTokens).toBe(30);
  });
  it("only one worker executes a leased owner-turn step, never a second effect", async () => {
    const db = new Ledger(), first = setup(db);
    let unblock!: () => void;
    let began!: () => void;
    const entered = new Promise<void>(r => { began = r; });
    const hold = new Promise<void>(r => { unblock = r; });
    first.deps.executeTurn = async () => {
      first.calls.execute++; began(); await hold;
      first.setReply({ ref: reportRef, endReason: "complete", usage });
    };
    const running = executeDurableRun(run, budget, first.deps);
    await entered;
    const second = setup(db);
    expect(await executeDurableRun(run, budget, second.deps)).toBe("busy");
    expect(second.calls.execute).toBe(0);
    unblock();
    expect(await running).toBe("completed");
    expect(db.status).toBe("completed");
    expect(db.rows.map(r => r.state)).toEqual(["completed", "completed", "completed"]);
    expect(db.finalRef).toBe(reportRef);
  });
  it("restart skips completed steps and uses verified canonical receipt", async () => {
    const db = new Ledger();
    db.rows[0] = { ...db.rows[0], state: "completed", ref: "owner:" + run.requestKey };
    db.rows[1] = { ...db.rows[1], state: "completed", ref: reportRef };
    db.status = "running";
    const env = setup(db);
    env.setReply({ ref: reportRef, endReason: "complete", usage });
    expect(await executeDurableRun(run, budget, env.deps)).toBe("completed");
    expect(env.calls.execute).toBe(0);
    expect(db.finalRef).toBe(reportRef);
  });
  it("expired uncertain external effect stays blocked without blind replay", async () => {
    const db = new Ledger();
    db.rows[0] = { ...db.rows[0], state: "completed" };
    db.rows[1] = { ...db.rows[1], state: "leased", token: randomUUID(), expired: true };
    db.status = "running";
    const env = setup(db);
    expect(await executeDurableRun(run, budget, env.deps)).toBe("blocked");
    expect(env.calls.execute).toBe(0);
    expect(db.status).toBe("blocked");
  });
  it("lease-expiry receipt reconciliation resumes without replay; cancellation cannot reconcile", async () => {
    const db = new Ledger();
    db.rows[0] = { ...db.rows[0], state: "completed" };
    db.rows[1] = { ...db.rows[1], state: "leased", token: randomUUID(), expired: true };
    db.status = "running";
    expect((await db.claim(scope, run.id, randomUUID(), 90)).kind).toBe("blocked");
    const env = setup(db);
    env.setReply({ ref: reportRef, endReason: "complete", usage });
    expect(await reconcileVerifiedOwnerStep(run, db, "cancelled",
      env.deps.authorize, env.deps.verified)).toBe(false);
    expect(db.status).toBe("blocked");
    expect(await reconcileVerifiedOwnerStep(run, db, "lease_expired",
      env.deps.authorize, env.deps.verified)).toBe(true);
    expect(db.rows[1].state).toBe("completed");
    expect(await executeDurableRun(run, budget, env.deps)).toBe("completed");
    expect(env.calls.execute).toBe(0);
  });
  it("timeout, budget, and cancellation remain blocked rather than falsely finished", async () => {
    for (const reason of ["timeout", "budget", "cancel"] as const) {
      const db = new Ledger();
      let tick = 0;
      const env = setup(db, {
        ...(reason === "timeout" ? { clock: () => ++tick } : {}),
        ...(reason === "cancel" ? { cancelled: async () => true } : {}),
      });
      const cap = reason === "budget" ? { ...budget, maxModelCalls: 0 } :
        reason === "timeout" ? { ...budget, maxElapsedMs: 1 } : budget;
      await expect(executeDurableRun(run, cap, env.deps)).rejects.toThrow("supervisor_worker_");
      expect(db.status).toBe("blocked");
      expect(db.finalRef).toBeNull();
      expect(env.calls.execute).toBe(0);
      expect(db.errors).toHaveLength(1);
    }
  });
  it("revocation during a running owner turn blocks acknowledgement and report", async () => {
    const db = new Ledger(), env = setup(db);
    let ownerAuthorized = true;
    env.deps.authorize = async () => {
      if (!ownerAuthorized) throw new Error("owner_revoked");
    };
    env.deps.executeTurn = async () => {
      env.calls.execute++;
      env.setReply({ ref: reportRef, endReason: "complete", usage });
      ownerAuthorized = false;
    };
    await expect(executeDurableRun(run, budget, env.deps))
      .rejects.toThrow("supervisor_worker_authorization_revoked");
    expect(db.status).toBe("blocked");
    expect(db.rows[1].state).toBe("blocked");
    expect(db.finalRef).toBeNull();
  });
  it("incomplete model response is blocked; its text is not proof of success", async () => {
    const db = new Ledger(), env = setup(db);
    env.deps.executeTurn = async () => {
      env.calls.execute++;
      env.setReply({ ref: reportRef, endReason: "budget", usage });
    };
    await expect(executeDurableRun(run, budget, env.deps)).rejects.toThrow("supervisor_worker_turn_incomplete");
    expect(db.status).toBe("blocked");
    expect(db.finalRef).toBeNull();
    expect(db.rows[1].state).toBe("blocked");
  });
  it("rejects a non-canonical report reference even when a model says complete", async () => {
    const db = new Ledger(), env = setup(db);
    env.setReply({ ref: randomUUID(), endReason: "complete", usage });
    await expect(executeDurableRun(run, budget, env.deps)).rejects.toThrow("supervisor_worker_turn_incomplete");
    expect(db.finalRef).toBeNull();
  });
});
