import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateEmployeeRow: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({
  getActiveBusinessId: async () => "10000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "20000000-0000-4000-8000-000000000002" } },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "businesses") {
        return {
          select: () => ({ eq: () => ({
            single: async () => ({ data: { timezone: "America/Los_Angeles" } }),
          }) }),
        };
      }
      if (table === "staff_schedules") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
            is: async () => ({ data: [] }),
          }) }) }) }),
        };
      }
      if (table === "employees") {
        return {
          update: (payload: unknown) => {
            mocks.updateEmployeeRow(payload);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      throw new Error(`Unexpected Staff table ${table}`);
    },
  }),
}));
vi.mock("@/lib/data/materializeSchedule", () => ({
  ensureScheduledShiftsThroughDate: vi.fn(),
}));
vi.mock("@/lib/data/materializeScheduleRules", () => ({
  selectSchedulesForDate: vi.fn(),
}));
vi.mock("@/lib/pos/rollup", () => ({
  recomputeDailyRollup: vi.fn(),
}));

import { updateEmployee } from "./staff";

describe("existing Staff.updateEmployee canonical wage update path", () => {
  const employeeId = "30000000-0000-4000-8000-000000000003";

  beforeEach(() => mocks.updateEmployeeRow.mockClear());

  it("updates the canonical positive hourly wage fields used by the compensation trigger", async () => {
    const result = await updateEmployee({
      employeeId, name: "Ahmed", role: "Barista", wagePeriod: "hour", wageAmountCents: 1800,
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.updateEmployeeRow).toHaveBeenCalledWith({
      display_name: "Ahmed", role: "Barista",
      default_hourly_wage_cents: 1800,
      wage_period: "hour", wage_amount_cents: 1800,
    });
  });

  it("preserves pending salary conversion with zero hourly cache until scheduled hours are known", async () => {
    const result = await updateEmployee({
      employeeId, name: "Ahmed", wagePeriod: "month", wageAmountCents: 200000,
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.updateEmployeeRow).toHaveBeenCalledWith({
      display_name: "Ahmed", role: null,
      default_hourly_wage_cents: 0,
      wage_period: "month", wage_amount_cents: 200000,
    });
  });

  it("rejects malformed changes without writing the employee wage", async () => {
    const result = await updateEmployee({
      employeeId, name: "Ahmed", wagePeriod: "hour", wageAmountCents: 0,
    });
    expect(result.ok).toBe(false);
    expect(mocks.updateEmployeeRow).not.toHaveBeenCalled();
  });
});
