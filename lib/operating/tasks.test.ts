import { describe, expect, it } from "vitest";
import { getPricingProfile } from "@/lib/pricing/profiles";
import { suggestPrice } from "@/lib/calc/pricingEngine";
import { NoAIProvider } from "@/lib/ai/providers/noAI";
import { agentForSignal, agentForTask, applyTaskResponse, expireUnansweredTask, pricingTask, staffCoverageTask, supplyCheckTask } from "./tasks";
import { UnavailableStaffCommunicationProvider } from "./staffCommunication";

const now = new Date("2026-10-02T12:00:00Z");
describe("shared operating tasks", () => {
  it("routes domains to the owner-facing teammate", () => {
    expect(agentForTask("price_review")).toBe("alex"); expect(agentForTask("staff_coverage")).toBe("olivia"); expect(agentForTask("supply_check")).toBe("maya"); expect(agentForTask("money_update")).toBe("leo");
    expect(agentForSignal({ id: "x", type: "DATA_INCOMPLETE", severity: "warning", confidence: "high", evidence: [], dataQuality: { level: "high", missingInputs: [], estimatedInputs: [], staleInputs: [] } })).toBe("leo");
  });
  it("builds Alex's task only from PricingEngine output", () => {
    const result = suggestPrice({ productCostCents: 180, currentPriceCents: 550, recipeStatus: "READY", profile: getPricingProfile("ESPRESSO_DRINK"), posSignal: { daysWithSalesInWindow: 0, windowDays: 90, totalOrdersInWindow: 0, itemUnitsSoldInWindow: 0, monthlyRevenueCents: 0 }, economics: null, categoryPeers: null });
    const task = pricingTask({ businessId: "b", itemId: "latte", itemName: "16 oz Latte", result, now });
    expect(task?.payload.suggestedPriceCents).toBe(result.recommendedPriceCents); expect(task?.evidence[0].source).toBe("PricingEngine");
  });
  it("does not call staff coverage handled until confirmed coverage is applied", () => {
    const task = staffCoverageTask({ businessId: "b", employeeId: "j", employeeName: "Jose", shiftDate: "2026-10-02", scheduledStart: "09:00", delayedStart: "10:00", delayMinutes: 60, now });
    const no = applyTaskResponse(task, { taskId: task.id, responseCode: "no", respondentId: "m", respondedAt: now.toISOString() }); expect(no.status).toBe("needs_response");
    const yes = applyTaskResponse(task, { taskId: task.id, responseCode: "yes", respondentId: "m", respondentName: "Maria", respondedAt: now.toISOString() }); expect(yes.status).toBe("needs_owner"); expect(yes.payload.scheduleApplied).toBe(false);
    const applied = applyTaskResponse(yes, { taskId: task.id, responseCode: "apply_coverage", respondedAt: now.toISOString() }); expect(applied.status).toBe("handled"); expect(applied.payload.scheduleApplied).toBe(true);
  });
  it("expires unanswered requests without inventing acceptance", () => {
    const task = staffCoverageTask({ businessId: "b", employeeId: "j", employeeName: "Jose", shiftDate: "2026-10-02", scheduledStart: "09:00", delayedStart: "10:00", delayMinutes: 60, now });
    expect(expireUnansweredTask(task, new Date("2026-10-02T13:01:00Z"), new Date("2026-10-02T13:00:00Z")).status).toBe("expired");
  });
  it("stores only qualitative supply confirmation, never a quantity", () => {
    const task = supplyCheckTask({ businessId: "b", itemId: "cups", itemName: "Large cups", reason: "Price changed", now });
    const updated = applyTaskResponse(task, { taskId: task.id, responseCode: "getting_low", respondentId: "m", respondedAt: now.toISOString() });
    expect(updated.status).toBe("watching"); expect(updated.payload.qualitativeStatus).toBe("getting_low"); expect(updated.payload.inventoryQuantityAvailable).toBe(false);
  });
  it("keeps deterministic tasks usable with no AI or communication transport", async () => {
    expect(await new NoAIProvider().isAvailable()).toBe(false); const transport = new UnavailableStaffCommunicationProvider(); expect(await transport.isAvailable()).toBe(false); expect((await transport.deliverCoverageRequest({} as never, { employeeId: "m", destination: "+1" })).delivered).toBe(false);
  });
});
