import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ business: {} as Record<string, unknown>, items: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [{ business_id: "a0000000-0000-4000-8000-000000000001", businesses: { is_demo: false } }],
          error: null,
        }),
      }),
    }),
  }),
}));
vi.mock("./getPricingInputs", () => ({
  getPricingInputs: async () => ({ business: state.business, items: state.items }),
}));

import { getProfitGoalSimulatorData } from "./getProfitGoalSimulatorData";

const complete = {
  daysWithSalesInWindow: 3,
  monthlyRevenueCents: 3_000_000,
  monthlyVariableProductCostCents: 900_000,
  monthlyStaffCostCents: 1_000_000 as number | null,
  monthlyOperatingCostCents: 500_000,
  monthlyProcessingFeesCents: 90_000,
  processingFeesStatus: "actual",
  productCostsStatus: "actual",
  payrollCostsStatus: "actual",
  operatingCostsStatus: "actual",
};

beforeEach(() => {
  state.business = { ...complete };
  state.items = [];
});

describe("profit-goal simulator data", () => {
  it("simulates with only three sales days, labeled as an estimate", async () => {
    const data = await getProfitGoalSimulatorData();
    expect(data.canSimulate).toBe(true);
    expect(data.unavailableReason).toBeNull();
    expect(data.currentMarginQuality).toBe("estimated");
  });

  it("never treats missing payroll as zero staff cost", async () => {
    state.business = { ...complete, payrollCostsStatus: "missing", monthlyStaffCostCents: null };
    const data = await getProfitGoalSimulatorData();
    expect(data.canSimulate).toBe(false);
    expect(data.unavailableReason).toBe("MISSING_PAYROLL");
    expect(data.currentOperatingMargin).toBeNull();
  });

  it("blocks when processing fees or operating costs are missing", async () => {
    state.business = { ...complete, processingFeesStatus: "missing" };
    expect((await getProfitGoalSimulatorData()).unavailableReason).toBe("MISSING_PROCESSING_FEES");
    state.business = { ...complete, operatingCostsStatus: "missing" };
    expect((await getProfitGoalSimulatorData()).unavailableReason).toBe("MISSING_OPERATING_COSTS");
  });

  it("still blocks with no sales days at all", async () => {
    state.business = { ...complete, daysWithSalesInWindow: 0 };
    expect((await getProfitGoalSimulatorData()).unavailableReason).toBe("NOT_ENOUGH_SALES");
  });
});
