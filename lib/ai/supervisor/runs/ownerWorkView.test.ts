import { describe, expect, it } from "vitest";
import { projectOwnerWork, type RunRow, type StepRow, type ProposalRow, type JobRow } from "./ownerWorkView";

const when = "2026-11-14T10:00:00.000Z";
const run: RunRow = {
  id: "r", request_key: "o", status: "pending", final_report_ref: null,
  updated_at: when, finished_at: null,
};
const step: StepRow = {
  run_id: "r", step_key: "owner_turn", step_index: 2, status: "pending",
  attempts: 0, error_code: null, updated_at: when, retry_mode: "reconcile", lease_until: null,
};
const proposal: ProposalRow = {
  id: "p", status: "draft", capability_id: "purchase", effect_hash: "hash", updated_at: when,
};
const job: JobRow = {
  id: "j", owner_message_id: "o", status: "running", reply_message_id: null,
  error_code: null, attempt: 1, heartbeat_at: when, created_at: when,
};
const view = (opts: Partial<Parameters<typeof projectOwnerWork>[0]> = {}) =>
  projectOwnerWork({ runs: [], steps: [], jobs: [], proposals: [], attempts: [], ...opts }, Date.parse(when));

describe("Task 16B persisted agentic work", () => {
  it("shows queued, actual leased and retrying durable steps", () => {
    expect(view({ runs: [run], steps: [step] })[0].status).toBe("queued");
    expect(view({ runs: [{ ...run, status: "running" }], steps: [{ ...step, status: "leased", attempts: 1, lease_until: "2026-11-14T10:01:00.000Z" }] })[0].status).toBe("running");
    expect(view({ runs: [{ ...run, status: "running" }], steps: [{ ...step, status: "leased", attempts: 2, lease_until: "2026-11-14T10:01:00.000Z" }] })[0].status).toBe("retrying");
  });
  it("reports expired persisted leases truthfully even before the worker runs again", () => {
    const running = { ...run, status: "running" } as RunRow;
    const dead = { ...step, status: "leased" as const, attempts: 1, lease_until: when };
    const unsafe = view({ runs: [running], steps: [dead] })[0];
    expect(unsafe.status).toBe("uncertain");
    expect(unsafe.proof).toBeNull();
    const replayable = view({ runs: [running], steps: [{ ...dead, retry_mode: "idempotent" }] })[0];
    expect(replayable.status).toBe("queued");
    expect(replayable.id).toBe(unsafe.id);
  });
  it("holds lease expiry as uncertain and other blocked work as failed", () => {
    const r = { ...run, status: "blocked" } as RunRow;
    expect(view({ runs: [r], steps: [{ ...step, status: "blocked", error_code: "lease_expired" }] })[0].status).toBe("uncertain");
    expect(view({ runs: [r], steps: [{ ...step, status: "blocked", error_code: "authorization_revoked" }] })[0].status).toBe("failed");
  });
  it("shows persisted 15A monitoring and source closure without inventing an effect", () => {
    const inv = { episode_id: "e", phase: "collect" as const, failure_count: 0,
      lease_token: null, lease_until: null, last_error: null, updated_at: when };
    expect(view({ investigations: [inv] })[0].status).toBe("queued");
    expect(view({ investigations: [{ ...inv, phase: "investigate" }] })[0].status).toBe("running");
    expect(view({ investigations: [{ ...inv, phase: "awaiting_owner" }] })[0].detail).toMatch(/monitoring/);
    expect(view({ investigations: [{ ...inv, failure_count: 2 }] })[0].status).toBe("retrying");
    const done = view({ investigations: [{ ...inv, phase: "resolved" }] })[0];
    expect(done.status).toBe("source_resolved");
    expect(done.proof).toBeNull();
    expect(done.detail).toMatch(/does not prove an external effect/);
    expect(view({ investigations: [{ ...inv, phase: "blocked", last_error: "source_missing" }] })[0].status).toBe("uncertain");
  });
  it("never treats a saved model answer as a provider receipt", () => {
    const item = view({ runs: [{ ...run, status: "completed", final_report_ref: "reply", finished_at: when }] })[0];
    expect(item.status).toBe("answer_ready");
    expect(item.proof).toEqual({ kind: "verified_reply", ref: "reply", at: when });
    expect(item.detail).toMatch(/does not verify any external action/);
  });
  it("requires the exact effect hash, verified state and receipt before claiming a completed action", () => {
    const done = { ...proposal, status: "committed" };
    expect(view({ proposals: [done] })[0].status).toBe("uncertain");
    expect(view({ proposals: [done], attempts: [{proposal_id: "p", effect_hash: "wrong", state: "verified", receipt_ref: "x", verified_at: when}] })[0].status).toBe("uncertain");
    expect(view({ proposals: [done], attempts: [{proposal_id: "p", effect_hash: "hash", state: "verified", receipt_ref: null, verified_at: when}] })[0].status).toBe("uncertain");
    const item = view({ proposals: [done], attempts: [{proposal_id: "p", effect_hash: "hash", state: "verified", receipt_ref: "receipt", verified_at: when}] })[0];
    expect(item.status).toBe("verified_complete");
    expect(item.proof?.kind).toBe("verified_effect");
  });
  it("never adds another approval action; leaves the existing proposal card in charge", () => {
    const item = view({ proposals: [proposal] })[0];
    expect(item.status).toBe("approval_required");
    expect(item.nextStep).toMatch(/existing proposal card/);
    expect(item.proposalId).toBe("p");
  });
  it("does not fabricate a failed external effect from a stale chat heartbeat", () => {
    const item = projectOwnerWork({ runs: [], steps: [], jobs: [job], proposals: [], attempts: [] }, Date.parse(when) + 180_001)[0];
    expect(item.status).toBe("uncertain");
    expect(item.proof).toBeNull();
  });
  it("exposes real failures but not a provider-complete claim from a finished agent job", () => {
    expect(view({ jobs: [{ ...job, status: "failed", error_code: "timeout" }] })[0].status).toBe("failed");
    expect(view({ jobs: [{ ...job, status: "done", reply_message_id: "answer" }] })[0].status).toBe("answer_ready");
  });
  it("never describes owner rejection as a failed effect", () => {
    const item = view({ proposals: [{ ...proposal, status: "rejected" }] })[0];
    expect(item.status).toBe("cancelled");
    expect(item.proof).toBeNull();
  });
  it("deduplicates a durable run and its underlying per-turn job", () => {
    const items = view({ runs: [run], steps: [step], jobs: [job] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("durable_run");
  });
  it("resolves all rendered run, job, proposal and exception wording from the English catalog", async () => {
    const english = (await import("../../../../messages/en.json")).default;
    const registeredCopy = Object.values(english.SupervisorWork.copy);
    const representative = view({
      runs: [run, { ...run, id: "blocked", status: "blocked" }],
      steps: [step, { ...step, run_id: "blocked", status: "blocked", error_code: "lease_expired" }],
      jobs: [{ ...job, owner_message_id: "different" }],
      proposals: [proposal, { ...proposal, id: "failed", status: "stale" }],
      investigations: [{ episode_id: "e", phase: "awaiting_owner", failure_count: 0,
        lease_token: null, lease_until: null, last_error: null, updated_at: when }],
    });
    for (const item of representative) {
      for (const field of [item.title, item.detail, item.nextStep]) {
        expect(registeredCopy, "unregistered owner-facing copy: " + field).toContain(field);
      }
    }
  });
  it("does not treat approval or a manual pending handoff as a completed effect", () => {
    expect(view({ proposals: [{ ...proposal, status: "manual_pending" }] })[0].status).toBe("uncertain");
    expect(view({ proposals: [{ ...proposal, status: "approved" }] })[0].status).toBe("running");
  });
});
