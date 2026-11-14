import { describe, expect, it } from "vitest";
import { projectOwnerWork, type RunRow, type StepRow, type ProposalRow, type JobRow } from "./ownerWorkView";

const when = "2026-11-14T10:00:00.000Z";
const run: RunRow = {
  id: "r", request_key: "o", status: "pending", final_report_ref: null,
  updated_at: when, finished_at: null,
};
const step: StepRow = {
  run_id: "r", step_key: "owner_turn", step_index: 2, status: "pending",
  attempts: 0, error_code: null, updated_at: when,
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
    expect(view({ runs: [{ ...run, status: "running" }], steps: [{ ...step, status: "leased", attempts: 1 }] })[0].status).toBe("running");
    expect(view({ runs: [{ ...run, status: "running" }], steps: [{ ...step, status: "leased", attempts: 2 }] })[0].status).toBe("retrying");
  });
  it("holds lease expiry as uncertain and other blocked work as failed", () => {
    const r = { ...run, status: "blocked" } as RunRow;
    expect(view({ runs: [r], steps: [{ ...step, status: "blocked", error_code: "lease_expired" }] })[0].status).toBe("uncertain");
    expect(view({ runs: [r], steps: [{ ...step, status: "blocked", error_code: "authorization_revoked" }] })[0].status).toBe("failed");
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
  it("does not treat approval or a manual pending handoff as a completed effect", () => {
    expect(view({ proposals: [{ ...proposal, status: "manual_pending" }] })[0].status).toBe("uncertain");
    expect(view({ proposals: [{ ...proposal, status: "approved" }] })[0].status).toBe("running");
  });
});
