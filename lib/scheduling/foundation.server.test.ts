import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compensation: [] as Array<Record<string, unknown>>,
  wages: [] as Array<Record<string, unknown>>,
  requestedWages: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({
  getActiveBusinessId: async () => "10000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({
      data: { user: { id: "20000000-0000-4000-8000-000000000002" } },
      error: null,
    }) },
    from: (table: string) => {
      if (table === "memberships") return {
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({
            data: { role: "owner", businesses: { is_demo: false } }, error: null,
          }),
        }) }) }) }),
      };
      if (table === "employees") return {
        select: (fields: string) => {
          mocks.requestedWages(fields);
          return { eq: () => ({ in: async () => ({
            data: mocks.wages, error: null,
          }) }) };
        },
      };
      if (table === "scheduling_foundation_audit_events") return {
        select: () => ({ eq: () => ({ order: () => ({
          limit: async () => ({ data: [], error: null }),
        }) }) }),
      };
      return {
        select: () => ({ eq: async () => ({
          data: table === "staff_scheduling_compensation" ? mocks.compensation : [],
          error: null,
        }) }),
      };
    },
  }),
}));

import { readSchedulingFoundation } from "./foundation.server";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("scheduling foundation compensation read is fail closed", () => {
  beforeEach(() => {
    mocks.compensation = [];
    mocks.wages = [];
    mocks.requestedWages.mockClear();
    process.env.SCHEDULING_FOUNDATION_ENABLED = "true";
  });

  it("invalidates negative cached/amount fields for EVERY trusted state on read", async () => {
    const cases = [
      { state: "known_eligible_zero", amount: -1, hourly: 0 },
      { state: "known_eligible_zero", amount: 0, hourly: -1 },
      { state: "known_paid", amount: 1800, hourly: -1 },
      { state: "salary_conversion_pending", amount: 200000, hourly: -1, period: "month" },
    ];
    mocks.compensation = cases.map((row, i) => ({
      employee_id: id(i), cash_cost_state: row.state,
      eligibility_reference: "Outdated evidence", eligibility_verified_by: id(90),
      eligibility_verified_at: "2026-10-14T00:00:00Z",
    }));
    mocks.wages = cases.map((row, i) => ({
      id: id(i), wage_period: row.period ?? "hour",
      wage_amount_cents: row.amount, default_hourly_wage_cents: row.hourly,
    }));
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect(result.records.compensation).toHaveLength(4);
    for (const row of result.records.compensation as Array<Record<string, unknown>>) {
      expect(row).toMatchObject({
        cash_cost_state: "unknown", eligibility_reference: null,
        eligibility_verified_by: null, eligibility_verified_at: null,
      });
    }
    // No source compensation mutation: read guard only sanitizes the result.
    expect(mocks.compensation[0].cash_cost_state).toBe("known_eligible_zero");
    expect(mocks.requestedWages).toHaveBeenCalledWith(
      "id,wage_period,wage_amount_cents,default_hourly_wage_cents",
    );
  });

  it("retains valid known states for null/zero, positive and salary-pending wages", async () => {
    const cases = [
      { state: "known_eligible_zero", period: "hour", amount: null, hourly: null },
      { state: "known_eligible_zero", period: "hour", amount: 0, hourly: 0 },
      { state: "known_paid", period: "hour", amount: 1800, hourly: 1800 },
      { state: "salary_conversion_pending", period: "month", amount: 200000, hourly: 0 },
      { state: "unknown", period: "hour", amount: -1, hourly: 0 },
    ];
    mocks.compensation = cases.map((row, i) => ({
      employee_id: id(i), cash_cost_state: row.state,
    }));
    mocks.wages = cases.map((row, i) => ({
      id: id(i), wage_period: row.period,
      wage_amount_cents: row.amount, default_hourly_wage_cents: row.hourly,
    }));
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect((result.records.compensation as Array<{ cash_cost_state: string }>)
      .map((row) => row.cash_cost_state))
      .toEqual(cases.map((row) => row.state));
  });

  it("does not expose verified zero for a missing or malformed wage snapshot", async () => {
    mocks.compensation = [
      { employee_id: id(1), cash_cost_state: "known_eligible_zero" },
      { employee_id: id(2), cash_cost_state: "known_paid" },
      { employee_id: id(3), cash_cost_state: "salary_conversion_pending" },
    ];
    mocks.wages = [
      { id: id(2), wage_period: "hour", wage_amount_cents: "1800", default_hourly_wage_cents: 1800 },
      { id: id(3), wage_period: "month", wage_amount_cents: 200000, default_hourly_wage_cents: "0" },
    ];
    const result = await readSchedulingFoundation();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect((result.records.compensation as Array<{ cash_cost_state: string }>)
      .map((row) => row.cash_cost_state))
      .toEqual(["unknown", "unknown", "unknown"]);
  });
});
