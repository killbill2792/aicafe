import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingTask } from "@/lib/operating/tasks";

/** One café fixture read by every surface that states a Needs-you count or picks a Needs-you item. */
const TODAY = "2026-11-04";
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
const base = { businessId: "cafe", confidence: "high" as const, evidence: [] };
const review = (id: string, item: string, over: Partial<OperatingTask> = {}): OperatingTask => ({ ...base, id, agentId: "alex",
  kind: "price_review", entityType: "menu_item", entityId: item, status: "needs_owner",
  payload: { itemName: item, currentPriceCents: 500, suggestedPriceCents: 560 }, createdAt: iso(0), ...over });
const fixture = vi.hoisted(() => ({ stored: [] as OperatingTask[], derived: [] as OperatingTask[], readCalls: [] as unknown[] }));
const stored: OperatingTask[] = [
  // Expired on read: an event plan for a day that has passed.
  { ...base, id: "event-plan:2026-10-31", agentId: "alex", kind: "event_plan", entityType: "event_day", entityId: "2026-10-31",
    status: "needs_owner", payload: { needsApproval: true, businessDate: "2026-10-31", threadId: "t" }, createdAt: iso(5) },
  // Resurfaced: its 7-day snooze ended yesterday; the stored row still says watching.
  review("price:latte:500:560", "latte", { status: "watching", createdAt: iso(9),
    payload: { itemName: "latte", currentPriceCents: 500, suggestedPriceCents: 560, snoozeMode: "later_7", snoozeUntil: iso(1) } }),
  { ...base, id: "money:1", agentId: "leo", kind: "money_update", status: "needs_owner", payload: {}, createdAt: iso(2) },
];
// Computed on read and never stored (page loads no longer write), plus the resurfaced one.
const derived = [review("price:latte:500:560", "latte"), review("price:mocha:450:520", "mocha")];

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en",
  getTranslations: async (ns: string) => (key: string) => ns + "." + key }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
const snapshot = { business: { id: "cafe", timezone: "UTC" }, todayDateStr: TODAY, monthKey: "2026-11", runningCostLines: [] };
vi.mock("@/lib/data/getSnapshot", () => ({ getSnapshot: async () => snapshot }));
vi.mock("@/lib/data/snapshot.server", () => ({ getBusinessSnapshotFromDb: async () => snapshot }));
vi.mock("@/lib/data/getMenuControlCenter", () => ({ getMenuControlCenter: async () => [] }));
vi.mock("@/lib/data/operatingTasks", () => ({ readPersistedOperatingTasks: async (...args: unknown[]) => {
  fixture.readCalls.push(args); return fixture.stored; } }));
vi.mock("@/lib/data/getAlerts", () => ({ getOpenAlerts: async () => [] }));
vi.mock("@/lib/data/getCatalogMatchReview", () => ({ getCatalogMatchReview: async () => [] }));
vi.mock("@/lib/data/getPosConnectionStatus", () => ({ getPosConnectionStatus: async () => ({ status: "active", provider: "toast" }) }));
vi.mock("@/lib/viewmodels/homeViewModel", () => ({ buildHomeViewModel: () => ({
  isGettingStarted: false, missingCategories: [], coverage: { actualDays: 1, expectedDays: 1 } }) }));
vi.mock("@/lib/viewmodels/period", () => ({ daysForPeriod: () => [] }));
vi.mock("@/lib/viewmodels/operationsTeam", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/viewmodels/operationsTeam")>();
  return { ...actual, buildOperationsTeamViewModel: () => actual.projectOperatingTasks(fixture.derived) };
});
vi.mock("@/components/home/GettingStartedCard", () => ({ gettingStartedAttention: () => [] }));
// WhatsApp alert cron: a verified subscriber and an in-memory delivery ledger.
const alerts = vi.hoisted(() => ({ reserved: [] as Record<string, unknown>[], deliver: vi.fn() }));
vi.mock("@/lib/ai/notifications/whatsapp.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/notifications/whatsapp.server")>()),
  notificationEnabled: () => true, deliverOwnerTemplate: alerts.deliver }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminSupabaseClient: () => ({
  auth: { admin: { getUserById: async () => ({ data: { user: { phone: "+15550000000", phone_confirmed_at: "2026-10-01" } }, error: null }) } },
  from: (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) q[m] = () => q;
    q.limit = async () => ({ data: table === "ai_owner_notifications"
      ? [{ business_id: "cafe", owner_user_id: "owner", phone_e164: "+15550000000" }] : [], error: null });
    q.maybeSingle = async () => ({ data: { role: "owner" }, error: null });
    q.single = async () => ({ data: table === "businesses" ? { timezone: "UTC" } : { id: "attempt-1" }, error: null });
    q.insert = (row: Record<string, unknown>) => { alerts.reserved.push(row); return q; };
    q.update = () => q;
    return q;
  },
}) }));

import { getAttentionItems, readCafeNeedsYou, readInbox } from "./getAttentionItems.server";
import { attentionTools } from "@/lib/ai/agent/tools/attention";
import { GET as teamAlerts } from "@/app/api/cron/team-alerts/route";
import { createOwnerScopedCafeTools } from "@/lib/ai/cafeTools.server";

beforeEach(() => {
  fixture.stored = stored; fixture.derived = derived; fixture.readCalls = [];
  alerts.reserved = []; alerts.deliver.mockReset().mockResolvedValue({ sent: true, providerId: "p1" });
  process.env.CRON_SECRET = "secret";
});

describe("one Needs-you count for the same café on every surface", () => {
  it("Inbox, Home, chat tool, morning brief and WhatsApp alert all agree", async () => {
    const scope = { client: {} as never, businessId: "cafe" };
    const inbox = await readInbox({ locale: "en" });
    const home = await getAttentionItems({ locale: "en" });
    const chat = await attentionTools.get_attention_items.execute({}, { locale: "en", asOf: TODAY } as never);
    const cron = await readCafeNeedsYou(scope); // what the morning brief and the WhatsApp alert read
    const ids = inbox.items.map((item) => item.id).sort();
    // The resurfaced and the computed review count; the past-day plan does not.
    expect(ids).toEqual(["money:1", "price:latte:500:560", "price:mocha:450:520"]);
    expect(home.map((item) => item.id).sort()).toEqual(ids);
    expect(chat.total).toBe(3);
    expect(cron.count).toBe(3);
    // The crons read through the verified café scope, never a browser session.
    expect(fixture.readCalls.at(-1)).toEqual(["cafe", scope]);
  });

  it("the chat's team-task reader returns the same settled Needs-you tasks", async () => {
    const tools = createOwnerScopedCafeTools({ businessId: "cafe", ownerUserId: "owner" } as never, {} as never);
    const tasks = await tools.getTeamTasks();
    if (!tasks.available) throw new Error("tasks unavailable");
    const open = tasks.value.filter((task) => task.status === "needs_owner" || task.status === "needs_response");
    expect(open.map((task) => task.id).sort()).toEqual(["money:1", "price:latte:500:560", "price:mocha:450:520"]);
    expect(tasks.value.find((task) => task.id === "event-plan:2026-10-31")?.status).toBe("expired");
  });

  it("the WhatsApp alert is about an item in that same list (the newest one)", async () => {
    const response = await teamAlerts(new Request("https://x.test/api/cron/team-alerts", { headers: { authorization: "Bearer secret" } }));
    expect(await response.json()).toMatchObject({ sent: 1, failed: 0 });
    expect(alerts.reserved.map((row) => row.task_id)).toEqual(["price:mocha:450:520"]);
    expect(alerts.deliver).toHaveBeenCalledWith("+15550000000", "menu price review");
  });

  it("nothing is alerted when only expired items are stored", async () => {
    fixture.stored = [stored[0]]; fixture.derived = [];
    expect((await readCafeNeedsYou({ client: {} as never, businessId: "cafe" })).count).toBe(0);
    await teamAlerts(new Request("https://x.test/api/cron/team-alerts", { headers: { authorization: "Bearer secret" } }));
    expect(alerts.deliver).not.toHaveBeenCalled();
  });
});
