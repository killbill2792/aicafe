import { ZodError } from "zod";
import {redactToolFailure,redactedErrorStack} from "./redactToolError";
import {safeToolError} from "./toolErrors";
import {createHash} from "node:crypto";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { agentToolDefinitions, agentLabelsPrompt, agentForTool, executeAgentTool, type AgentToolContext, type AgentToolResult } from "./tools";
import { statusFromResults } from "./status";
import { checkNumbers,numberProvenance,compactEvidence,type NumericEvidence } from "./checkNumbers";
import {usageEvidenceRefresh} from "./usageEvidence";
import { STYLE_RULES } from "./style";
import {newResolveState,observeToolResult,resolveOwnerPeriod,localizedPeriodLabel} from "./resolve";
import {acceptedExplainLines,type ExplainLine} from "./explain";
import {verifiedRecommendedPriceInReply} from "./pricingReply";
import {injectSavedOwnerInputs,formatSavedOwnerFacts,type SavedFact} from "@/lib/ownerFacts/inject";
import {classifyNeedsAsk} from "@/lib/ownerFacts/needsAsk";
import {questionFromReasons} from "@/lib/ownerFacts/questions";
import {withoutSavedFactFields} from "@/lib/ownerFacts/askGuard";

export type EndReason = "complete" | "budget" | "timeout" | "provider_error" | "tool_errors";
type ToolCall = { type: "function_call"; name: string; arguments: string; call_id: string };
type Event = { type: string; [key: string]: unknown };
export type AgentProvider = (params: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<Event>;
export type AgentAuditStep = { kind: "model_call" | "tool_call" | "approval_card" | "memory"; toolName?: string;
  inputSummary?: string; outputSummary?: string; durationMs: number; error?: string };
export type AgentTurn = { text: string; endReason: EndReason; status: ReturnType<typeof statusFromResults>;
  unverified: ReturnType<typeof checkNumbers>; provenance?:ReturnType<typeof numberProvenance>; results: AgentToolResult[]; evidence?: NumericEvidence[]; explain?:ExplainLine[]; tools?:string[]; agentIds?:string[];
  usage: { modelCalls: number; toolCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; latencyMs: number; model?:string };
  /** Owner messages sent while this turn ran and read by the model before a later step. */
  absorbedOwnerMessageIds?: string[] };
/** A message the owner sent while the turn was running. */
export type OwnerFollowUp = { id: string; text: string };
/** Stable instruction prefix. Style rules are appended (not per-turn data), so the
 * whole prefix stays identical across turns and cafés and is served from cache. */
export function agentInstructions(): string {
  return SYSTEM_PROMPT + "\n" + STYLE_RULES + "\n" + agentLabelsPrompt;
}
export function agentPromptCacheKey(): string { return "cafe-agent-v4"; }
export const SYSTEM_PROMPT = "You help an independent cafe owner in their language. Be concise, truthful, helpful. The owner may answer any missing business fact using ask_owner. Use saved owner facts on every turn and never ask again for an already saved fact unless the owner changes it. If any requested fact is empty, failed or uncertain, give the partial answer and call ask_owner; do not refuse or direct the owner to connect a POS. Alex, Leo, Maya and Olivia are names for you; you are one assistant with all tools. Never say you can\'t reach or contact a teammate. Answer staff, schedule, money and supplies questions directly with the tools. Use tools for business facts. Never invent numbers, missing data or completed actions. When a tool result says needsOwnerChoice or two or more products, people, categories, or periods fit and affect numbers or proposals, call ask_owner with verified options (value = candidate ID returned by a tool; label = candidate name with optional price or size suffix), show Other for remaining matches, and stop. Never guess silently. If one candidate clearly fits, do not ask. Never ask in plain text when ask_owner fits. When suggest_new_item_price returns askOwnerRequired, call ask_owner with 2–4 exact candidate pairs from that result and allowOther=true. Answer first, then the key numbers. Be as short as the question allows. Put all working (cost, labor, fees, margin, sources) only in the collapsed How I got this block from trusted tool explanations. The price breakdown is UI-only: NEVER list its components in the chat reply. For follow-up pricing math, re-call suggest_new_item_price with the same owner item inputs. Use tool numbers. Compute business math only through tools; for any what-if or multi-step calculation call simulate_scenario first. Do not do arithmetic in prose beyond simple addition or subtraction of checked tool numbers. Missing inputs narrow an answer; they do not block a partial estimate. Never ask for a figure a tool returned. Say Estimate or You told me next to each affected number once. Give the best labeled answer and say what is needed to make it exact. Label owner-provided figures as You told me, and model estimates as Estimate. Imported prices are approximate observations, never verified list prices; disclose priceCheck differences. If priceCheck is unknown, do not claim a verified comparison. If a tool result has coverageLabel, say the numbers are for that window, not the period asked. Tool money values are integer cents; show them in the café currency. If a tool returns a safe error code, tell the owner its specific reason and next step. On incomplete evidence explain what is known and missing. For questions about what needs attention, use get_attention_items as the sole source of attention tasks; never infer attention from staff, schedule or sales readings. If there are no attention items, say nothing needs attention. If attendanceTracked is false, explain the gap and ask the owner about attendance with ask_owner; never report zero clocked in. A missing confirmed weekly schedule means no schedule is set, not that coverage gaps are confirmed. Any requested or agreed change, including yes, do it, approve or send it, must invoke its propose_* tool in the same turn, so an approval card appears. Do not claim a card or a change unless that tool succeeded. Mapping: price -> propose_price_change; price test -> propose_price_experiment; goal or target (e.g. sales or average ticket up X%) -> propose_goal, how a goal is going -> get_goal_status; an answer to a goal check-in -> record_checkin; supplies -> propose_purchases; weekly schedule -> draft_week_schedule then propose_schedule; one shift -> propose_shift_change; hire -> propose_add_staff; staff edit or retire -> propose_staff_change; availability -> propose_availability_change; labor rule -> propose_rule_change; send team schedule -> propose_send_schedule. A schedule table in text requires propose_schedule, too. A what-if is simulate_scenario only, until the owner asks to act. A proposal is not a completed action; say 'I have drafted this for your approval.' Photos explicitly attached by an owner may describe purchases; draft individual proposals for each item using propose_purchases, never silently write them. Do not invent missing units or costs. For owner-approved schedules, messages are NEVER dispatched by AI. Explain that the owner must open their own WhatsApp or SMS composer. A recorded Opened action is NOT proof of delivery. No JSON envelope.";

export async function* openAIProvider(params: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<Event> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal, headers: { Authorization: "Bearer " + (process.env.OPENAI_API_KEY ?? ""),
      "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok || !response.body) {
    console.error("supervisor_provider_error",{model:String(params.model??"unknown"),status:response.status});
    throw new Error("provider_error");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const line = frame.split(/\r?\n/).find(part => part.startsWith("data: "));
        if (!line || line === "data: [DONE]") continue;
        try { yield JSON.parse(line.slice(6)) as Event; } catch { /* malformed event does not discard turn */ }
      }
    }
  } finally { reader.releaseLock(); }
}

export async function runAgentTurn(args: {
  ownerText: string; ownerImages?:readonly {mimeType:string;base64:string}[];
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context: AgentToolContext; provider?: AgentProvider; onDelta?: (delta: string) => void;
  onReset?: (discardChars: number) => void;
  now?: () => number; onTool?: (name:string,agentId:string)=>void;
  previousEvidence?:readonly NumericEvidence[];
  /** owner-approved café facts, already capped and formatted. Sent as
   * the first input item (stable per café, so it also caches) — never in instructions. */
  memoryFacts?: string | null;
  /** Versioned café-specific facts are separate from approved conversation memory. */
  ownerFacts?: readonly SavedFact[];
  /** True when the authenticated fact read failed; never confuse with zero saved facts. */
  ownerFactsReadFailed?:boolean;
  /** Approved scope for privacy-safe error audit. */
  businessId?:string;requestId?:string;
  /** Extra strict tool definitions (e.g. the memory tool). */
  extraTools?: readonly unknown[];
  /** returns up to `max` owner follow-ups not yet read (each exactly once).
   * Called before each later model step; failures are ignored (unread messages then
   * get their own continuation turn). */
  takeFollowUps?: (max: number) => Promise<OwnerFollowUp[]>;
  onFollowUp?: (count: number) => void;
  /** Redacted, synchronous event collector. Never persists while the loop is running. */
  onAuditStep?: (step: AgentAuditStep) => void;
}): Promise<AgentTurn> {
  if(!args.context.timezone)throw new Error("cafe_timezone_required");
  const now = args.now ?? Date.now, started = now(), deadline = started + 60000;
  const workDeadline = deadline - 12000; // reserve time for the final no-tool answer
  const controller = new AbortController();
  const provider = args.provider ?? openAIProvider;
  const localDay=new Date(args.context.asOf+"T12:00:00Z");
  const weekday=new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:"UTC"}).format(localDay);
  const input: unknown[] = [
    ...(args.memoryFacts ? [{ role: "developer", content: args.memoryFacts }] : []),
    ...(args.ownerFacts?.length ? [{role:"developer",content:formatSavedOwnerFacts(args.ownerFacts)}] : []),
    {role:"developer",content:"Café local date: "+args.context.asOf+" ("+weekday+"), timezone "+
      args.context.timezone+"; weeks start Monday"},
    ...(args.history ?? []), { role: "user", content:args.ownerImages?.length?
      [{type:"input_text",text:args.ownerText},...args.ownerImages.map(image=>({
        type:"input_image",image_url:"data:"+image.mimeType+";base64,"+image.base64,detail:"low"
      }))]:args.ownerText }];
  const absorbed: OwnerFollowUp[] = [];
  // Mark inbox messages answered only when a model response has completed.
  const deliveredIds = new Set<string>();
  // Reads queued owner messages into the conversation before the next model step.
  const readFollowUps = async (): Promise<number> => {
    if (!args.takeFollowUps || absorbed.length >= 5 || now() >= workDeadline) return 0;
    let fresh: OwnerFollowUp[] = [];
    const remaining = workDeadline - now();
    if (remaining <= 0) return 0;
    let inboxTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messages = await Promise.race([
        args.takeFollowUps(5 - absorbed.length),
        new Promise<never>((_, reject) => {
          inboxTimer = setTimeout(() => reject(new Error("inbox_deadline")), remaining);
        }),
      ]);
      if (now() >= workDeadline) return 0;
      fresh = messages.filter(m => m.text.trim() && !absorbed.some(a => a.id === m.id));
    } catch { return 0; }
    finally { clearTimeout(inboxTimer); }
    for (const message of fresh) {
      absorbed.push(message);
      input.push({ role: "user", content: message.text });
    }
    if (fresh.length) args.onFollowUp?.(fresh.length);
    return fresh.length;
  };
  const resolveState=newResolveState(args.ownerText,args.history);
  args.context.resolveState=resolveState;
  args.context.ownerMessages=(args.history??[]).filter(m=>m.role==="user").map(m=>m.content);
  // Tool context is authenticated; owner facts are loaded once per turn.
  Object.assign(args.context,{savedOwnerFacts:args.ownerFacts??[]});
  const results: Array<{callId: string; name: string; arguments: string; result: AgentToolResult}> = [];
  if(args.ownerFactsReadFailed)results.push({callId:'owner-facts-read',name:'owner_facts',arguments:'{}',
    result:{source:'owner_facts',period:null,missing:['ownerFactsReadFailed'],error:'owner_facts_read_failed'}});
  const startedTools: string[] = [];
  const usage = { modelCalls: 0, toolCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, latencyMs: 0, model: undefined as string|undefined };
  let text = "", endReason: EndReason = "complete", failures = 0, finished = false;
  let askedQuestion:string|null=null;
  const model = configuredSupervisorModel();
  const audit = (step: AgentAuditStep) => { try { args.onAuditStep?.(step); } catch { /* audit is non-critical */ } };
  const request = (final: boolean) => ({
    model, instructions: agentInstructions(),
    tools: [...agentToolDefinitions, ...(args.extraTools ?? [])],
    tool_choice: final ? "none" : "auto", stream: true,
    max_output_tokens: 1200, prompt_cache_key: agentPromptCacheKey(), input,
  });
  const call = async (final: boolean) => {
    const calls: ToolCall[] = [], output: unknown[] = [];
    const callTextStart = text.length;
    const modelStart = now();
    let modelError: string | undefined;
    let completed = false;
    const remaining = (final ? deadline : workDeadline) - now();
    if (remaining <= 0) throw new Error("deadline");
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      usage.modelCalls++;
      for await (const event of provider(request(final), controller.signal)) {
        if (now() >= (final ? deadline : workDeadline)) throw new Error("deadline");
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
          args.onDelta?.(event.delta);
        }
        if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as { type?: string };
          output.push(item);
          if (item.type === "function_call") calls.push(item as ToolCall);
        }
        if (event.type === "response.completed") {
          const actual=(event.response as {model?:unknown}|undefined)?.model;
          if(typeof actual==="string"&&actual.trim())usage.model=actual;
          completed = true;
          const u = (event.response as { usage?: { input_tokens?: number; output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number } } } | undefined)?.usage;
          usage.inputTokens += u?.input_tokens ?? 0;
          usage.outputTokens += u?.output_tokens ?? 0;
          usage.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
        }
        if (event.type === "response.failed" || event.type === "error") throw new Error("provider_error");
      }
      if (!completed) throw new Error("provider_incomplete");
      input.push(...output);
      // A tool-only response is not an answer. Keep those follow-ups unclaimed
      // until a completed text response can be persisted.
      if (!calls.length && text.length > callTextStart)
        for (const message of absorbed) deliveredIds.add(message.id);
      return calls;
    } catch (error) {
      modelError = "model_call_failed";
      const discardChars = text.length - callTextStart;
      if (discardChars > 0) {
        text = text.slice(0, callTextStart); // allowed: discard incomplete model stream on provider failure
        args.onReset?.(discardChars);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      audit({ kind: "model_call", inputSummary: final ? "Final response; no tools" : "Model request; prompts withheld",
        outputSummary: completed ? "Completed" : "Incomplete", durationMs: Math.max(0, now() - modelStart), error: modelError });
    }
  };
  try {
    for (let round = 0; round < 5; round++) {
      if (now() >= workDeadline) { endReason = "timeout"; break; }
      if (round > 0) await readFollowUps();
      let calls: ToolCall[];
      try { calls = await call(false); }
      catch { endReason = now() >= workDeadline || controller.signal.aborted ? "timeout" : "provider_error"; break; }
      if (!calls.length) {
        // The owner added something while this answer streamed: answer it in the
        // same reply (one extra bounded call) instead of silently dropping it.
        if (round < 4 && usage.modelCalls < 5 && await readFollowUps()) {
          if (text && !text.endsWith("\n")) { text += "\n\n"; // allowed: separator between model responses to live follow-ups
             args.onDelta?.("\n\n"); }
          continue;
        }
        finished = true; break;
      }
      for (let index = 0; index < calls.length; index++) {
        const tool = calls[index];
        if (usage.toolCalls >= 8 || now() >= workDeadline || failures >= 2) {
          endReason = now() >= workDeadline ? "timeout" : failures >= 2 ? "tool_errors" : "budget";
          for (const skipped of calls.slice(index)) {
            const error = endReason === "timeout" ? "deadline_exceeded" : endReason === "tool_errors" ? "tool_errors" : "budget_exceeded";
            input.push({ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ error }) });
            results.push({ callId: skipped.call_id, name: skipped.name, arguments: skipped.arguments,
              result: { source: skipped.name, period: null, missing: [error] } });
          }
          break;
        }
        usage.toolCalls++;
        startedTools.push(tool.name);
        args.onTool?.(tool.name,agentForTool(tool.name));
        let result: AgentToolResult;
        const toolStart = now();
        let toolError: string | undefined;
        let toolTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const parsedArgs=JSON.parse(tool.arguments);
          const questionArgs=tool.name==="ask_owner"?
            withoutSavedFactFields(parsedArgs,args.ownerFacts??[]):parsedArgs;
          result = await Promise.race([questionArgs===null?
            Promise.resolve({source:"ask_owner",period:null,missing:["alreadySaved"],
              error:"ownerFactAlreadySaved"} as AgentToolResult):
            executeAgentTool(tool.name,injectSavedOwnerInputs(questionArgs,args.ownerFacts??[],
              Boolean((agentToolDefinitions.find(d=>d.name===tool.name)?.parameters as {
                properties?:Record<string,unknown>}|undefined)?.properties?.ownerInputs)),args.context),
            new Promise<never>((_, reject) => {
              const left = workDeadline - now();
              if (left <= 0) reject(new Error("deadline"));
              else toolTimer = setTimeout(() => reject(new Error("deadline")), left);
            })]);
          failures = 0;
        } catch (error) {
          failures++;
          const failedPeriod=(()=>{
            try{
              const input=JSON.parse(tool.arguments) as Record<string,unknown>;
              const candidate=input.period??(typeof input.from==="string"&&typeof input.to==="string"?
                {from:input.from,to:input.to}:null);
              if(!candidate)return null;
              const resolved=resolveOwnerPeriod(candidate as import("@/lib/calc/periods").PeriodInput,
                {asOf:args.context.asOf,timezone:args.context.timezone},resolveState);
              return resolved.status==="resolved"?resolved.value:null;
            }catch{return null;}
          })();
          const periodContext=failedPeriod?failedPeriod.from+" – "+failedPeriod.to:undefined;
          const mapped = safeToolError(error,now() >= workDeadline,{
            source:tool.name,locale:args.context.locale,period:periodContext});
          if(error instanceof ZodError||error instanceof SyntaxError)mapped.code="validation";
          const detail={error:mapped.code,reason:mapped.reason};
          const diagnostic=redactToolFailure(error,mapped.code);
          if(mapped.code!=="validation")console.error("agent_tool_failure",{
            tool:tool.name,code:mapped.code,errorMessage:diagnostic,
            stack:redactedErrorStack(error),
            cafeHash:createHash("sha256").update(args.businessId??"unknown").digest("hex").slice(0,12),
            requestId:args.requestId??"none",
          });
          result = { source: tool.name,
            period:failedPeriod?{from:failedPeriod.from,to:failedPeriod.to}:null,
            missing: [detail.error],what:mapped.what, ...detail };
          toolError = diagnostic;
        } finally { clearTimeout(toolTimer); }
        // A rejected model-generated global cost card must still trigger the
        // code-owned recovery with a scoped item key (or a generic question).
        if(tool.name==="ask_owner"&&result.error==="invalidFactFields"){
          try{
            const attempted=JSON.parse(tool.arguments) as {fields?:Array<{key?:string}>};
            if(attempted.fields?.some(f=>f.key==="unitCostCents"||f.key==="unit_cost_cents")){
              result={...result,missing:["unitCostCents"]};
            }
          }catch{ /* malformed arguments already have a safe error result */ }
        }
        let argumentKeys: string[] = [];
        try {
          const parsed: unknown = JSON.parse(tool.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            argumentKeys = Object.keys(parsed).filter(key => /^[a-zA-Z_]{1,40}$/.test(key)).slice(0, 12);
        } catch { /* invalid JSON already handled above */ }
        audit({ kind: "tool_call", toolName: tool.name,
          inputSummary: "Argument fields: " + (argumentKeys.join(", ") || "none"),
          outputSummary: toolError ? "Tool failed" : result.missing.length ? "Missing input(s)" : "Completed",
          durationMs: Math.max(0, now() - toolStart), error: toolError });
        if (result.draft === true && result.saved === false) {
          audit({ kind: result.source === "memory_proposal" ? "memory" : "approval_card",
            toolName: tool.name, inputSummary: "Draft request", outputSummary: "Awaiting owner approval", durationMs: 0 });
        }
        // A supplies locale-neutral labelKey; C renders it for chat, including
        // the distinct latest-covered-data fallback, without changing the dates.
        try{
          const parsed=JSON.parse(tool.arguments) as Record<string,unknown>;
          const choice=parsed.period??(typeof parsed.from==="string"&&typeof parsed.to==="string"?
            {from:parsed.from,to:parsed.to}:null);
          if(choice&&result.period&&typeof result.period==="object"){
            const resolved=resolveOwnerPeriod(choice as import("@/lib/calc/periods").PeriodInput,
              {asOf:args.context.asOf,timezone:args.context.timezone},resolveState);
            if(resolved.status==="resolved"){
              const actual=result.period as {from:string;to:string};
              const key=result.coverageFallback?"periodLatestData":resolved.value.labelKey;
              const period={...actual,labelKey:key};
              result={...result,periodLabelKey:key,
                periodLabel:localizedPeriodLabel(period,args.context.locale)};
            }
          }
        }catch{ /* Invalid tool arguments already have a localized failure. */ }
        results.push({ callId: tool.call_id, name: tool.name, arguments: tool.arguments, result });
        observeToolResult(resolveState,result);
        input.push({ type: "function_call_output", call_id: tool.call_id, output: JSON.stringify(result) });
        // The old pricing-only choice card sent amounts as chat text and lost
        // them in later threads. Use the universal structured fact card instead.
        if(tool.name==="suggest_new_item_price"&&result.askOwnerRequired===true&&
           !resolveState.asked){
          const candidates=Array.isArray(result.candidates)?result.candidates:[];
          const missingFacts=[
            ...(candidates.some(candidate=>candidate&&typeof candidate==="object"&&
              candidate.id==="labor-monthly")?["monthly_payroll_cents"]:[]),
            ...(candidates.some(candidate=>candidate&&typeof candidate==="object"&&
              candidate.id==="bills-monthly")?["monthly_bills_cents"]:[])
          ];
          if(missingFacts.length){
            const cardInput=questionFromReasons(missingFacts.map(key=>({
              kind:"missing" as const,key,tool:"new_item_price"
            })),[result],args.ownerText,args.context.locale,args.ownerFacts??[]);
            if(cardInput){
              const card=await executeAgentTool("ask_owner",cardInput,args.context);
              if(card.missing.length===0){
                results.push({callId:"structured-pricing-owner-card",name:"ask_owner",
                  arguments:"{}",result:card});
                startedTools.push("ask_owner");
                askedQuestion=cardInput.question;finished=true;
                break;
              }
            }
          }
        }
        if(tool.name==="ask_owner"&&result.missing.length===0&&typeof result.question==="string"){
          askedQuestion=result.question;finished=true;
          for(const skipped of calls.slice(index+1))input.push({type:"function_call_output",call_id:skipped.call_id,output:JSON.stringify({error:"ask_owner_ends_turn"})});
          break;
        }
        if (now() >= workDeadline || failures >= 2) {
          endReason = now() >= workDeadline ? "timeout" : "tool_errors";
          // Respond to all calls already returned in this response before the next request.
          for (const skipped of calls.slice(index + 1)) {
            input.push({ type: "function_call_output", call_id: skipped.call_id,
              output: JSON.stringify({ error: endReason === "timeout" ? "deadline_exceeded" : "tool_errors" }) });
            results.push({ callId: skipped.call_id, name: skipped.name, arguments: skipped.arguments,
              result: { source: skipped.name, period: null, missing: [endReason === "timeout" ? "deadline_exceeded" : "tool_errors"] } });
          }
          break;
        }
      }
      if(askedQuestion){if(!text.trim()){text=askedQuestion; // allowed: empty-reply fill
       }break;}
      if (endReason !== "complete") break;
      if (round === 4 || usage.toolCalls >= 8) { endReason = "budget"; break; }
    }
    if (!finished && endReason === "complete") endReason = "budget";
    if (!finished && usage.modelCalls < 6 && now() < deadline) {
      await readFollowUps();
      // Exactly one final no-tool request; never allow another model tool call.
      // Recovery is bounded even after provider disconnect/incomplete response.
      try {
        const finalController = new AbortController();
        const left = deadline - now();
        if (left <= 0) { endReason = "timeout"; }
        else {
          const timeout = setTimeout(() => finalController.abort(), left);
          const finalTextStart = text.length;
          const finalStart = now();
          let completed = false;
          let finalError: string | undefined;
          try {
            usage.modelCalls++;
            for await (const event of provider(request(true), finalController.signal)) {
              if (event.type === "response.failed" || event.type === "error") throw new Error("provider_error");
              if (now() >= deadline) throw new Error("deadline");
              if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta; args.onDelta?.(event.delta);
              }
              if (event.type === "response.completed") {
                const actual=(event.response as {model?:unknown}|undefined)?.model;
                if(typeof actual==="string"&&actual.trim())usage.model=actual;
                completed = true;
                const u = (event.response as {usage?:{input_tokens?:number;output_tokens?:number;input_tokens_details?:{cached_tokens?:number}}}|undefined)?.usage;
                usage.inputTokens += u?.input_tokens ?? 0; usage.outputTokens += u?.output_tokens ?? 0;
                usage.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
              }
            }
            if (!completed) throw new Error("provider_incomplete");
            if (text.length > finalTextStart)
              for (const message of absorbed) deliveredIds.add(message.id);
          } catch (error) {
            finalError = "model_call_failed";
            const discardChars = text.length - finalTextStart;
            if (discardChars > 0) {
              text = text.slice(0, finalTextStart); // allowed: discard incomplete model stream on provider failure
              args.onReset?.(discardChars);
            }
            throw error;
          } finally {
            clearTimeout(timeout);
            audit({ kind: "model_call", inputSummary: "Final response; no tools",
              outputSummary: completed ? "Completed" : "Incomplete", durationMs: Math.max(0, now() - finalStart), error: finalError });
          }
        }
      } catch { endReason = now() >= deadline ? "timeout" : "provider_error"; }
    }
  } finally { controller.abort(); }
  // The response contract is enforced in code, not dependent on model compliance:
  // partial tool data may be used, but missing/empty/failed evidence must end in
  // an actionable, persisted owner question unless that exact fact is already saved.
  if(!results.some(r=>r.name==="ask_owner"&&r.result.missing.length===0)){
    const collected=results.map(r=>r.result);
    const reasons=classifyNeedsAsk(collected,text,args.ownerText);
    const cardInput=questionFromReasons(reasons,collected,args.ownerText,args.context.locale,args.ownerFacts??[]);
    if(cardInput){
      // A malformed model ask must not suppress the code-generated recovery card.
      resolveState.asked=false;
      const card=await executeAgentTool("ask_owner",cardInput,args.context);
      if(card.missing.length===0){
        results.push({callId:"automatic-owner-card",name:"ask_owner",arguments:"{}",result:card});
        startedTools.push("ask_owner"); // Internal recovery, not an extra model tool call.
        if(!text.trim()){text=String(card.question); // allowed: empty-reply fill
        }
      }
    }
  }
  usage.latencyMs = now() - started;
  const status = statusFromResults(results);
  const ownerStatements=[...(args.history??[]).filter(m=>m.role==="user").map(m=>m.content),
    args.ownerText,...absorbed.map(m=>m.text)].join("\n");
  const toolResults=results.map(r=>r.result);
  const verificationResults=usageEvidenceRefresh(toolResults,args.previousEvidence);
  const unverified=checkNumbers(text,ownerStatements,verificationResults,args.context.locale,args.previousEvidence);
  const evidence=compactEvidence(verificationResults);
  const candidates=toolResults.flatMap(result=>Array.isArray(result.explain)?
    result.explain.slice(0,12).filter((line):line is ExplainLine=>
      Boolean(line)&&typeof line==="object"&&"source" in line&&typeof line.source==="string")
      .map(line=>({...line,...(typeof result.periodLabelKey==="string"&&line.period?
        {periodLabelKey:result.periodLabelKey}:{})})):[]);
  const priceResult=toolResults.find(r=>r.source==="new_item_price");
  const price=typeof priceResult?.recommendedPriceCents==="number"&&
    verifiedRecommendedPriceInReply(text,priceResult.recommendedPriceCents,
      args.context.locale,unverified,args.context.currency)?priceResult.recommendedPriceCents:null;
  const accepted=acceptedExplainLines(candidates,evidence,text,unverified,args.context.locale,price);
  // The deterministic milk adapter's inputs, results and formulas come ONLY
  // from existing shared calculators, not model prose. Preserve all verified
  // per-size workings even if the model never repeated the intermediate cost.
  const milkExplain=toolResults.flatMap(r=>r.source==="milk_swap"&&r.missing.length===0&&
    Array.isArray(r.explain)?r.explain.filter((line):line is ExplainLine=>
      Boolean(line)&&typeof line==="object"&&"source" in line&&line.source==="milk_swap") :[]);
  const explain=[...accepted,...milkExplain.filter(line=>!accepted.some(x=>
    x.source===line.source&&x.label===line.label&&JSON.stringify(x.result)===JSON.stringify(line.result)))];
  const finalUnverified=checkNumbers(text,ownerStatements,verificationResults,args.context.locale,args.previousEvidence);
  return { text, endReason, status,
    unverified:finalUnverified,
    provenance:numberProvenance(text,ownerStatements,verificationResults,args.context.locale,args.previousEvidence,finalUnverified),
    evidence,explain,
    tools:[...new Set(startedTools)],agentIds:[...new Set(startedTools.map(name=>agentForTool(name)))],
    results:toolResults, usage,
    ...(deliveredIds.size ? { absorbedOwnerMessageIds: [...deliveredIds] } : {}) };
}
