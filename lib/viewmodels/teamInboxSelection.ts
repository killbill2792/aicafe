import { parseAgentId, type AgentId } from "@/lib/operating/tasks";

export type InboxStatus = "needs_you" | "handled" | "watching";
export const INBOX_STATUSES = ["needs_you", "handled", "watching"] as const satisfies readonly InboxStatus[];

export function parseInboxStatus(value: string | null | undefined): InboxStatus {
  return value === "handled" || value === "watching" ? value : "needs_you";
}

/** Teammate and inbox tab come from the URL, so a shared or reloaded link opens the same view. */
export function readInboxSelection(params: Pick<URLSearchParams, "get">): { agent: AgentId | null; status: InboxStatus } {
  return { agent: parseAgentId(params.get("agent") ?? undefined), status: parseInboxStatus(params.get("status")) };
}

/** Query string after a tap. Tapping the selected teammate again shows the whole team.
 * Other parameters (period, task) are kept. */
export function inboxQueryAfter(current: string, change: { agent: AgentId } | { status: InboxStatus }): string {
  const params = new URLSearchParams(current);
  if ("agent" in change) {
    if (params.get("agent") === change.agent) params.delete("agent");
    else params.set("agent", change.agent);
  } else params.set("status", change.status);
  const query = params.toString();
  return query ? "?" + query : "";
}
