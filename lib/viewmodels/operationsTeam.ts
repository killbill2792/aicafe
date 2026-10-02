import type { BusinessSnapshot } from "@/lib/data/types";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { pricingTask, type AgentId, type OperatingTask } from "@/lib/operating/tasks";

export type TeamMemberState = { agentId: AgentId; attentionCount: number; statusKey: "prices" | "coverage_clear" | "supplies" | "attention" };
export type OperationsTeamViewModel = { members: TeamMemberState[]; needsYou: OperatingTask[]; handled: OperatingTask[]; watching: OperatingTask[] };

/** Presentation projection only. All numbers originate in existing deterministic engines. */
export function buildOperationsTeamViewModel(snapshot: BusinessSnapshot, menu: MenuControlItem[], now = new Date()): OperationsTeamViewModel {
  const pricing = menu.flatMap((item) => {
    if (!item.pricing) return [];
    const task = pricingTask({ businessId: snapshot.business.id, itemId: item.id, itemName: item.sizeLabel ? `${item.sizeLabel} ${item.baseName}` : item.name, result: item.pricing, now });
    return task ? [task] : [];
  });
  const missing = snapshot.runningCostLines.filter((line) => line.isMissing);
  const leoTasks: OperatingTask[] = missing.length ? [{ id: `data:${snapshot.monthKey}:costs`, businessId: snapshot.business.id, agentId: "leo", kind: "data_quality", status: "needs_owner", payload: { missingCostCount: missing.length, firstMissingCost: missing[0].label }, confidence: "high", evidence: [{ source: "BusinessSnapshot", facts: { missingCostCount: missing.length } }], createdAt: now.toISOString() }] : [];
  const maya: OperatingTask = { id: `supplies:${snapshot.monthKey}`, businessId: snapshot.business.id, agentId: "maya", kind: "supply_check", status: "watching", payload: { inventoryQuantityAvailable: false }, confidence: "high", evidence: [{ source: "CafeState", facts: { inventoryAvailable: false } }], createdAt: now.toISOString() };
  const needsYou = [...pricing, ...leoTasks];
  return { members: [{ agentId: "alex", attentionCount: pricing.length, statusKey: "prices" }, { agentId: "olivia", attentionCount: 0, statusKey: "coverage_clear" }, { agentId: "maya", attentionCount: 0, statusKey: "supplies" }, { agentId: "leo", attentionCount: missing.length, statusKey: "attention" }], needsYou, handled: [], watching: [maya] };
}
