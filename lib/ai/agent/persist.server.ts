import { recoverRichPresentation,type RichPresentation } from "@/lib/ai/conversations/presentation";
import "server-only";
import { ZodError } from "zod";
import { persistGroundedSupervisorReply, type DurableReplyFence } from "@/lib/ai/conversations/replyWriter.server";
import { recordSupervisorUsage } from "@/lib/ai/conversations/usage.server";
import type { ConversationMessage, ConversationScope, GroundedSupervisorReply } from "@/lib/ai/conversations/contracts";
import type { AgentTurn } from "./loop.server";
import {explainLineSchema} from "./explain";
import {routineCardSchema,routineDraftSchema} from "@/lib/ai/conversations/contracts";

export class AgentReplyTooLongError extends Error { constructor() { super("agent_reply_too_long"); } }
export class AgentReplyStorageError extends Error { constructor() { super("agent_reply_storage_failed"); } }
export class AgentEmptyReplyError extends Error { constructor() { super("agent_turn_failed"); } }
type GroundingStatus = GroundedSupervisorReply["status"];
export function persistedAgentStatus(turn: AgentTurn): GroundingStatus {
  if(turn.results.some(r=>r.source==="ask_owner"&&r.missing.length===0))
    return "requires_owner_input";
  // Execution state only. Luna owns the assessment of its answer.
  return turn.endReason === "complete" ? "answered" : "interrupted";
}
type Span = { start: number; end: number };
// Protect recorded claims and even *verified* currency tokens from block boundaries.
const moneyToken = /(?:(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار)\s*)?[-+−]?[٠-٩۰-۹\d]+(?:[.,٬٫\u00a0\u202f][٠-٩۰-۹\d]+)*(?:[ \u00a0\u202f]*(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار|[%٪]))?/gu;

/** Preserve every character, preferring paragraphs, lines then whitespace. */
export function splitAgentText(text: string, unverified: readonly Span[] = [],maxBlocks=Infinity) {
  const value = text || " ";
  const protectedSpans: Span[] = [...unverified];
  for (const match of value.matchAll(moneyToken))
    protectedSpans.push({ start: match.index, end: match.index + match[0].length });
  const safe = (at: number) => !protectedSpans.some(span => span.start < at && at < span.end);
  const blocks: Array<{ type: "text"; text: string }> = [];
  let start = 0;
  while (start < value.length) {
    if (blocks.length >= maxBlocks) throw new AgentReplyTooLongError();
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
      // Prefer a natural boundary only if the remainder can fit in the real reply contract.
      const minEnd=Math.max(start+1,value.length-(maxBlocks-blocks.length-1)*1200);
      const fitting=choices.map(items=>items.filter(at=>at>=minEnd));
      const preferred = fitting.find(items => items.length);
      if (preferred) end = preferred[preferred.length - 1];
      else if (!safe(end)) {
        // A >1200-character token may be hard-split, but never through a
        // currency/number claim, even when the adjacent word is oversized.
        while (end > start && !safe(end)) end--;
        if (end === start) end=limit;
      }
    }
    blocks.push({ type: "text", text: value.slice(start, end) });
    start = end;
  }
  return blocks;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function agentReplyPayload(turn: AgentTurn) {
  if (!turn.text.trim()&&!turn.results.some(r=>r.source==="response_presentation"&&r.accepted===true&&recoverRichPresentation(r.presentation)!==undefined)) throw new AgentEmptyReplyError();
  const clarify=turn.results.find(r=>r.source==="ask_owner"&&r.missing.length===0);
  const isOnlyQuestion=clarify&&typeof clarify.question==="string"&&
    turn.text.trim()===clarify.question.trim();
  // The card itself owns the question; avoid showing the identical text twice.
  let blocks:Array<{type:"text";text:string}>=[];
  const proposalIds=[...new Set(turn.results.flatMap(result=>
    (result.source==="price_change_proposal"||result.source==="staff_proposal"||result.source==="purchase_proposal"||
      result.source==="supplier_purchase_proposal"||result.source==="goal_proposal"||result.source==="event_plan_proposal"||
      result.source==="gmail_proposal"||result.source==="staff_question_proposal")&&
      (result.source==="purchase_proposal"||result.missing.length===0)&&result.draft===true&&
      result.saved===false&&
      typeof result.proposalId==="string"&&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.proposalId)
      ?[result.proposalId]:result.source==="purchase_proposal"&&Array.isArray(result.proposals)?
       result.proposals.flatMap(p=>p&&typeof p==="object"&&"proposalId" in p&&typeof p.proposalId==="string"&&UUID.test(p.proposalId)?[p.proposalId]:[]):[]))];
  const experimentIds=[...new Set(turn.results.flatMap(result=>
    result.source==="price_experiment_proposal"&&result.draft===true&&result.saved===false&&
    result.missing.length===0&&typeof result.proposalId==="string"&&UUID.test(result.proposalId)
      ?[result.proposalId]:[]))];
  // Memory cards come only from the memory tool's own draft result (never model text).
  const memoryRuleIds=[...new Set(turn.results.flatMap(result=>
    result.source==="memory_proposal"&&result.draft===true&&
      result.saved===false&&result.missing.length===0&&
      typeof result.ruleId==="string"&&UUID.test(result.ruleId)
      ?[result.ruleId]:[]))];
  // Only a real, successful manage_routine tool receipt can create this
  // interactive saved-state card; do not derive IDs or "success" from prose.
  const savedRoutine=[...turn.results].reverse().flatMap(result=>{
    if(result.source!=="supervisor_routines"||result.missing.length||
      result.error||!result.routine||typeof result.routine!=="object")return [];
    const row=result.routine as Record<string,unknown>;
    const parsed=routineCardSchema.safeParse({
      type:"routine_card",routineId:row.id,title:row.title,
      cadence:row.cadence,weekdays:row.weekdays,localTime:row.localTime,
        ...(row.cadence==="once"?{onceLocalDate:row.onceLocalDate}:{}),
      timezone:row.timezone,status:row.status,revision:row.revision,
    });
    return parsed.success?[parsed.data]:[];
  })[0]??null;
  // An unsaved routine is shown as an approve-first card built only from the tool's own draft receipt.
  const routineDraft=[...turn.results].reverse().flatMap(result=>{
    if(result.source!=="supervisor_routines"||result.draft!==true||result.saved!==false||
      result.missing.length||result.error||!result.routineDraft||typeof result.routineDraft!=="object")return [];
    const parsed=routineDraftSchema.safeParse({type:"routine_draft",...(result.routineDraft as Record<string,unknown>)});
    return parsed.success?[parsed.data]:[];
  })[0]??null;
  const explanation=(turn.explain??[]).flatMap(item=>{
    const parsed=explainLineSchema.safeParse(item);
    return parsed.success?[parsed.data]:[];
  });
  blocks=isOnlyQuestion||!turn.text.trim()?[]:splitAgentText(turn.text,turn.provenance??turn.unverified);
  const safeExplain=explanation;
  const status = persistedAgentStatus(turn);
  const reply: GroundedSupervisorReply = { intent: "unknown", status, evidence: [], blocks:[...blocks,
    ...proposalIds.map(proposalId=>({type:"proposal_card" as const,proposalId})),
    ...experimentIds.map(proposalId=>({type:"experiment_card" as const,proposalId})),
    ...memoryRuleIds.map(ruleId=>({type:"memory_card" as const,ruleId})),
    ...(savedRoutine?[savedRoutine]:[]),
    ...(routineDraft?[routineDraft]:[]),
    ...(clarify&&typeof clarify.question==="string"&&clarify.kind==="facts"&&
      typeof clarify.questionId==="string"&&Array.isArray(clarify.fields)?
     [{type:"clarify" as const,kind:"facts" as const,questionId:clarify.questionId,question:clarify.question,
       ...(clarify.changeSaved===true?{changeSaved:true as const}:{}),
       fields:clarify.fields as {key:string;label:string;inputType:"number"|"money"|"percent"|"text"|"date"|"choice";
         units:string[];defaultUnit:string;choices?:{label:string;value:string}[];
         remember?:"this_question";current?:{value:string;savedOn:string;canForget:boolean}}[]}]:
     clarify&&typeof clarify.question==="string"&&clarify.kind==="fill"&&Array.isArray(clarify.fields)?
     [{type:"clarify" as const,kind:"fill" as const,question:clarify.question,
       fields:clarify.fields as {key:string;label:string;inputType:"number";units:string[];defaultUnit:string}[]}]:
      clarify&&typeof clarify.question==="string"&&Array.isArray(clarify.options)?
       [{type:"clarify" as const,question:clarify.question,
         options:clarify.options as {label:string;value:string}[],allowOther:clarify.allowOther===true}]:[]),
    ...(safeExplain.length?[{type:"how" as const,lines:safeExplain}]:[])] };
  const validatePresentation=(result:AgentTurn["results"][number]):RichPresentation|undefined=>{
    if(result.source!=="response_presentation"||result.accepted!==true)return;
    // The answer's evidence status describes confidence, never which parts of
    // the model-authored UI the owner is allowed to see.
    return recoverRichPresentation(result.presentation);
  };
  // SQL inline views carry their exact position in the concatenated prose.
  // The existing persisted text blocks remain the source for numeric annotations.
  const inline=turn.results.flatMap(result=>{
    const at=result.presentationOffset;
    if(typeof at!=="number"||!Number.isSafeInteger(at)||at<0||at>turn.text.length)return [];
    const block=validatePresentation(result);
    return block?[{at,block}]:[];
  }).sort((a,b)=>a.at-b.at);
  if(inline.length&&!isOnlyQuestion){
    const ordered:GroundedSupervisorReply["blocks"]=[];
    const prose:typeof blocks=[];
    const spans=turn.provenance??turn.unverified;
    let at=0;
    const addText=(end:number)=>{
      if(end===at)return;
      const parts=splitAgentText(turn.text.slice(at,end),spans.filter(s=>s.start<end&&s.end>at).map(s=>({start:s.start-at,end:s.end-at})));
      ordered.push(...parts);prose.push(...parts);at=end;
    };
    try{
      for(const item of inline){addText(item.at);ordered.push(item.block);}
      addText(turn.text.length);
      const tail=reply.blocks.slice(blocks.length);
      blocks=prose;reply.blocks=[...ordered,...tail];
    }catch(error){if(!(error instanceof AgentReplyTooLongError))throw error;}
  }
  {
    // Historical/legacy present_response receipts have no inline position.
    // Preserve every accepted receipt that fits the existing reply contract.
    for(const result of turn.results){
      if(!isOnlyQuestion&&inline.some(item=>item.block===result.presentation||item.at===result.presentationOffset&&JSON.stringify(item.block)===JSON.stringify(result.presentation)))continue;
      const block=validatePresentation(result);
      if(block)reply.blocks.push(block);
    }
  }
  const annotations=turn.provenance??turn.unverified.map(item=>({...item,source:"unchecked" as const}));
  const unverified = annotations.flatMap(item => {
    const rows: Array<typeof item & {blockIndex:number}> = [];
    let offset = 0;
    for (let i = 0; i < blocks.length; i++) {
      const start = Math.max(item.start, offset);
      const end = Math.min(item.end, offset + blocks[i].text.length);
      if (end > start) rows.push({
        ...item, start: start - offset, end: end - offset,
        text: blocks[i].text.slice(start - offset, end - offset), blockIndex: reply.blocks.indexOf(blocks[i]),
      });
      offset += blocks[i].text.length;
    }
    return rows;
  });
  return { reply, metadata: {
    unverified, endReason: turn.endReason, evidence:turn.evidence??[],explain:safeExplain,agentIds:turn.agentIds??[],
    sources: turn.results.map(r => ({ source:r.source, period:r.period, missing:r.missing })),
    ...(typeof turn.externalEvidence==="boolean"?{externalEvidence:turn.externalEvidence}:{}),
    ...(turn.presentationDiagnostics?{presentationDiagnostics:{...turn.presentationDiagnostics,persistedViews:reply.blocks.filter(b=>b.type==="rich_presentation").length}}:{}),
    usage: { modelCalls:turn.usage.modelCalls,toolCalls:turn.usage.toolCalls,inputTokens:turn.usage.inputTokens,cachedTokens:turn.usage.cachedTokens,outputTokens:turn.usage.outputTokens,latencyMs:turn.usage.latencyMs,model:turn.usage.model },
    // Owner messages answered inside this reply (mid-run follow-ups).
    ...(turn.absorbedOwnerMessageIds?.length?{absorbedOwnerMessageIds:[...turn.absorbedOwnerMessageIds]}:{}),
  } };
}
export async function persistAgentReply(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn, durableFence?:DurableReplyFence) {
  const { reply, metadata } = agentReplyPayload(turn);
  let saved: ConversationMessage;
  if(durableFence&&reply.status!=="requires_owner_input"&&turn.endReason!=="complete")throw new AgentEmptyReplyError();
  try { saved = await (durableFence ? persistGroundedSupervisorReply(scope, owner, reply, metadata, durableFence) : persistGroundedSupervisorReply(scope, owner, reply, metadata)); }
  catch (error) {
    // Field paths and issue codes only (never reply text), so a rejected card can be traced.
    const issues = error instanceof ZodError ? error.issues.slice(0, 5).map(i => i.path.join(".") + ":" + i.code) : [];
    const dbCode = !(error instanceof ZodError) && error && typeof error === "object" && "code" in error ? String(error.code) : null;
    console.error("agent_reply_storage_failed", { issues, dbCode });
    throw new AgentReplyStorageError();
  }
  return saved;
}
/** One invocation per model-run turn, including blank and failed persistence.
 * The existing RPC accepts at most five tool calls per increment.
 */
export function agentUsageIncrements(turn: AgentTurn) {
  const calls = turn.usage.toolCalls;
  return Array.from({ length: Math.max(1, Math.ceil(calls / 5)) }, (_, index) => ({
    model: turn.usage.model??"unknown",
    modelCallCount: index === 0 ? turn.usage.modelCalls : 0,
    toolCallCount: Math.min(5, calls - index * 5),
    inputTokens: index === 0 ? turn.usage.inputTokens : 0,
    outputTokens: index === 0 ? turn.usage.outputTokens : 0,
    ...(index===0&&turn.usage.requests?.length===turn.usage.modelCalls?
      {executionMetrics:{requests:turn.usage.requests,tools:turn.usage.toolMetrics??[]}}:{}),
  }));
}
export async function recordAgentTurnUsage(scope: ConversationScope, owner: ConversationMessage, turn: AgentTurn) {
  if (turn.usage.modelCalls < 1 && turn.usage.toolCalls < 1) return;
  for (const usage of agentUsageIncrements(turn)) {
    await recordSupervisorUsage({ scope, threadId: owner.threadId, ownerMessageId: owner.id, usage });
  }
}
