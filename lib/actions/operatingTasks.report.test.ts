import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(), read: vi.fn(), write: vi.fn(), revalidate: vi.fn(),
  update: vi.fn(), readFilters: vi.fn(), writeFilters: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn() }));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  authenticatedConversationContext: mocks.owner,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (table: string) => {
      if (table !== "operating_tasks") throw new Error("Unexpected table");
      const reading = {
        eq: (field: string, value: unknown) => {
          mocks.readFilters(field, value);
          return reading;
        },
        maybeSingle: () => mocks.read(),
      };
      const writing = {
        eq: (field: string, value: unknown) => {
          mocks.writeFilters(field, value);
          return writing;
        },
        select: () => writing,
        maybeSingle: () => mocks.write(),
      };
      return {
        select: () => reading,
        update: (value: unknown) => {
          mocks.update(value);
          return writing;
        },
      };
    },
  }),
}));

import { acknowledgeExperimentReport } from "./operatingTasks";

const businessId = "e106f379-dba3-4e35-847f-e784132d91cb";
const taskId = "supervisor:alex.drink_price_experiment.v1:09e862bd-7016-4289-89d6-99f83c16e7b4";
describe("terminal experiment report acknowledgment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.owner.mockResolvedValue({ scope: { businessId } });
    mocks.read.mockResolvedValue({
      data: { id: taskId, kind: "price_experiment_report", status: "needs_owner" },
      error: null,
    });
    mocks.write.mockResolvedValue({ data: { id: taskId }, error: null });
  });

  it("only handles the exact scoped, pending report and preserves data for future refresh", async () => {
    expect(await acknowledgeExperimentReport({ taskId })).toEqual({ ok: true });
    expect(mocks.readFilters).toHaveBeenCalledWith("business_id", businessId);
    expect(mocks.readFilters).toHaveBeenCalledWith("id", taskId);
    expect(mocks.writeFilters).toHaveBeenCalledWith("business_id", businessId);
    expect(mocks.writeFilters).toHaveBeenCalledWith("kind", "price_experiment_report");
    expect(mocks.writeFilters).toHaveBeenCalledWith("status", "needs_owner");
    const updated = mocks.update.mock.calls[0][0];
    expect(updated).toMatchObject({ status: "handled" });
    expect(updated.resolved_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(updated).not.toHaveProperty("payload");
    expect(updated).not.toHaveProperty("evidence");
    expect(mocks.revalidate).toHaveBeenCalledWith("/operations");
  });

  it.each([
    ["price_review", "needs_owner"],
    ["price_experiment_report", "handled"],
    ["price_experiment_report", "watching"],
  ])("never acknowledges non-pending report (%s, %s)", async (kind, status) => {
    mocks.read.mockResolvedValue({ data: { id: taskId, kind, status }, error: null });
    expect(await acknowledgeExperimentReport({ taskId })).toEqual({ ok: false, error: "task_not_available" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails closed when owner permission cannot be established", async () => {
    mocks.owner.mockRejectedValue(new Error("not owner"));
    expect(await acknowledgeExperimentReport({ taskId })).toEqual({ ok: false, error: "owner_access_required" });
    expect(mocks.readFilters).not.toHaveBeenCalled();
  });

  it("does not claim success for a concurrent update or missing task", async () => {
    mocks.write.mockResolvedValue({ data: null, error: null });
    expect(await acknowledgeExperimentReport({ taskId })).toEqual({ ok: false, error: "task_not_updated" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("rejects malformed requests before querying the database", async () => {
    expect(await acknowledgeExperimentReport({ taskId: 3 })).toEqual({ ok: false, error: "invalid_request" });
    expect(mocks.owner).not.toHaveBeenCalled();
  });
});
