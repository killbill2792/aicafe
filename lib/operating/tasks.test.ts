import { describe, expect, it } from "vitest";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { NoAIProvider } from "@/lib/ai/providers/noAI";
import {
  agentForSignal,
  agentForTask,
  applyTaskResponse,
  approveStaffCoverage,
  completeStaffCoverageApplication,
  completeVerifiedPriceApplication,
  expireUnansweredTask,
  pricingTask,
  parseAgentId,
  staffCoverageTask,
  supplyCheckTask,
} from "./tasks";
import { UnavailableStaffCommunicationProvider } from "./staffCommunication";

const now = new Date("2026-10-02T12:00:00Z");
const employeeResponse = (taskId: string, responseCode: "yes" | "no") => ({
  taskId,
  actor: "employee" as const,
  responseCode,
  respondentId: "m",
  respondentName: "Maria",
  respondedAt: now.toISOString(),
});

function coverageTask() {
  return staffCoverageTask({ businessId: "b", employeeId: "j", employeeName: "Jose", shiftDate: "2026-10-02", scheduledStart: "09:00", delayedStart: "10:00", delayMinutes: 60, now });
}

describe("shared operating tasks", () => {
  it("routes domains to the owner-facing teammate", () => {
    expect(agentForTask("price_review")).toBe("alex");
    expect(agentForTask("staff_coverage")).toBe("olivia");
    expect(agentForTask("supply_check")).toBe("maya");
    expect(agentForTask("money_update")).toBe("leo");
    expect(agentForSignal({ id: "x", type: "DATA_INCOMPLETE", severity: "warning", confidence: "high", evidence: [], dataQuality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } })).toBe("leo");
  });

  it("validates teammate navigation and safely rejects unknown agents", () => {
    expect(parseAgentId("alex")).toBe("alex");
    expect(parseAgentId("unknown")).toBeNull();
    expect(parseAgentId(undefined)).toBeNull();
  });

  it("builds Alex's task only from PricingEngine output", () => {
    const result = suggestPrice({ productCostCents: 180, currentPriceCents: 550, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"), posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 }, economics: null, categoryPeers: null });
    const task = pricingTask({ businessId: "b", itemId: "latte", itemName: "16 oz Latte", result, now });
    expect(task?.payload.suggestedPriceCents).toBe(result.recommendedPriceCents);
    expect(task?.payload.calculationMode).toBe(result.calculationMode);
    expect(task?.payload.pricingIsEstimate).toBe(true);
    expect(task?.evidence[0].source).toBe("PricingEngine");
  });

  it("keeps use-price pending until the observed selling price matches", () => {
    const result = suggestPrice({ productCostCents: 180, currentPriceCents: 550, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"), posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 }, economics: null, categoryPeers: null });
    const task = pricingTask({ businessId: "b", itemId: "latte", itemName: "16 oz Latte", result, now })!;
    const accepted = applyTaskResponse(task, { taskId: task.id, actor: "owner", responseCode: "use_price", respondedAt: now.toISOString() });
    expect(accepted.status).toBe("watching");
    expect(accepted.payload.awaitingPriceApplication).toBe(true);
    expect(accepted.payload.priceAppliedToPos).toBe(false);

    const mismatch = completeVerifiedPriceApplication(accepted, { actor: "system", observedPriceCents: result.currentPriceCents, verifiedAt: now.toISOString(), source: "menu_sync" });
    expect(mismatch.status).toBe("watching");
    expect(mismatch.payload.priceAppliedToPos).toBe(false);

    const matching = completeVerifiedPriceApplication(accepted, { actor: "system", observedPriceCents: result.recommendedPriceCents!, verifiedAt: now.toISOString(), source: "menu_sync" });
    expect(matching.status).toBe("handled");
    expect(matching.payload.priceAppliedToPos).toBe(true);
  });

  it("handles keep-current immediately without claiming a POS mutation", () => {
    const result = suggestPrice({ productCostCents: 180, currentPriceCents: 550, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"), posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 }, economics: null, categoryPeers: null });
    const task = pricingTask({ businessId: "b", itemId: "latte", itemName: "16 oz Latte", result, now })!;
    const kept = applyTaskResponse(task, { taskId: task.id, actor: "owner", responseCode: "keep_price", respondedAt: now.toISOString() });
    expect(kept.status).toBe("handled");
    expect(kept.payload.priceAppliedToPos).toBe(false);
  });

  it("keeps employee No awaiting a response", () => {
    expect(applyTaskResponse(coverageTask(), employeeResponse(coverageTask().id, "no")).status).toBe("needs_response");
  });

  it("moves employee Yes to owner review without applying a schedule", () => {
    const confirmed = applyTaskResponse(coverageTask(), employeeResponse(coverageTask().id, "yes"));
    expect(confirmed.status).toBe("needs_owner");
    expect(confirmed.payload.coverageConfirmed).toBe(true);
    expect(confirmed.payload.scheduleApplied).toBe(false);
  });

  it("does not let an employee mark coverage handled", () => {
    const confirmed = applyTaskResponse(coverageTask(), employeeResponse(coverageTask().id, "yes"));
    const attempted = applyTaskResponse(confirmed, { ...employeeResponse(confirmed.id, "yes"), responseCode: "apply_coverage" } as never);
    expect(attempted.status).toBe("needs_owner");
    expect(attempted.payload.scheduleApplied).toBe(false);
  });

  it("does not mark owner approval handled without successful schedule application", () => {
    const confirmed = applyTaskResponse(coverageTask(), employeeResponse(coverageTask().id, "yes"));
    const approved = approveStaffCoverage(confirmed, now.toISOString());
    expect(approved.status).toBe("needs_owner");
    expect(approved.payload.scheduleApplied).toBe(false);
    const failed = completeStaffCoverageApplication(approved, { actor: "system", succeeded: false, completedAt: now.toISOString() });
    expect(failed.status).toBe("needs_owner");
    expect(failed.payload.scheduleApplied).toBe(false);
  });

  it("marks coverage handled only after successful schedule completion", () => {
    const confirmed = applyTaskResponse(coverageTask(), employeeResponse(coverageTask().id, "yes"));
    const approved = approveStaffCoverage(confirmed, now.toISOString());
    const completed = completeStaffCoverageApplication(approved, { actor: "system", succeeded: true, completedAt: now.toISOString(), scheduleActionId: "shift-1" });
    expect(completed.status).toBe("handled");
    expect(completed.payload.scheduleApplied).toBe(true);
    expect(completed.payload.scheduleActionId).toBe("shift-1");
  });

  it("expires unanswered requests without inventing acceptance", () => {
    expect(expireUnansweredTask(coverageTask(), new Date("2026-10-02T13:01:00Z"), new Date("2026-10-02T13:00:00Z")).status).toBe("expired");
  });

  it("stores only qualitative supply confirmation, never a quantity", () => {
    const task = supplyCheckTask({ businessId: "b", itemId: "cups", itemName: "Large cups", reason: "Price changed", now });
    const updated = applyTaskResponse(task, { taskId: task.id, actor: "employee", responseCode: "getting_low", respondentId: "m", respondedAt: now.toISOString() });
    expect(updated.status).toBe("watching");
    expect(updated.payload.qualitativeStatus).toBe("getting_low");
    expect(updated.payload.inventoryQuantityAvailable).toBe(false);
  });

  it("keeps deterministic tasks usable with no AI or communication transport", async () => {
    expect(await new NoAIProvider().isAvailable()).toBe(false);
    const transport = new UnavailableStaffCommunicationProvider();
    expect(await transport.isAvailable()).toBe(false);
    expect((await transport.deliverCoverageRequest({} as never, { employeeId: "m", destination: "+1" })).delivered).toBe(false);
  });
});
