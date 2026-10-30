import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement } from "react";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  periodCalendarRange: vi.fn(() => ({ start: "2026-10-01", end: "2026-10-30" })),
  readAllPosRows: vi.fn(),
  readSavedTodayLive: vi.fn(),
  currentTodayBusinessDay: vi.fn(),
  liveSalesView: vi.fn(),
  timeReader: vi.fn(async (_page: string, _name: string, read: () => Promise<unknown>) => read()),
}));

vi.mock("@/lib/viewmodels/period", () => ({ periodCalendarRange: mocks.periodCalendarRange }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ from: () => ({}) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { state: "unverified" } }),
    }) }) }),
  }),
}));
vi.mock("@/lib/data/getActiveBusinessId", () => ({
  getActiveBusinessId: async () => "cafe-1",
}));
vi.mock("@/lib/auth/requireUser", () => ({
  requireOwnBusiness: async () => ({ id: "owner-1" }),
}));
vi.mock("@/lib/data/getSnapshot", () => ({ getSnapshot: mocks.getSnapshot }));
vi.mock("@/lib/pos/pagedReads", () => ({ readAllPosRows: mocks.readAllPosRows }));
vi.mock("@/lib/data/todayLive.server", () => ({
  readSavedTodayLive: mocks.readSavedTodayLive,
  currentTodayBusinessDay: mocks.currentTodayBusinessDay,
}));
vi.mock("@/components/home/liveSales", () => ({ liveSalesView: mocks.liveSalesView }));
vi.mock("@/lib/perf/timeReader.server", () => ({ timeReader: mocks.timeReader }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "en",
}));
vi.mock("@/i18n/navigation", () => ({ Link: () => null }));
vi.mock("@/components/shared/PeriodSwitch", () => ({ default: () => null }));
vi.mock("@/components/shared/AddCostFab", () => ({ default: () => null }));
vi.mock("@/components/money/MoneyViewSwitch", () => ({ default: () => null }));
vi.mock("@/components/money/CostRecoveryView", () => ({ default: () => null }));
vi.mock("@/components/money/ProfitCostsView", () => ({ default: () => null }));
vi.mock("@/components/shared/PageShell", () => ({ default: () => null }));

import MoneyPage from "./page";
import CostRecoveryView from "@/components/money/CostRecoveryView";
import ProfitCostsView from "@/components/money/ProfitCostsView";

const snapshot = {
  business: { id: "cafe-1", name: "Cafe", timezone: "America/Los_Angeles" },
  todayHasData: false,
  monthKey: "2026-10",
  todayDateStr: "Oct 30",
};
const savedLive = { value: { orders: 9 } };
const liveSales = { netSalesCents: 12345, fresh: true, time: "9:45", unreadOrders: 0 };
const previousServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function childProps(page: Awaited<ReturnType<typeof MoneyPage>>, component: unknown) {
  const child = Children.toArray(page.props.children).find(
    (item) => isValidElement(item) && item.type === component,
  );
  if (!isValidElement(child)) throw new Error("Expected Money view was not rendered");
  return child.props as { snapshot: unknown; salesSources?: string[]; liveToday?: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-key";
  mocks.getSnapshot.mockResolvedValue(snapshot);
  mocks.readAllPosRows.mockResolvedValue([
    { pos_order_id: "toast:1", processing_fee_provider: "toast" },
    { pos_order_id: "csv-2", processing_fee_provider: null },
  ]);
  mocks.readSavedTodayLive.mockResolvedValue(savedLive);
  mocks.currentTodayBusinessDay.mockResolvedValue("2026-10-30");
  mocks.liveSalesView.mockReturnValue(liveSales);
});

afterAll(() => {
  if (previousServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceKey;
});

describe("Money view reader selection", () => {
  it.each(["today", "week", "month"] as const)(
    "Recovery %s skips full-order evidence without changing snapshot or live sales",
    async (period) => {
      const page = await MoneyPage({ searchParams: Promise.resolve({ period, view: "recovery" }) });
      const props = childProps(page, CostRecoveryView);
      expect(mocks.getSnapshot).toHaveBeenCalledExactlyOnceWith(period);
      expect(props.snapshot).toBe(snapshot);
      expect(props.liveToday).toEqual({ sales: liveSales, orders: 9 });
      expect(mocks.readSavedTodayLive).toHaveBeenCalledOnce();
      expect(mocks.currentTodayBusinessDay).toHaveBeenCalledOnce();
      expect(mocks.readAllPosRows).not.toHaveBeenCalled();
      expect(mocks.periodCalendarRange).not.toHaveBeenCalled();
    },
  );

  it("Profit retains complete order-source evidence and the shared snapshot", async () => {
    const page = await MoneyPage({ searchParams: Promise.resolve({ period: "week", view: "profit" }) });
    const props = childProps(page, ProfitCostsView);
    expect(mocks.getSnapshot).toHaveBeenCalledExactlyOnceWith("week");
    expect(props.snapshot).toBe(snapshot);
    expect(mocks.periodCalendarRange).toHaveBeenCalledExactlyOnceWith(snapshot, "week");
    expect(mocks.readAllPosRows).toHaveBeenCalledOnce();
    expect(props.salesSources).toEqual(["toast", "upload"]);
    expect(mocks.readSavedTodayLive).toHaveBeenCalledOnce();
  });

  it("Profit keeps unknown provenance when no orders are available", async () => {
    mocks.readAllPosRows.mockResolvedValue([]);
    const page = await MoneyPage({ searchParams: Promise.resolve({ view: "profit" }) });
    expect(childProps(page, ProfitCostsView).salesSources).toEqual(["unknown"]);
    expect(mocks.getSnapshot).toHaveBeenCalledExactlyOnceWith("month");
    expect(mocks.readAllPosRows).toHaveBeenCalledOnce();
  });
});
