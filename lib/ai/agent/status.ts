import type { AgentToolResult } from "./tools";

export type AgentStatus = { status: "complete" | "partial"; missing: string[] };
/** Only terminal results count: a failed attempt followed by success is recovered. */
export function statusFromResults(results: readonly { callId: string; result: AgentToolResult }[]): AgentStatus {
  const latest = new Map(results.map(({ callId, result }) => [callId, result]));
  const missing = [...new Set([...latest.values()].flatMap(result => result.missing))];
  return { status: missing.length === 0 ? "complete" : "partial", missing };
}
