import type { AgentToolResult } from "./tools";

export type AgentStatus = { status: "complete" | "partial"; missing: string[] };
/** A logical operation is identified by its function name and normalized arguments, not call_id. */
export function statusFromResults(results: readonly {
  callId: string; name: string; arguments: string; result: AgentToolResult;
}[]): AgentStatus {
  const latest = new Map<string, AgentToolResult>();
  for (const attempt of results) latest.set(attempt.name + ":" + attempt.arguments, attempt.result);
  const missing = [...new Set([...latest.values()].flatMap(result => result.missing))];
  return { status: missing.length ? "partial" : "complete", missing };
}
