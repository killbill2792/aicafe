/** Admission limits protect transport and server slices, not business intent.
 * Let a completed answer finish immediately; allow further evidence when needed.
 * The trusted legacy paid runner retains its original caps exactly. */
import {PRODUCTION_SUPERVISOR_OPENAI_MODEL} from "@/lib/ai/conversations/modelConfig";
export type ExecutionBudget={maxElapsedMs:number;maxModelCalls:number;maxToolCalls:number;maxInputTokens:number;maxOutputTokens:number};
export type ExecutionPolicy={elapsedMs:number;maxWorkCalls:number;maxToolCalls:number;maxTurnOutput:number;
 maxWorkOutput:number;finalReserve:number;finalTimeReserve:number};
export function executionPolicy(model:string,worker:ExecutionBudget|undefined,legacyPaid:boolean):ExecutionPolicy{
 const luna=model===PRODUCTION_SUPERVISOR_OPENAI_MODEL;
 const adaptive=luna&&!legacyPaid;
 // Retain the existing 60s bounded execution slice; durable continuation uses
 // the same run identity. Do not extend an active HTTP lease past its deadline.
 const elapsedMs=Math.min(60000,worker?.maxElapsedMs??60000);
 const maxTurnOutput=Math.min(luna?(adaptive?32768:25000):Number.MAX_SAFE_INTEGER,worker?.maxOutputTokens??Infinity);
 const finalReserve=adaptive?Math.min(8192,Math.max(1,Math.floor(maxTurnOutput/3))):1200;
 return {elapsedMs,maxWorkCalls:Math.max(0,Math.min(adaptive?7:5,(worker?.maxModelCalls??Infinity)-1)),
  maxToolCalls:Math.min(adaptive?24:8,worker?.maxToolCalls??Infinity),
  maxTurnOutput,maxWorkOutput:luna&&!worker?16384:adaptive?8192:1200,finalReserve,
  finalTimeReserve:Math.min(12000,Math.floor(elapsedMs/5))};
}
export function remainingOutput(policy:ExecutionPolicy,spent:number,final:boolean):number{
 return Math.max(0,policy.maxTurnOutput-spent-(final?0:Math.min(policy.finalReserve,policy.maxTurnOutput)));
}
export function requestOutputCap(policy:ExecutionPolicy,spent:number,final:boolean,transportCap=Infinity):number{
 return Math.max(0,Math.min(final?policy.finalReserve:policy.maxWorkOutput,transportCap,remainingOutput(policy,spent,final)));
}

/** No raw response, query, IDs, arguments or private evidence in these receipts.
 * Non-reasoning output is NOT necessarily visible text (it can include calls).
 * Missing usage stays null, rather than fabricated zero or a guessed tariff. */
export type ProviderUsageReceipt={
 kind:"responses"|"hosted_web";model:string|null;requestedModel:string;outcome:"completed"|"incomplete"|"failed";
 final:boolean;nativeSearch:boolean;outputCap:number;durationMs:number;
 inputTokens:number|null;cachedTokens:number|null;outputTokens:number|null;reasoningTokens:number|null;
 nonReasoningTokens:number|null;estimatedCostMicros:number|null;discoveryCalls:number|null;
};
export type ToolUsageReceipt={name:string;durationMs:number;resultBytes:number;returnedRows:number|null;outcome:"complete"|"partial"|"failed"};
import {estimateModelCallCostMicros,standardModelTokenRates,hostedWebActualCostMicros} from "@/lib/calc/supervisorTokenCost";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const count=(value:unknown):number|null=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=10_000_000?value:null;
const modelId=(value:unknown):string|null=>typeof value==="string"&&/^[A-Za-z0-9._:-]{1,80}$/.test(value)?value:null;
export function providerUsageReceipt(p:{requestedModel:string;kind:ProviderUsageReceipt["kind"];outcome:ProviderUsageReceipt["outcome"];final:boolean;
 nativeSearch:boolean;outputCap:number;durationMs:number;response?:unknown}):ProviderUsageReceipt{
 const response=record(p.response),usage=record(response.usage);
 const input=count(usage.input_tokens),output=count(usage.output_tokens);
 const cachedRaw=count(record(usage.input_tokens_details).cached_tokens);
 const reasoningRaw=count(record(usage.output_tokens_details).reasoning_tokens);
 const cached=cachedRaw!==null&&input!==null&&cachedRaw<=input?cachedRaw:null;
 const reasoning=reasoningRaw!==null&&output!==null&&reasoningRaw<=output?reasoningRaw:null;
 const model=modelId(response.model),rates=model&&input!==null?standardModelTokenRates(model,response.service_tier,input):null;
 const tokenCost=rates&&input!==null&&output!==null&&cached!==null?
  estimateModelCallCostMicros({inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:input-cached,
    outputTokens:output,reasoningOutputTokens:reasoning??0},rates):null;
 const items=Array.isArray(response.output)?response.output:null;
 return {kind:p.kind,model,requestedModel:modelId(p.requestedModel)??"unknown",outcome:p.outcome,
  final:p.final,nativeSearch:p.nativeSearch,outputCap:p.outputCap,durationMs:p.durationMs,
  inputTokens:input,cachedTokens:cached,outputTokens:output,reasoningTokens:reasoning,
  nonReasoningTokens:reasoning===null||output===null?null:output-reasoning,
  estimatedCostMicros:p.kind==="hosted_web"?hostedWebActualCostMicros(tokenCost,items):tokenCost,
  discoveryCalls:items?items.filter(i=>record(i).type==="tool_search_call").length:null};
}
