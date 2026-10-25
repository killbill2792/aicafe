import type { AttentionItem } from "@/lib/attention/getAttentionItems.server";
import type { AgentId } from "@/lib/operating/tasks";

export const CHAT_START_AGENTS = ["alex", "leo", "maya", "olivia"] as const satisfies readonly AgentId[];
export type ChatStartAttentionItem = Pick<AttentionItem, "id" | "agentId" | "displayTitle" | "actionLabel" | "href" | "impactCents">;

/** Same shared attention records as Home and chat. Stable ties retain source order. */
export function topChatStartItems(items: readonly ChatStartAttentionItem[]): Partial<Record<AgentId, ChatStartAttentionItem>> {
  const selected: Partial<Record<AgentId, ChatStartAttentionItem>> = {};
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const previous = selected[item.agentId];
    if (!previous || (item.impactCents ?? Number.NEGATIVE_INFINITY) >
      (previous.impactCents ?? Number.NEGATIVE_INFINITY)) selected[item.agentId] = item;
  }
  return selected;
}
