import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingTask } from "@/lib/operating/tasks";

const mocks = vi.hoisted(() => ({ stored: vi.fn(), alerts: vi.fn(), operations: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "en"),
  getTranslations: vi.fn(async (ns: string) => (key: string, params?: Record<string, unknown>) =>
    ns + "." + key + (params ? JSON.stringify(params) : "")),
}));
vi.mock("@/lib/data/getPosConnectionStatus", () => ({ getPosConnectionStatus: async () => ({ status: "active", provider: "toast" }) }));
vi.mock("@/lib/data/operatingTasks", () => ({ readPersistedOperatingTasks: mocks.stored }));
vi.mock("@/lib/data/getAlerts", () => ({ getOpenAlerts: mocks.alerts }));
vi.mock("@/lib/data/getCatalogMatchReview", () => ({ getCatalogMatchReview: async () => [] }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/viewmodels/homeViewModel", () => ({ buildHomeViewModel: () => ({
  isGettingStarted: false, missingCategories: [], coverage: { actualDays: 1, expectedDays: 1 } }) }));
vi.mock("@/lib/viewmodels/operationsTeam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewmodels/operationsTeam")>()), buildOperationsTeamViewModel: mocks.operations }));
vi.mock("@/lib/viewmodels/period", () => ({ daysForPeriod: () => [] }));
vi.mock("@/lib/data/getSnapshot", () => ({ getSnapshot: vi.fn() }));
vi.mock("@/lib/data/getMenuControlCenter", () => ({ getMenuControlCenter: vi.fn() }));
vi.mock("@/lib/pos/square/oauth", () => ({ isSquareConfigured: () => false }));
vi.mock("@/components/home/GettingStartedCard", () => ({ gettingStartedAttention: () => [] }));
vi.mock("@/components/alerts/alertContent", () => ({ describeAlert: (alert: { kind: string; payload: { employeeName?: string } }) =>
  ({ title: "Meal break: " + (alert.payload.employeeName ?? ""), actionLabel: "Open", actionHref: "/staff" }) }));

import { getAttentionItems, readInbox } from "./getAttentionItems.server";
import { needsYouFromAttention } from "@/lib/viewmodels/operationsTeam";

const snapshot = { business: { id: "cafe" }, todayDateStr: "2026-11-04" };
const plan = (day: string): OperatingTask => ({ id: "event-plan:" + day, businessId: "cafe", agentId: "alex", kind: "event_plan",
  entityType: "event_day", entityId: day, status: "needs_owner", payload: { needsApproval: true, businessDate: day, threadId: "t" },
  confidence: "high", evidence: [], createdAt: "2026-11-01T15:00:00Z" });
const report: OperatingTask = { ...plan("2026-11-02"), id: "supervisor:alex.event_readiness.v1:p", payload: { text: "**Report**", threadId: "t" } };
const mealBreak = (id: string, date: string) => ({ id, kind: "meal_break", impactCents: null, status: "new",
  payload: { employeeName: "Sam", employeeId: "e1", date }, createdAt: date + "T20:00:00Z" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operations.mockReturnValue({ needsYou: [], handled: [], watching: [] });
  mocks.stored.mockResolvedValue([plan("2026-10-31"), plan("2026-11-05"), plan("2026-11-11"), report]);
  mocks.alerts.mockResolvedValue([mealBreak("old", "2026-10-28"), mealBreak("new", "2026-11-03")]);
});

describe("one inbox reader for Home, chat and Operations", () => {
  it("counts only open decisions, and the team cards and tabs add up to Home's count", async () => {
    const args = { snapshot: snapshot as never, menu: [] as never, locale: "en" as const };
    const [home, inbox] = await Promise.all([getAttentionItems(args), readInbox(args)]);
    expect(home.map((item) => item.id).sort()).toEqual(["alert:new", "event-plan:2026-11-05", "event-plan:2026-11-11"]);
    expect(inbox.items).toEqual(home);
    const { rows, counts } = needsYouFromAttention(inbox.items, inbox.tasks.needsYou);
    expect(rows).toHaveLength(home.length);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(home.length);
  });

  it("titles an event plan with its weekday date, never the cup-cost fallback", async () => {
    const items = await getAttentionItems({ snapshot: snapshot as never, menu: [] as never, locale: "en" });
    const event = items.find((item) => item.id === "event-plan:2026-11-05")!;
    expect(event.displayTitle).toBe('Operations.eventPlanReview{"date":"Thu, Nov 5"}');
    expect(event.title.key).toBe("Operations.eventPlanReview");
    expect(event.subjectDate).toBe("2026-11-05");
    expect(items.some((item) => item.displayTitle.includes("mayaWatching"))).toBe(false);
  });

  it("moves a past shift's meal break out of Needs you into the expired list, with its date", async () => {
    const inbox = await readInbox({ snapshot: snapshot as never, menu: [] as never, locale: "en" });
    expect(inbox.expiredAlerts.map((item) => [item.id, item.subjectDate])).toEqual([["alert:old", "2026-10-28"]]);
    expect(inbox.items.find((item) => item.id === "alert:new")?.subjectDate).toBe("2026-11-03");
  });

  it("keeps the event report in Watching and the past plan in Handled", async () => {
    const inbox = await readInbox({ snapshot: snapshot as never, menu: [] as never, locale: "en" });
    expect(inbox.tasks.watching.map((t) => t.id)).toEqual(["supervisor:alex.event_readiness.v1:p"]);
    expect(inbox.tasks.handled.map((t) => [t.id, t.status])).toEqual([["event-plan:2026-10-31", "expired"]]);
  });
});
