import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ rpc }) }));
import { selectNextDurableRun } from "./repository.server";

const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => rpc.mockReset());

describe("existing durable worker SQL dispatch port", () => {
  it("reads a reserved ordinary candidate from the canonical RPC", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: false }, error: null });
    expect(await selectNextDurableRun()).toEqual({ runId: id, recovery: false });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("supervisor_select_next_durable_run", {});
  });
  it("reads reserved reconciliation work without issuing another claim", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: true }, error: null });
    expect(await selectNextDurableRun()).toEqual({ runId: id, recovery: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("reports an empty or contended fleet as no candidate", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await selectNextDurableRun()).toBeNull();
  });
  it("fails closed on storage failure", async () => {
    rpc.mockResolvedValue({ data: { run_id: id, recovery: true }, error: { message: "unavailable" } });
    await expect(selectNextDurableRun()).rejects.toThrow("Supervisor durable run storage unavailable");
  });
  it("rejects malformed dispatch identities and missing recovery type", async () => {
    rpc.mockResolvedValueOnce({ data: { run_id: "other", recovery: false }, error: null })
      .mockResolvedValueOnce({ data: { run_id: id }, error: null });
    await expect(selectNextDurableRun()).rejects.toThrow();
    await expect(selectNextDurableRun()).rejects.toThrow();
  });
});
