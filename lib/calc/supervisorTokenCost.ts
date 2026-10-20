/** Pure per-response OpenAI token accounting. Costs are integer millionths of
 * USD (micros) for telemetry; business money still uses integer cents.
 * Rates are effective USD per million tokens configured for this model/tier.
 * Never infer missing usage, cached rates, or a provider invoice total.
 */
export type ModelTokenUsage={
  inputTokens:number;cachedInputTokens:number;uncachedInputTokens:number;
  outputTokens:number;reasoningOutputTokens:number;
};
export type ModelTokenRates={input:string|undefined;cachedInput:string|undefined;output:string|undefined};
const whole=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0?n:null;
function decimalMicros(rate:string|undefined):bigint|null {
  if(!rate||!rate.trim())return null;
  const match=/^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if(!match)return null;
  const micros=BigInt(match[1])*1_000_000n+BigInt((match[2]??"").padEnd(6,"0"));
  return micros<=1_000_000_000n?micros:null;
}
export function modelTokenUsage(raw:unknown):ModelTokenUsage|null {
  if(!raw||typeof raw!=="object")return null;
  const value=raw as Record<string,unknown>, input=whole(value.input_tokens),output=whole(value.output_tokens);
  if(input===null||output===null)return null;
  const details=value.input_tokens_details;
  const cached=details&&typeof details==="object"?
    whole((details as Record<string,unknown>).cached_tokens)??0:0;
  const outputDetails=value.output_tokens_details;
  const reasoning=outputDetails&&typeof outputDetails==="object"?
    whole((outputDetails as Record<string,unknown>).reasoning_tokens)??0:0;
  if(cached>input||reasoning>output)return null;
  return {inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:input-cached,
    outputTokens:output,reasoningOutputTokens:reasoning};
}
export function estimateModelCallCostMicros(usage:ModelTokenUsage,rates:ModelTokenRates):number|null {
  const input=decimalMicros(rates.input),output=decimalMicros(rates.output);
  const cached=usage.cachedInputTokens?decimalMicros(rates.cachedInput):0n;
  if(input===null||output===null||cached===null)return null;
  const numerator=BigInt(usage.uncachedInputTokens)*input+
    BigInt(usage.cachedInputTokens)*cached+BigInt(usage.outputTokens)*output;
  const rounded=(numerator+500_000n)/1_000_000n;
  return rounded<=BigInt(Number.MAX_SAFE_INTEGER)?Number(rounded):null;
}
export type ModelCallCostRecord={model:string;requestName:string;inputTokens:number;
  cachedInputTokens:number;outputTokens:number;reasoningOutputTokens:number;
  estimatedCostMicros:number|null;callCount?:number};
export function aggregateModelCallCosts(rows:readonly ModelCallCostRecord[]){
  const counts={modelCalls:rows.length,inputTokens:0,cachedInputTokens:0,outputTokens:0,
    reasoningOutputTokens:0,estimatedCostMicros:0 as number|null,unpricedCalls:0};
  const byModel:Record<string,{calls:number;inputTokens:number;cachedInputTokens:number;
    outputTokens:number;estimatedCostMicros:number|null;unpricedCalls:number}>={};
  for(const row of rows){
    counts.inputTokens+=row.inputTokens;counts.cachedInputTokens+=row.cachedInputTokens;
    counts.outputTokens+=row.outputTokens;counts.reasoningOutputTokens+=row.reasoningOutputTokens;
    const model=byModel[row.model]??={calls:0,inputTokens:0,cachedInputTokens:0,
      outputTokens:0,estimatedCostMicros:0,unpricedCalls:0};
    model.calls++;model.inputTokens+=row.inputTokens;
    model.cachedInputTokens+=row.cachedInputTokens;model.outputTokens+=row.outputTokens;
    if(row.estimatedCostMicros===null){
      counts.estimatedCostMicros=null;counts.unpricedCalls++;
      model.estimatedCostMicros=null;model.unpricedCalls++;
    }else{
      if(counts.estimatedCostMicros!==null)counts.estimatedCostMicros+=row.estimatedCostMicros;
      if(model.estimatedCostMicros!==null)model.estimatedCostMicros+=row.estimatedCostMicros;
    }
  }
  return {...counts,byModel};
}

/** Pricing snapshot from https://developers.openai.com/api/docs/pricing
 * (standard, short-context, 2026-10-19). Unknown tiers/models require
 * explicitly configured rates; this is NOT authoritative billing.
 * Long-context billing, priority/fast, data residency and other discounts
 * must never silently reuse standard short-context rates.
 */
export function standardModelTokenRates(model:string,serviceTier:unknown,
  inputTokens:number):ModelTokenRates|null {
  if(serviceTier!==null&&serviceTier!==undefined&&
    !["default","auto","standard"].includes(String(serviceTier)))return null;
  if(inputTokens>272_000)return null;
  const rates:Record<string,{input:string;cachedInput:string;output:string}>={
    "gpt-6-luna":{input:"0.10",cachedInput:"0.01",output:"0.50"},
    "gpt-6-sol":{input:"2.00",cachedInput:"0.20",output:"10.00"},
    "gpt-6-astra":{input:"10.00",cachedInput:"1.00",output:"50.00"},
  };
  return rates[model]??null;
}
