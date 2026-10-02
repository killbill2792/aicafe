import type { BusinessSnapshot } from "@/lib/data/types";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { pricingTask, type AgentId, type OperatingTask } from "@/lib/operating/tasks";

export type TeamMemberState = { agentId: AgentId; attentionCount: number; statusKey: "prices" | "coverage_clear" | "supplies" | "attention" };
export type OperationsTeamViewModel = { members: TeamMemberState[]; needsYou: OperatingTask[]; handled: OperatingTask[]; watching: OperatingTask[] };

export function projectOperatingTasks(tasks: OperatingTask[]): OperationsTeamViewModel {
  const needsYou = tasks.filter((task) => task.status === "needs_owner" || task.status === "needs_response");
  const handled = tasks.filter((task) => task.status === "handled");
  const watching = tasks.filter((task) => task.status === "watching");
  const attention = (agentId: AgentId) => needsYou.filter((task) => task.agentId === agentId).reduce((count, task) =>
    count + (task.kind === "data_quality" && typeof task.payload.missingCostCount === "number" ? task.payload.missingCostCount : 1), 0);
  return { members: [
    { agentId: "alex", attentionCount: attention("alex"), statusKey: "prices" },
    { agentId: "olivia", attentionCount: attention("olivia"), statusKey: "coverage_clear" },
    { agentId: "maya", attentionCount: attention("maya"), statusKey: "supplies" },
    { agentId: "leo", attentionCount: attention("leo"), statusKey: "attention" },
  ], needsYou, handled, watching };
}

/** Presentation projection only. All numbers originate in existing deterministic engines. */
export function buildOperationsTeamViewModel(snapshot: BusinessSnapshot, menu: MenuControlItem[], now = new Date()): OperationsTeamViewModel {
  const pricing = menu.flatMap((item) => {
    if (!item.pricing) return [];
    const task = pricingTask({ businessId: snapshot.business.id, itemId: item.id, itemName: item.sizeLabel ? `${item.baseName} · ${item.sizeLabel}` : item.name, result: item.pricing, now });
    return task ? [task] : [];
  });
  const missing = snapshot.runningCostLines.filter((line) => line.isMissing);
  const leoTasks: OperatingTask[] = missing.length ? [{ id: `data:${snapshot.monthKey}:costs`, businessId: snapshot.business.id, agentId: "leo", kind: "data_quality", status: "needs_owner", payload: { missingCostCount: missing.length, firstMissingCostCode: missing[0].categoryCode }, confidence: "high", evidence: [{ source: "BusinessSnapshot", facts: { missingCostCount: missing.length } }], createdAt: now.toISOString() }] : [];
  const maya: OperatingTask = { id: `supplies:${snapshot.monthKey}`, businessId: snapshot.business.id, agentId: "maya", kind: "supply_check", status: "watching", payload: { inventoryQuantityAvailable: false }, confidence: "high", evidence: [{ source: "CafeState", facts: { inventoryAvailable: false } }], createdAt: now.toISOString() };
  return projectOperatingTasks([...pricing, ...leoTasks, maya]);
}
