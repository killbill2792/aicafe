import "server-only";
import { persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import type { ConversationMessage, ConversationScope, GroundedSupervisorReply } from "@/lib/ai/conversations/contracts";
import type { AgentTurn } from "./loop.server";

type GroundingStatus = GroundedSupervisorReply["status"];
export function persistedAgentStatus(turn: AgentTurn): GroundingStatus {
  if (!turn.results.length || turn.results.every(result => "error" in result))
    return "unavailable";
  return turn.status.status === "complete" ? "verified" : "partial";
}
/** No truncation. Each block is <= 1,200 characters; DB allows up to 30 blocks. */
export function splitAgentText(text: string) {
  const value = text || " ";
  const blocks: Array<{ type: "text"; text: string }> = [];
  for (let at = 0; at < value.length; at += 1200) {
    if (blocks.length === 30) throw new Error("agent_reply_too_long");
    blocks.push({ type: "text", text: value.slice(at, at + 1200) });
  }
  return blocks;
}
export function agentReplyPayload(turn: AgentTurn) {
  const blocks = splitAgentText(turn.text);
  const status = persistedAgentStatus(turn);
  const reply: GroundedSupervisorReply = { intent: "unknown", status, evidence: [], blocks };
  // The offset is relative to each persisted text block, not the streaming string.
  const unverified = turn.unverified.flatMap(item => {
    const rows: Array<typeof item & {blockIndex:number}> = [];
    for (let i = 0; i < blocks.length; i++) {
      const start = Math.max(item.start, i * 1200), end = Math.min(item.end, (i + 1) * 1200);
      if (end > start) rows.push({
        ...item, start: start - i * 1200, end: end - i * 1200,
        text: blocks[i].text.slice(start - i * 1200, end - i * 1200), blockIndex: i,
      });
    }
    return rows;
  });
  return { reply, metadata: {
    unverified, endReason: turn.endReason,
    sources: turn.results.map(r => ({ source:r.source, period:r.period, missing:r.missing })),
    usage: { ...turn.usage },
  } };
}
export async function persistAgentReply(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn) {
  const { reply, metadata } = agentReplyPayload(turn);
  const saved = await persistGroundedSupervisorReply(scope, owner, reply, metadata);
  try {
    // The existing owner-scoped ledger RPC allows up to five tool calls per
    // increment. Split the eight-tool turn without requiring a migration.
    const total = turn.usage.toolCalls;
    for (let part = 0; part < Math.max(1, Math.ceil(total / 5)); part++) {
      await recordSupervisorUsage({ scope, threadId: owner.threadId, ownerMessageId: owner.id,
        usage: { model: configuredSupervisorModel(),
          modelCallCount: part === 0 ? turn.usage.modelCalls : 0,
          toolCallCount: Math.min(5, total - part * 5),
          inputTokens: part === 0 ? turn.usage.inputTokens : 0,
          outputTokens: part === 0 ? turn.usage.outputTokens : 0 } });
    }
  } catch { /* telemetry failure must not corrupt a persisted reply */ }
  return saved;
}
