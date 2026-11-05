import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resumeSupervisorRun } from "./resume";
import type {
  DurableRun, DurableRunRepository, RunScope, StepClaim, StepSpec,
} from "./contracts";

const scope: RunScope = {
  businessId: randomUUID(), ownerUserId: randomUUID(), threadId: randomUUID(),
};
type Step = StepSpec & {
  state: "pending" | "leased" | "blocked" | "completed";
  claimToken?: string; result?: string; expired?: boolean;
};
class MemoryLedger implements DurableRunRepository {
  run: DurableRun | null = null;
  plan: readonly StepSpec[] = [];
  steps: Step[] = [];
  reportRows = 0;
  effects: string[] = [];
  async start(s: RunScope, requestKey: string, steps: readonly StepSpec[]) {
    if (s.businessId !== scope.businessId || s.ownerUserId !== scope.ownerUserId ||
      s.threadId !== scope.threadId) throw new Error("scope");
    if (this.run) {
      if (this.run.requestKey !== requestKey || JSON.stringify(this.plan) !== JSON.stringify(steps))
        throw new Error("run_request_conflict");
      return this.run;
    }
    this.plan = steps;
    this.steps = steps.map(step => ({ ...step, state: "pending" }));
    this.run = { id: randomUUID(), businessId: s.businessId, ownerUserId: s.ownerUserId,
      threadId: s.threadId, requestKey, status: "pending", finalReportRef: null };
    return this.run;
  }
  async claim(_s: RunScope, runId: string, _worker: string, _lease: number): Promise<StepClaim> {
    if (this.run?.id !== runId) throw new Error("run_not_found");
    if (this.run.status === "completed") return { kind: "completed" };
    if (this.run.status === "blocked") return { kind: "blocked" };
    const step = this.steps.find(s => s.state !== "completed");
    if (!step) return { kind: "ready_for_report" };
    if (step.state === "leased" && !step.expired) return { kind: "busy" };
    if (step.state === "leased" && step.retry === "reconcile") {
      step.state = "blocked";
      this.run.status = "blocked";
      return { kind: "blocked" };
    }
    const token = randomUUID();
    step.state = "leased"; step.claimToken = token; step.expired = false;
    this.run.status = "running";
    return { kind: "claimed", key: step.key, retry: step.retry,
      claimToken: token, leaseUntil: new Date(Date.now() + 1000).toISOString(),
      attempt: 1, idempotencyKey: runId + ":" + step.key };
  }
  async renew(_s: RunScope, _run: string, key: string, token: string) {
    const s = this.steps.find(s => s.key === key);
    return Boolean(s?.state === "leased" && s.claimToken === token && !s.expired);
  }
  async complete(_s: RunScope, _run: string, key: string, token: string, resultRef: string) {
    const s = this.steps.find(s => s.key === key);
    if (!s || s.claimToken !== token || s.expired || s.state !== "leased")
      throw new Error("step_claim_conflict");
    s.state = "completed"; s.result = resultRef;
  }
  async reconcile(_s: RunScope, _run: string, key: string, resultRef: string) {
    const s = this.steps.find(s => s.key === key);
    if (!s || s.state !== "blocked" || s.retry !== "reconcile" || !this.run)
      throw new Error("step_not_reconcilable");
    s.state = "completed"; s.result = resultRef; this.run.status = "running";
  }
  async finish(_s: RunScope, runId: string, reportRef: string) {
    if (!this.run || this.run.id !== runId) throw new Error("run_not_found");
    if (this.run.status === "completed") {
      if (this.run.finalReportRef !== reportRef) throw new Error("report_conflict");
      return this.run;
    }
    if (this.steps.some(s => s.state !== "completed")) throw new Error("run_not_finished");
    this.run = { ...this.run, status: "completed", finalReportRef: reportRef };
    this.reportRows++;
    return this.run;
  }
  expire(key: string) {
    const s = this.steps.find(s => s.key === key);
    if (!s || s.state !== "leased") throw new Error("not leased");
    s.expired = true;
  }
}
const specs: readonly StepSpec[] = [
  { key: "read_facts", retry: "idempotent" },
  { key: "create_approved_action", retry: "idempotent" },
  { key: "verify_outcome", retry: "idempotent" },
];

describe("Supervisor durable multi-step runs", () => {
  it("survives a crash after step two without repeating either finished action", async () => {
    const db = new MemoryLedger(), requestKey = randomUUID();
    const run = await db.start(scope, requestKey, specs);
    const first = await db.claim(scope, run.id, randomUUID(), 60);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("missing first claim");
    await db.complete(scope, run.id, first.key, first.claimToken, "existing:read");
    const second = await db.claim(scope, run.id, randomUUID(), 60);
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") throw new Error("missing second claim");
    await db.complete(scope, run.id, second.key, second.claimToken, "existing:action");
    // Process disappears; the new worker knows only the durable run ID.
    const afterRestart = await db.start(scope, requestKey, specs);
    expect(afterRestart.id).toBe(run.id);
    const invoked: string[] = [];
    const status = await resumeSupervisorRun(db, scope, run.id, randomUUID(), 60,
      "existing:final", async step => { invoked.push(step.key); return "existing:" + step.key; });
    expect(status).toBe("completed");
    expect(invoked).toEqual(["verify_outcome"]);
    expect(db.steps.map(s => s.result)).toEqual([
      "existing:read", "existing:action", "existing:verify_outcome",
    ]);
  });

  it("lets only one worker claim the first unfinished step at a time", async () => {
    const db = new MemoryLedger(), run = await db.start(scope, randomUUID(), specs);
    const [a, b] = await Promise.all([
      db.claim(scope, run.id, randomUUID(), 60),
      db.claim(scope, run.id, randomUUID(), 60),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["busy", "claimed"]);
    expect(db.steps[0].state).toBe("leased");
    expect(db.steps[1].state).toBe("pending");
  });

  it("fences an expired worker, but keeps the idempotency key stable", async () => {
    const db = new MemoryLedger(), run = await db.start(scope, randomUUID(), specs);
    const first = await db.claim(scope, run.id, randomUUID(), 60);
    if (first.kind !== "claimed") throw new Error("missing claim");
    db.expire(first.key);
    const next = await db.claim(scope, run.id, randomUUID(), 60);
    if (next.kind !== "claimed") throw new Error("missing reclaim");
    expect(next.claimToken).not.toBe(first.claimToken);
    expect(next.idempotencyKey).toBe(first.idempotencyKey);
    await expect(db.complete(scope, run.id, first.key, first.claimToken, "old"))
      .rejects.toThrow("step_claim_conflict");
    await db.complete(scope, run.id, next.key, next.claimToken, "verified:receipt");
    expect(db.steps[0].result).toBe("verified:receipt");
  });

  it("blocks uncertain effects after lease expiry until evidence is reconciled", async () => {
    const db = new MemoryLedger();
    const run = await db.start(scope, randomUUID(), [{ key: "effect", retry: "reconcile" }]);
    const first = await db.claim(scope, run.id, randomUUID(), 60);
    if (first.kind !== "claimed") throw new Error("missing claim");
    db.expire(first.key);
    expect((await db.claim(scope, run.id, randomUUID(), 60)).kind).toBe("blocked");
    expect((await db.claim(scope, run.id, randomUUID(), 60)).kind).toBe("blocked");
    await db.reconcile(scope, run.id, "effect", "verified:existing_action");
    expect(await resumeSupervisorRun(db, scope, run.id, randomUUID(), 60,
      "existing:final", async () => { throw new Error("must not repeat action"); }))
      .toBe("completed");
  });

  it("persists exactly one final report, including after retries", async () => {
    const db = new MemoryLedger(), run = await db.start(scope, randomUUID(), specs);
    const invoked: string[] = [];
    const execute = async (step: Extract<StepClaim, {kind: "claimed"}>) => {
      invoked.push(step.key); return "existing:" + step.key;
    };
    expect(await resumeSupervisorRun(db, scope, run.id, randomUUID(), 60,
      "existing:final", execute)).toBe("completed");
    expect(await resumeSupervisorRun(db, scope, run.id, randomUUID(), 60,
      "existing:final", execute)).toBe("completed");
    expect(db.reportRows).toBe(1);
    expect(invoked).toEqual(specs.map(s => s.key));
    expect(db.run?.finalReportRef).toBe("existing:final");
    await expect(db.finish(scope, run.id, "different:report")).rejects.toThrow("report_conflict");
  });
});
