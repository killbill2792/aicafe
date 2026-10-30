import type { BusinessSnapshot } from "@/lib/data/types";
import type { AttentionItem } from "@/lib/attention/getAttentionItems.server";
import type { MenuControlItem } from "@/lib/data/getMenuControlCenter";
import { pricingTask, type AgentId, type OperatingTask } from "@/lib/operating/tasks";
import { expectedMissingCostLines } from "@/lib/expenses/expectedCosts";

export type TeamMemberState = { agentId: AgentId; attentionCount: number; statusKey: "prices" | "coverage_clear" | "supplies" | "attention" };
export type OperationsTeamViewModel = { members: TeamMemberState[]; needsYou: OperatingTask[]; handled: OperatingTask[]; watching: OperatingTask[] };

export function projectOperatingTasks(tasks: OperatingTask[]): OperationsTeamViewModel {
  const needsYou = tasks.filter((task) => task.status === "needs_owner" || task.status === "needs_response");
  const handled = tasks.filter((task) => task.status === "handled");
  const watching = tasks.filter((task) => task.status === "watching");
  const attention = (agentId: AgentId) => needsYou.filter((task) => task.agentId === agentId).length;
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
  const missing = expectedMissingCostLines(snapshot.runningCostLines);
  const leoTasks: OperatingTask[] = missing.map((line) => ({ id: `data:${snapshot.monthKey}:cost:${line.categoryCode}`, businessId: snapshot.business.id, agentId: "leo", kind: "data_quality", entityType: "expense_category", entityId: line.categoryCode, status: "needs_owner", payload: { categoryCode: line.categoryCode }, confidence: "high", evidence: [{ source: "BusinessSnapshot", facts: { categoryCode: line.categoryCode, isMissing: true } }], createdAt: now.toISOString() }));
  const maya: OperatingTask = { id: `supplies:${snapshot.monthKey}`, businessId: snapshot.business.id, agentId: "maya", kind: "supply_check", status: "watching", payload: { inventoryQuantityAvailable: false }, confidence: "high", evidence: [{ source: "CafeState", facts: { inventoryAvailable: false } }], createdAt: now.toISOString() };
  return projectOperatingTasks([...pricing, ...leoTasks, maya]);
}

/** One row of the shared attention list (the same records Home counts). */
export type NeedsYouItem = Pick<AttentionItem, "id" | "agentId" | "displayTitle" | "actionLabel" | "href" | "impactCents">;

/** Operations "Needs you" is the shared attention list Home counts, split by teammate; never a
 * second list. A row that is a stored task keeps its task so its own actions stay available. */
export function needsYouFromAttention(items: readonly NeedsYouItem[], tasks: readonly OperatingTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows = items.map((item) => byId.get(item.id) ?? item);
  const count = (agentId: AgentId) => items.filter((item) => item.agentId === agentId).length;
  const counts: Record<AgentId, number> = { alex: count("alex"), olivia: count("olivia"), maya: count("maya"), leo: count("leo") };
  return { rows, counts };
}
