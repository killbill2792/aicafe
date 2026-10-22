import type { AgentToolResult } from "./tools";

export type AgentStatus = { status: "complete" | "partial"; missing: string[] };
/** A logical operation is identified by its function name and normalized arguments, not call_id. */
export function statusFromResults(results: readonly {
  callId: string; name: string; arguments: string; result: AgentToolResult;
}[]): AgentStatus {
  const latest = new Map<string, AgentToolResult>();
  for (const attempt of results) {
    let normalized = attempt.arguments;
    try {
      const parsed: unknown = JSON.parse(attempt.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        normalized = JSON.stringify(Object.entries(parsed).sort(([a],[b]) => a.localeCompare(b)));
    } catch { /* malformed JSON is still a distinct logical attempt */ }
    latest.set(attempt.name + ":" + normalized, attempt.result);
  }
  const missing = [...new Set([...latest.values()].flatMap(result => result.missing))];
  return { status: missing.length ? "partial" : "complete", missing };
}
