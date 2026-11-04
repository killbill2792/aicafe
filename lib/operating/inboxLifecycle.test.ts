import { describe, expect, it } from "vitest";
import { formatInboxDay, inboxKey, isStaleShiftAlert, settleInboxTasks } from "./inboxLifecycle";
import { projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import type { OperatingTask } from "./tasks";

const NOW = new Date("2026-11-04T18:00:00Z");
const TODAY = "2026-11-04";
const task = (id: string, extra: Partial<OperatingTask>): OperatingTask => ({
  id, businessId: "cafe", agentId: "alex", kind: "event_plan", status: "needs_owner",
  payload: {}, confidence: "high", evidence: [], createdAt: "2026-11-01T15:00:00Z", ...extra,
});
const plan = (day: string) => task("event-plan:" + day, { entityType: "event_day", entityId: day,
  payload: { needsApproval: true, businessDate: day, threadId: "t-" + day }, createdAt: "2026-10-31T15:00:00Z" });
const report = (day: string) => task("supervisor:alex.event_readiness.v1:p-" + day, { entityType: "event_day", entityId: day,
  payload: { text: "**Event-day report**\nSales: actual vs usual", threadId: "t-" + day }, createdAt: day + "T23:00:00Z" });
const note = (day: string) => task("supervisor:alex.event_readiness.v1:p-" + day + ":midrun:" + day, { entityType: "event_day", entityId: day,
  status: "watching", payload: { midRun: true, businessDate: day, changePercent: 95, note: "Sales so far are 95% above usual." } });
const brief = (id: string, day: string, created: string) => task(id, { agentId: "leo", kind: "daily_brief", status: "watching",
  payload: { businessDate: day, text: "Good morning. Yesterday: …" }, createdAt: created });

/** The live Seiyun inbox on Nov 4 (read-only audit): 8 event plans, 3 event reports, 2 notes, briefs. */
const seiyun = [
  ...["2026-10-30", "2026-10-31", "2026-11-02", "2026-11-05", "2026-11-11", "2026-11-13", "2026-11-14", "2026-11-16"].map(plan),
  ...["2026-10-30", "2026-10-31", "2026-11-02"].map(report),
  note("2026-10-31"), note("2026-11-02"),
  brief("daily-brief:2026-10-31", "2026-10-30", "2026-10-31T15:23:00Z"),
  brief("daily-brief:2026-11-03:owner", "2026-11-02", "2026-11-03T13:50:00Z"),
];

describe("inbox lifecycle (read-only)", () => {
  it("leaves only real, open decisions in Needs you", () => {
    const team = projectOperatingTasks(settleInboxTasks(seiyun, null, NOW, TODAY));
    expect(team.needsYou.map((t) => t.entityId).sort()).toEqual(["2026-11-05", "2026-11-11", "2026-11-13", "2026-11-14", "2026-11-16"]);
    expect(team.members.find((m) => m.agentId === "alex")?.attentionCount).toBe(5);
  });

  it("puts event reports, live notes and the latest brief in Watching, never Needs you", () => {
    const team = projectOperatingTasks(settleInboxTasks(seiyun, null, NOW, TODAY));
    expect(team.watching.map((t) => t.id).sort()).toEqual([
      "daily-brief:2026-11-03:owner",
      "supervisor:alex.event_readiness.v1:p-2026-10-30", "supervisor:alex.event_readiness.v1:p-2026-10-31",
      "supervisor:alex.event_readiness.v1:p-2026-11-02",
      "supervisor:alex.event_readiness.v1:p-2026-10-31:midrun:2026-10-31", "supervisor:alex.event_readiness.v1:p-2026-11-02:midrun:2026-11-02",
    ].sort());
  });

  it("moves past-day plans and superseded briefs to Handled as expired, with the reason", () => {
    const handled = projectOperatingTasks(settleInboxTasks(seiyun, null, NOW, TODAY)).handled;
    const reasons = Object.fromEntries(handled.map((t) => [t.id, [t.status, t.payload.expiredReason]]));
    expect(reasons).toEqual({
      "event-plan:2026-10-30": ["expired", "past_day"], "event-plan:2026-10-31": ["expired", "past_day"],
      "event-plan:2026-11-02": ["expired", "past_day"], "daily-brief:2026-10-31": ["expired", "superseded"],
    });
  });

  it("collapses two rows for the same item to the newest one", () => {
    const older = brief("daily-brief:2026-11-02", "2026-11-02", "2026-11-03T13:00:00Z");
    const newer = brief("daily-brief:2026-11-02:owner", "2026-11-02", "2026-11-03T13:50:00Z");
    expect(inboxKey(older)).toBe(inboxKey(newer));
    const settled = settleInboxTasks([older, newer], null, NOW, TODAY);
    expect(settled.map((t) => t.id)).toEqual(["daily-brief:2026-11-02:owner"]);
  });

  it("shows a computed price review that is not stored yet and expires a stored one that no longer applies", () => {
    const review = (id: string): OperatingTask => task(id, { kind: "price_review", entityType: "menu_item", entityId: id,
      payload: { itemName: "Latte", currentPriceCents: 500, suggestedPriceCents: 560 } });
    const settled = settleInboxTasks([review("price:old:500:560")], [review("price:new:500:560")], NOW, TODAY);
    expect(Object.fromEntries(settled.map((t) => [t.id, t.status]))).toEqual({ "price:new:500:560": "needs_owner", "price:old:500:560": "expired" });
  });

  it("expires shift reviews older than three days and keeps recent ones", () => {
    const shift = (day: string) => task("coverage:e1:" + day, { agentId: "olivia", kind: "staff_coverage", status: "needs_response", payload: { shiftDate: day } });
    const settled = settleInboxTasks([shift("2026-10-28"), shift("2026-11-02")], null, NOW, TODAY);
    expect(Object.fromEntries(settled.map((t) => [t.id, t.status]))).toEqual({ "coverage:e1:2026-10-28": "expired", "coverage:e1:2026-11-02": "needs_response" });
    expect(isStaleShiftAlert({ kind: "meal_break", payload: { date: "2026-10-28" } }, TODAY)).toBe(true);
    expect(isStaleShiftAlert({ kind: "meal_break", payload: { date: "2026-11-02" } }, TODAY)).toBe(false);
    expect(isStaleShiftAlert({ kind: "missing_bill", payload: { date: "2026-10-01" } }, TODAY)).toBe(false);
  });

  it("drops handled history after fourteen days", () => {
    const done = task("done", { status: "handled", resolvedAt: "2026-10-01T00:00:00Z" });
    const recent = task("recent", { status: "handled", resolvedAt: "2026-11-01T00:00:00Z" });
    expect(settleInboxTasks([done, recent], null, NOW, TODAY).map((t) => t.id)).toEqual(["recent"]);
  });

  it("formats the subject day as a weekday date, not a relative word", () => {
    expect(formatInboxDay("2026-11-02", "en")).toBe("Mon, Nov 2");
  });
});
