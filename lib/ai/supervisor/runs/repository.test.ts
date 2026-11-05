import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ name: string; params: Record<string, unknown> }>);
const ids = vi.hoisted(() => ({
  run: "00000000-0000-4000-8000-000000000101",
  business: "00000000-0000-4000-8000-000000000102",
  owner: "00000000-0000-4000-8000-000000000103",
  thread: "00000000-0000-4000-8000-000000000104",
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "supervisor_run_claim") return { data: { kind: "busy" }, error: null };
      if (name === "supervisor_run_renew") return { data: true, error: null };
      if (name === "supervisor_run_complete_step" || name === "supervisor_run_reconcile")
        return { data: { status: "completed" }, error: null };
      return { data: {
        id: ids.run, business_id: ids.business, owner_user_id: ids.owner,
        thread_id: ids.thread, request_key: params.p_request_key ?? ids.run,
        plan_hash: "a".repeat(64),
        status: name === "supervisor_run_finish" ? "completed" : "pending",
        final_report_ref: params.p_final_report_ref ?? null,
      }, error: null };
    },
  }),
}));
import { SupabaseDurableRunRepository } from "./repository.server";

describe("Supervisor durable run repository owner scope", () => {
  it("passes tenant, owner and thread to every state-changing RPC", async () => {
    calls.length = 0;
    const scope = { businessId: ids.business, ownerUserId: ids.owner, threadId: ids.thread };
    const repository = new SupabaseDurableRunRepository();
    await repository.start(scope, randomUUID(), [{ key: "read", retry: "idempotent" }]);
    await repository.claim(scope, ids.run, randomUUID(), 60);
    await repository.renew(scope, ids.run, "read", randomUUID(), 60);
    await repository.complete(scope, ids.run, "read", randomUUID(), "existing:receipt");
    await repository.reconcile(scope, ids.run, "read", "verified:receipt");
    await repository.finish(scope, ids.run, "existing:report");
    expect(calls.map(c => c.name)).toEqual([
      "supervisor_run_start", "supervisor_run_claim", "supervisor_run_renew",
      "supervisor_run_complete_step", "supervisor_run_reconcile", "supervisor_run_finish",
    ]);
    for (const call of calls) {
      expect(call.params).toMatchObject({
        p_business_id: ids.business, p_owner_user_id: ids.owner, p_thread_id: ids.thread,
      });
    }
    expect(calls.slice(1).every(c => c.params.p_run_id === ids.run)).toBe(true);
  });
});
