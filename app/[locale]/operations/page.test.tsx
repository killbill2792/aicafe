import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperatingTask } from "@/lib/operating/tasks";

const mocks = vi.hoisted(() => ({ readInbox: vi.fn(), store: vi.fn(), sync: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (ns: string) => (key: string, params?: Record<string, unknown>) =>
    ns + "." + key + (params ? JSON.stringify(params) : ""),
}));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href }: { children: ReactNode; href: unknown }) =>
  createElement("a", { href: typeof href === "string" ? href : JSON.stringify(href) }, children) }));
vi.mock("@/components/shared/PageShell", () => ({ default: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
// Render every card of every tab; filtering is TeamInbox's own (separately tested) job.
vi.mock("@/components/operations/TeamInbox", () => ({ default: ({ cards, members, staffRulesLink }: {
  cards: { id: string; status: string; node: ReactNode }[]; members: { agentId: string; attentionCount: number }[]; staffRulesLink: ReactNode }) =>
  createElement("div", { "data-counts": JSON.stringify(Object.fromEntries(members.map((m) => [m.agentId, m.attentionCount]))) },
    staffRulesLink, cards.map((card) => createElement("section", { key: card.status + card.id, "data-tab": card.status }, card.node))) }));
vi.mock("@/components/operations/AITeamCard", () => ({ AgentAvatar: () => null,
  agentVisuals: new Proxy({}, { get: () => ({ accent: "", softSurface: "", border: "" }) }) }));
vi.mock("@/components/operations/PriceReviewActions", () => ({ default: () => null }));
vi.mock("@/components/operations/ExperimentReportActions", () => ({ default: () => null }));
vi.mock("@/components/operations/OwnerWhatsAppAlerts", () => ({ default: () => null }));
vi.mock("@/components/shared/EstimatePill", () => ({ default: () => null }));
vi.mock("@/lib/auth/requireUser", () => ({ requireOwnBusiness: async () => ({ id: "owner" }) }));
vi.mock("@/lib/ai/conversations/auth.server", () => ({ authenticatedConversationContext: async () => { throw new Error("no"); } }));
vi.mock("@/lib/data/getSnapshot", () => ({ getSnapshot: async () => ({ business: { id: "cafe", currency: "USD" }, todayDateStr: "2026-11-04" }) }));
vi.mock("@/lib/data/getMenuControlCenter", () => ({ getMenuControlCenter: async () => [] }));
vi.mock("@/lib/data/operatingTasks", () => ({ storeDerivedOperatingTask: mocks.store, syncAndGetOperatingTasks: mocks.sync }));
vi.mock("@/lib/attention/getAttentionItems.server", () => ({ readInbox: mocks.readInbox }));
vi.mock("@/components/home/chatStartAttention", () => ({ topChatStartItems: () => ({}) }));

import OperationsPage from "./page";

const base = { businessId: "cafe", confidence: "high" as const, evidence: [], createdAt: "2026-11-02T15:00:00Z" };
const plan: OperatingTask = { ...base, id: "event-plan:2026-11-05", agentId: "alex", kind: "event_plan", entityType: "event_day",
  entityId: "2026-11-05", status: "needs_owner", payload: { needsApproval: true, businessDate: "2026-11-05", threadId: "t1" } };
const note: OperatingTask = { ...base, id: "note", agentId: "alex", kind: "event_plan", entityType: "event_day", entityId: "2026-11-02",
  status: "watching", payload: { midRun: true, businessDate: "2026-11-02", changePercent: 95, note: "Sales so far are 95% above usual." } };
const brief: OperatingTask = { ...base, id: "daily-brief:2026-11-03:o", agentId: "leo", kind: "daily_brief", status: "watching",
  payload: { businessDate: "2026-11-02", text: "Good morning. Yesterday: sales $1,358.44.", threadId: "t2" } };
const pastPlan: OperatingTask = { ...plan, id: "event-plan:2026-10-31", entityId: "2026-10-31", status: "expired",
  payload: { ...plan.payload, businessDate: "2026-10-31", expiredReason: "past_day" }, resolvedAt: "2026-10-31T23:59:59.000Z" };
const attention = (id: string, agentId: "alex" | "olivia", subjectDate: string | null) => ({ id, kind: "x", source: "x", agentId,
  title: { key: "k", params: {} }, displayTitle: "Title " + id, actionLabel: "Fix", href: "/fix", impactCents: 1250, subjectDate,
  createdAt: "2026-11-03T20:00:00Z" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readInbox.mockResolvedValue({
    items: [{ ...attention(plan.id, "alex", "2026-11-05") }, attention("alert:new", "olivia", "2026-11-03")],
    tasks: { needsYou: [plan], watching: [note, brief], handled: [pastPlan] },
    expiredAlerts: [attention("alert:old", "olivia", "2026-10-28")],
  });
});

async function render() {
  const html = renderToStaticMarkup(await OperationsPage({ searchParams: Promise.resolve({}) }));
  const tab = (status: string) => [...html.matchAll(new RegExp(`<section data-tab="${status}">([\\s\\S]*?)</section>`, "g"))].map((m) => m[1]);
  return { html, tab };
}

describe("Operations inbox cards", () => {
  it("never writes on page load", async () => {
    await render();
    expect(mocks.readInbox).toHaveBeenCalledTimes(1);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("gives an event plan its own text with its date, age and status, never staff or cup-cost text", async () => {
    const [card] = (await render()).tab("needs_you");
    expect(card).toContain('Operations.eventPlanReview{&quot;date&quot;:&quot;Thu, Nov 5&quot;}');
    expect(card).toContain("Operations.eventPlanDetail");
    expect(card).toContain('Operations.cardSubjectDay{&quot;day&quot;:&quot;Thu, Nov 5&quot;}');
    expect(card).toContain('Operations.cardAge{&quot;days&quot;:2}');
    expect(card).toContain("Operations.cardNeedsYou");
    expect(card).not.toContain("staffTaskReason");
    expect(card).not.toContain("mayaWatching");
  });

  it("dates the brief by its business day and shows the live note's number", async () => {
    const watching = (await render()).tab("watching").join("");
    expect(watching).toContain('Operations.briefTaskTitle{&quot;day&quot;:&quot;Mon, Nov 2&quot;}');
    expect(watching).toContain('Operations.cardSalesVsUsual{&quot;pct&quot;:95}');
    expect(watching).toContain("Operations.cardWatching");
  });

  it("shows expired plans and past-shift alerts under Handled with the reason and no action button", async () => {
    const handled = (await render()).tab("handled");
    expect(handled).toHaveLength(2);
    expect(handled.join("")).toContain('Operations.cardExpired{&quot;reason&quot;:&quot;Operations.expiredPastDay&quot;}');
    expect(handled[1]).toContain('Operations.cardSubjectDay{&quot;day&quot;:&quot;Wed, Oct 28&quot;}');
    expect(handled[1]).not.toContain('href="/fix"');
  });

  it("shows a Needs-you alert's date and amount in the café currency", async () => {
    const alert = (await render()).tab("needs_you")[1];
    expect(alert).toContain('Operations.cardSubjectDay{&quot;day&quot;:&quot;Tue, Nov 3&quot;}');
    expect(alert).toContain('Operations.cardImpact{&quot;amount&quot;:&quot;$12.50&quot;}');
  });

  it("team-card counts add up to the Needs-you tab, which is the reader's list", async () => {
    const { html, tab } = await render();
    const counts = JSON.parse(html.match(/data-counts="([^"]*)"/)![1].replaceAll("&quot;", '"')) as Record<string, number>;
    expect(counts).toEqual({ alex: 1, olivia: 1, maya: 0, leo: 0 });
    expect(tab("needs_you")).toHaveLength(2);
  });

  it("links to the Experiments page", async () => {
    expect((await render()).html).toContain('href="/operations/experiments"');
  });
});
