import type { Confidence, PricingResult } from "@/lib/calc";
import type { CafeSignal } from "./types";

export const AGENT_IDS = ["alex", "olivia", "maya", "leo"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export function parseAgentId(value: string | undefined): AgentId | null {
  return AGENT_IDS.find((agent) => agent === value) ?? null;
}
export type OperatingTaskStatus = "watching" | "needs_response" | "needs_owner" | "handled" | "expired";
export type OperatingTaskKind = "price_review" | "staff_coverage" | "supply_check" | "money_update" | "data_quality";
export type TaskEvidence = { source: string; facts: Record<string, string | number | boolean | null> };
export type OperatingTask = {
  id: string;
  businessId: string;
  agentId: AgentId;
  kind: OperatingTaskKind;
  entityType?: string;
  entityId?: string;
  status: OperatingTaskStatus;
  payload: Record<string, string | number | boolean | null>;
  confidence: Confidence;
  evidence: TaskEvidence[];
  createdAt: string;
  resolvedAt?: string;
};
export type TaskResponseCode = "yes" | "no" | "plenty" | "getting_low" | "almost_out" | "use_price" | "keep_price" | "later";
export type OperatingTaskResponse = {
  taskId: string;
  actor: "employee" | "owner";
  responseCode: TaskResponseCode;
  respondentId?: string;
  respondentName?: string;
  shortText?: string;
  respondedAt: string;
};

export function agentForTask(kind: OperatingTaskKind): AgentId {
  if (kind === "price_review") return "alex";
  if (kind === "staff_coverage") return "olivia";
  if (kind === "supply_check") return "maya";
  return "leo";
}

export function agentForSignal(signal: CafeSignal): AgentId {
  if (["PRICE_REVIEW_REQUIRED", "PRODUCT_COST_CHANGED", "PRODUCT_PROFITABILITY_DECLINED", "PRODUCT_HIGH_CONTRIBUTION"].includes(signal.type)) return "alex";
  if (signal.type === "LABOR_COST_CHANGED") return "olivia";
  if (["INGREDIENT_COST_INCREASED", "SUPPLIER_COST_CHANGED", "INVENTORY_LOW", "STOCKOUT_RISK"].includes(signal.type)) return "maya";
  return "leo";
}

export function pricingTask(params: { businessId: string; itemId: string; itemName: string; result: PricingResult; now?: Date }): OperatingTask | null {
  const { result } = params;
  if (result.status !== "REVIEW_PRICE" || result.recommendedPriceCents === null) return null;
  return {
    id: `price:${params.itemId}:${result.currentPriceCents}:${result.recommendedPriceCents}`,
    businessId: params.businessId,
    agentId: "alex",
    kind: "price_review",
    entityType: "menu_item",
    entityId: params.itemId,
    status: "needs_owner",
    payload: { itemName: params.itemName, currentPriceCents: result.currentPriceCents, suggestedPriceCents: result.recommendedPriceCents, explanationCode: result.explanationCode },
    confidence: result.confidence.toLowerCase() as Confidence,
    evidence: [{ source: "PricingEngine", facts: { productCostCents: result.productCostCents, calculationMode: result.calculationMode, unitsEvidenceAvailable: result.calculationMode !== "BENCHMARK" } }],
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

export function staffCoverageTask(params: { businessId: string; employeeId: string; employeeName: string; shiftDate: string; scheduledStart: string; delayedStart: string; delayMinutes: number; now?: Date }): OperatingTask {
  return { id: `coverage:${params.employeeId}:${params.shiftDate}:${params.scheduledStart}`, businessId: params.businessId, agentId: "olivia", kind: "staff_coverage", entityType: "employee", entityId: params.employeeId, status: "needs_response", payload: { employeeName: params.employeeName, shiftDate: params.shiftDate, scheduledStart: params.scheduledStart, delayedStart: params.delayedStart, delayMinutes: params.delayMinutes, scheduleApplied: false }, confidence: "high", evidence: [{ source: "staff_schedule", facts: { shiftDate: params.shiftDate, scheduledStart: params.scheduledStart } }], createdAt: (params.now ?? new Date()).toISOString() };
}

export function supplyCheckTask(params: { businessId: string; itemId: string; itemName: string; reason: string; now?: Date }): OperatingTask {
  return { id: `supply:${params.itemId}`, businessId: params.businessId, agentId: "maya", kind: "supply_check", entityType: "ingredient_or_packaging", entityId: params.itemId, status: "needs_response", payload: { itemName: params.itemName, reason: params.reason, inventoryQuantityAvailable: false }, confidence: "low", evidence: [{ source: "human_confirmation_requested", facts: { inventoryQuantityAvailable: false } }], createdAt: (params.now ?? new Date()).toISOString() };
}

export function applyTaskResponse(task: OperatingTask, response: OperatingTaskResponse): OperatingTask {
  if (task.status === "handled" || task.status === "expired") return task;
  if (response.taskId !== task.id) return task;
  if (task.kind === "staff_coverage") {
    if (response.actor !== "employee") return task;
    if (response.responseCode === "yes") return { ...task, status: "needs_owner", payload: { ...task.payload, coveringEmployeeId: response.respondentId ?? null, coveringEmployeeName: response.respondentName ?? null, coverageConfirmed: true, scheduleApplied: false } };
    return task;
  }
  if (task.kind === "supply_check" && ["plenty", "getting_low", "almost_out"].includes(response.responseCode)) return { ...task, status: "watching", payload: { ...task.payload, qualitativeStatus: response.responseCode, responderId: response.respondentId ?? null, respondedAt: response.respondedAt } };
  if (task.kind === "price_review" && response.actor === "owner" && response.responseCode === "later") return { ...task, status: "watching" };
  if (task.kind === "price_review" && response.actor === "owner" && ["use_price", "keep_price"].includes(response.responseCode)) return { ...task, status: "handled", payload: { ...task.payload, ownerChoice: response.responseCode, priceAppliedToPos: false }, resolvedAt: response.respondedAt };
  return task;
}

/** Records owner intent only. It cannot claim the schedule domain action succeeded. */
export function approveStaffCoverage(task: OperatingTask, approvedAt: string): OperatingTask {
  if (task.kind !== "staff_coverage" || task.status !== "needs_owner" || task.payload.coverageConfirmed !== true) return task;
  return { ...task, payload: { ...task.payload, ownerApproved: true, ownerApprovedAt: approvedAt, scheduleApplied: false } };
}

/** Called by orchestration only after the real staff/schedule action reports success. */
export function completeStaffCoverageApplication(task: OperatingTask, result: { actor: "system"; succeeded: boolean; completedAt: string; scheduleActionId?: string }): OperatingTask {
  if (task.kind !== "staff_coverage" || task.status !== "needs_owner" || task.payload.ownerApproved !== true || !result.succeeded) return task;
  return { ...task, status: "handled", payload: { ...task.payload, scheduleApplied: true, scheduleActionId: result.scheduleActionId ?? null }, resolvedAt: result.completedAt };
}

export function expireUnansweredTask(task: OperatingTask, now: Date, expiresAt: Date): OperatingTask {
  return task.status === "needs_response" && now >= expiresAt ? { ...task, status: "expired", resolvedAt: now.toISOString() } : task;
}
