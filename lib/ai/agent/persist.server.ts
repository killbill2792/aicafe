import "server-only";
import { persistGroundedSupervisorReply } from "@/lib/ai/conversations/replyWriter.server";
import { recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import type { ConversationMessage, ConversationScope, GroundedSupervisorReply } from "@/lib/ai/conversations/contracts";
import type { AgentTurn } from "./loop.server";

export class AgentReplyTooLongError extends Error { constructor() { super("agent_reply_too_long"); } }
export class AgentReplyStorageError extends Error { constructor() { super("agent_reply_storage_failed"); } }
export class AgentEmptyReplyError extends Error { constructor() { super("agent_turn_failed"); } }
type GroundingStatus = GroundedSupervisorReply["status"];
export function persistedAgentStatus(turn: AgentTurn): GroundingStatus {
  // A completed greeting/clarification does not require a business read.
  if (turn.endReason === "complete" && turn.usage.toolCalls === 0) return "verified";
  const hasSuccessfulRead = turn.results.some(result =>
    result.missing.length === 0 && typeof result.error !== "string");
  if (!hasSuccessfulRead) return "unavailable";
  if (turn.endReason !== "complete") return "partial";
  return turn.status.status === "complete" ? "verified" : "partial";
}
type Span = { start: number; end: number };
// Protect recorded claims and even *verified* currency tokens from block boundaries.
const moneyToken = /(?:(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار)\s*)?[-+−]?[٠-٩۰-۹\d]+(?:[.,٬٫\u00a0\u202f][٠-٩۰-۹\d]+)*(?:[ \u00a0\u202f]*(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار|[%٪]))?/gu;

/** Preserve every character, preferring paragraphs, lines then whitespace. */
export function splitAgentText(text: string, unverified: readonly Span[] = []) {
  const value = text || " ";
  const protectedSpans: Span[] = [...unverified];
  for (const match of value.matchAll(moneyToken))
    protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  const safe = (at: number) => !protectedSpans.some(span => span.start < at && at < span.end);
  const blocks: Array<{ type: "text"; text: string }> = [];
  let start = 0;
  while (start < value.length) {
    if (blocks.length >= 30) throw new AgentReplyTooLongError();
    const limit = Math.min(start + 1200, value.length);
    let end = limit;
    if (limit < value.length) {
      const choices: number[][] = [[], [], []];
      for (let i = start + 1; i < limit; i++) {
        if (!safe(i + 1)) continue;
        if (value[i] === "\n" && value[i - 1] === "\n") choices[0].push(i + 1);
        else if (value[i] === "\n") choices[1].push(i + 1);
        else if (/\s/u.test(value[i])) choices[2].push(i + 1);
      }
      const preferred = choices.find(choices => choices.length);
      if (preferred) end = preferred[preferred.length - 1];
      else if (!safe(end)) {
        // A >1200-character token may be hard-split, but never through a
        // currency/number claim, even when the adjacent word is oversized.
        while (end > start && !safe(end)) end--;
        if (end === start) throw new AgentReplyTooLongError();
      }
    }
    blocks.push({ type: "text", text: value.slice(start, end) });
    start = end;
  }
  return blocks;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function agentReplyPayload(turn: AgentTurn) {
  if (!turn.text.trim()) throw new AgentEmptyReplyError();
  const clarify=turn.results.find(r=>r.source==="ask_owner"&&r.missing.length===0);
  const isOnlyQuestion=clarify&&typeof clarify.question==="string"&&
    turn.text.trim()===clarify.question.trim();
  // The card itself owns the question; avoid showing the identical text twice.
  const blocks=isOnlyQuestion?[]:splitAgentText(turn.text,turn.provenance??turn.unverified);
  const proposalIds=[...new Set(turn.results.flatMap(result=>
    (result.source==="price_change_proposal"||result.source==="staff_proposal")&&result.draft===true&&
      result.saved===false&&result.missing.length===0&&
      typeof result.proposalId==="string"&&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.proposalId)
      ?[result.proposalId]:[]))].slice(0,Math.max(0,29-blocks.length));
  // Memory cards come only from the memory tool's own draft result (never model text).
  const memoryRuleIds=[...new Set(turn.results.flatMap(result=>
    result.source==="memory_proposal"&&result.draft===true&&
      result.saved===false&&result.missing.length===0&&
      typeof result.ruleId==="string"&&UUID.test(result.ruleId)
      ?[result.ruleId]:[]))].slice(0,Math.max(0,29-blocks.length-proposalIds.length));
  const status = persistedAgentStatus(turn);
  const reply: GroundedSupervisorReply = { intent: "unknown", status, evidence: [], blocks:[...blocks,
    ...proposalIds.map(proposalId=>({type:"proposal_card" as const,proposalId})),
    ...memoryRuleIds.map(ruleId=>({type:"memory_card" as const,ruleId})),
    ...(clarify&&typeof clarify.question==="string"&&Array.isArray(clarify.options)?[{type:"clarify" as const,question:clarify.question,options:clarify.options as {label:string;value:string}[],allowOther:clarify.allowOther===true}]:[])] };
  const annotations=turn.provenance??turn.unverified.map(item=>({...item,source:"unchecked" as const}));
  const unverified = annotations.flatMap(item => {
    const rows: Array<typeof item & {blockIndex:number}> = [];
    let offset = 0;
    for (let i = 0; i < blocks.length; i++) {
      const start = Math.max(item.start, offset);
      const end = Math.min(item.end, offset + blocks[i].text.length);
      if (end > start) rows.push({
        ...item, start: start - offset, end: end - offset,
        text: blocks[i].text.slice(start - offset, end - offset), blockIndex: i,
      });
      offset += blocks[i].text.length;
    }
    return rows;
  });
  return { reply, metadata: {
    unverified, endReason: turn.endReason, evidence:turn.evidence??[],agentIds:turn.agentIds??[],
    sources: turn.results.map(r => ({ source:r.source, period:r.period, missing:r.missing })),
    usage: { ...turn.usage },
    // Owner messages answered inside this reply (CHAT_JOBS mid-run follow-ups).
    ...(turn.absorbedOwnerMessageIds?.length?{absorbedOwnerMessageIds:[...turn.absorbedOwnerMessageIds]}:{}),
  } };
}
export async function persistAgentReply(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn) {
  const { reply, metadata } = agentReplyPayload(turn);
  let saved: ConversationMessage;
  try { saved = await persistGroundedSupervisorReply(scope, owner, reply, metadata); }
  catch { throw new AgentReplyStorageError(); }
  return saved;
}
/** One invocation per model-run turn, including blank and failed persistence.
 * The existing RPC accepts at most five tool calls per increment.
 */
export function agentUsageIncrements(turn: AgentTurn) {
  const calls = turn.usage.toolCalls;
  return Array.from({ length: Math.max(1, Math.ceil(calls / 5)) }, (_, index) => ({
    model: configuredSupervisorModel(),
    modelCallCount: index === 0 ? turn.usage.modelCalls : 0,
    toolCallCount: Math.min(5, calls - index * 5),
    inputTokens: index === 0 ? turn.usage.inputTokens : 0,
    outputTokens: index === 0 ? turn.usage.outputTokens : 0,
  }));
}
export async function recordAgentTurnUsage(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn) {
  if (turn.usage.modelCalls < 1) return;
  for (const usage of agentUsageIncrements(turn)) {
    await recordSupervisorUsage({ scope, threadId: owner.threadId, ownerMessageId: owner.id, usage });
  }
}
