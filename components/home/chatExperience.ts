import type { ConversationMessage } from "@/lib/ai/conversations/contracts";
import type { AgentJob, AgentJobStep } from "@/lib/ai/agent/jobState";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type ChatLocale = "en" | "es" | "ar";
const dict = { en, es, ar } as const;
export type ChatExperienceCopy = (typeof en)["ChatExperience"];
export function chatExperienceCopy(locale: ChatLocale): ChatExperienceCopy {
  return dict[locale].ChatExperience;
}

/** Owner messages that already have an answer: the one each reply names, plus
 * any follow-ups that were folded into that same reply mid-run. */
export function answeredOwnerMessageIds(messages: ConversationMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "supervisor") continue;
    const grounding = message.grounding as Record<string, unknown> | null | undefined;
    if (typeof grounding?.ownerMessageId === "string") ids.add(grounding.ownerMessageId);
    const meta = grounding?.agentMetadata;
    const absorbed = meta && typeof meta === "object" ?
      (meta as { absorbedOwnerMessageIds?: unknown }).absorbedOwnerMessageIds : undefined;
    if (Array.isArray(absorbed)) for (const id of absorbed) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** Owner messages a running job will still answer; never show "failed" for them. */
export function inFlightOwnerMessageIds(job: AgentJob | null, extra: Iterable<string> = []): Set<string> {
  const ids = new Set(extra);
  if (job?.status === "running") {
    ids.add(job.ownerMessageId);
    for (const id of job.inbox) ids.add(id);
    for (const id of job.consumed) ids.add(id);
  }
  return ids;
}

/** One plain line per finished step, oldest first, repeats collapsed. */
export function progressLines(steps: AgentJobStep[], copy: ChatExperienceCopy): string[] {
  const tools = copy.tools as Record<string, string>;
  const agents = copy.agents as Record<string, string>;
  const lines: string[] = [];
  for (const step of steps) {
    const line = tools[step.tool] ?? agents[step.agent] ?? copy.agents.supervisor;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines.slice(-6);
}

/** A single sentence for every known failure; unknown codes get the generic one. */
export function failureLine(code: string | null | undefined, copy: ChatExperienceCopy): string {
  const failures = copy.failures as Record<string, string>;
  return (code && failures[code]) || copy.failures.agent_turn_failed;
}

export type SseFrame = { type: string; data: Record<string, unknown> };
/** Splits a text/event-stream buffer into complete frames plus the unread rest. */
export function readSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let boundary: RegExpExecArray | null;
  while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
    const frame = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary[0].length);
    const lines = frame.split(/\r?\n/);
    const type = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frames.push({ type, data: parsed as Record<string, unknown> });
    } catch { /* a malformed frame is skipped, never fatal */ }
  }
  return { frames, rest: buffer };
}
