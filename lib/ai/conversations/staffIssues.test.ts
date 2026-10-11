import { describe, expect, it } from "vitest";
import type { OperatingTask } from "@/lib/operating/tasks";
import { validateGroundedReply } from "./replyValidation";
import { answerCurrentStaffIssues, isCurrentStaffIssuesQuestion } from "./staffIssues";

const copy = {
  summary: (needs: number, watching: number) => `Recorded staff coverage: ${needs} need attention, ${watching} watched. Not a complete staffing audit.`,
  none: "No open staff coverage issues recorded in Team. This is not a complete staffing audit.",
  missing: "Staff task records are unavailable; cannot verify staffing.",
  estimated: "Records estimated.",
  taskName: "Staff coverage",
  taskCard: (name: string) => "Staff coverage: " + name,
};
const quality = { level: "high" as const, missingInputs: [], estimatedInputs: [], staleInputs: [] };
function task(id: string, kind: OperatingTask["kind"], status: OperatingTask["status"]): OperatingTask {
  return { id, businessId: "cafe-1", agentId: kind === "staff_coverage" ? "olivia" : "maya",
    kind, status, payload: { employeeName: "Alex" }, confidence: "high",
    evidence: [], createdAt: "2026-10-10T08:00:00Z" };
}
function answer(items: OperatingTask[]) {
  return answerCurrentStaffIssues({ tasks: { available: true, value: items, quality },
    asOf: "2026-10-10T12:00:00.000Z", copy });
}

describe("current staff issue questions bypass the remote planner only when unambiguous", () => {
  it.each([
    ["are there any issues, staff issues right now", "en"],
    ["Any problems with staff today?", "en"],
    ["Are there any staffing shortages?", "en"],
    ["¿Hay problemas con el personal ahora?", "es"],
    ["هل توجد مشاكل في الموظفين الآن؟", "ar"],
  ] as const)("routes %s", (question, locale) => {
    expect(isCurrentStaffIssuesQuestion(question, locale)).toBe(true);
  });
  it.each([
    ["what was the staff issue yesterday?", "en"],
    ["how much does payroll cost?", "en"],
    ["how many employees are scheduled tomorrow?", "en"],
    ["any outstanding supply issues?", "en"],
    ["¿Problemas de nómina del personal?", "es"],
    ["مشاكل رواتب الموظفين", "ar"],
  ] as const)("does not misroute %s", (question, locale) => {
    expect(isCurrentStaffIssuesQuestion(question, locale)).toBe(false);
  });
});

describe("current staff issues only report verified persisted staff coverage", () => {
  it("filters other Team work and resolved staff tasks, links real open staff items", () => {
    const result = answer([
      task("coverage:1", "staff_coverage", "needs_owner"),
      task("coverage:2", "staff_coverage", "needs_response"),
      task("coverage:3", "staff_coverage", "watching"),
      task("coverage:4", "staff_coverage", "handled"),
      task("coverage:5", "staff_coverage", "expired"),
      task("supply:1", "supply_check", "needs_owner"),
    ]);
    expect(result.status).toBe("verified");
    expect(result.blocks[0]).toMatchObject({ type: "text",
      text: expect.stringContaining("2 need attention, 1 watched") });
    expect(result.blocks.filter((block) => block.type === "task_card")).toHaveLength(3);
    expect(result.blocks).toContainEqual(expect.objectContaining({
      type: "task_card", taskId: "coverage:1", agent: "olivia",
      href: "/operations?status=needs_you&agent=olivia",
    }));
    expect(() => validateGroundedReply(result)).not.toThrow();
  });
  it("states the source limitation rather than claiming no staff problems", () => {
    const result = answer([task("other", "supply_check", "needs_owner")]);
    expect(result.blocks).toEqual([{ type: "text", text: copy.none }]);
    expect(result.status).toBe("verified");
    expect(() => validateGroundedReply(result)).not.toThrow();
  });
  it("returns an insufficient-evidence warning rather than fabricated zero on missing or stale tasks", () => {
    const missing = answerCurrentStaffIssues({ tasks: {
      available: false, value: null,
      quality: { ...quality, level: "low", missingInputs: ["operating_tasks"] },
    }, asOf: "2026-10-10T12:00:00Z", copy });
    expect(missing.status).toBe("insufficient_evidence");
    expect(missing.blocks[0]).toMatchObject({ type: "warning", code: "staff_records_unavailable" });
    expect(() => validateGroundedReply(missing)).not.toThrow();
    const stale = answerCurrentStaffIssues({ tasks: { available: true, value: [],
      quality: { ...quality, staleInputs: ["operating_tasks"] } },
      asOf: "2026-10-10T12:00:00Z", copy });
    expect(stale.status).toBe("insufficient_evidence");
  });
});
