import type { KnownSlice } from "@/lib/operating/types";
export type CompareDirection="up"|"down"|"unchanged";
export type Comparison = { current:number; previous:number; difference:number;
  changePercent:number|null; direction:CompareDirection };

/** Only deterministic, safe integers; callers must verify FULL metric coverage before comparing. */
export function compareCompleteValues(current:KnownSlice<number>,previous:KnownSlice<number>):KnownSlice<Comparison> {
  const quality={level:"low" as const,
    missingInputs:[...current.quality.missingInputs,...previous.quality.missingInputs,
      ...current.quality.staleInputs,...previous.quality.staleInputs],
    estimatedInputs:[...current.quality.estimatedInputs,...previous.quality.estimatedInputs],
    staleInputs:[] as string[]};
  if(!current.available||!previous.available||quality.missingInputs.length)
    return {available:false,value:null,quality:{...quality,missingInputs:quality.missingInputs.length?
      quality.missingInputs:["comparisonMetricUnavailable"]}};
  if(!Number.isSafeInteger(current.value)||!Number.isSafeInteger(previous.value)) return {
    available:false,value:null,quality:{...quality,missingInputs:["unsafeComparisonNumber"]}};
  const difference=current.value-previous.value;
  if(!Number.isSafeInteger(difference)) return {available:false,value:null,
    quality:{...quality,missingInputs:["unsafeComparisonDifference"]}};
  return {available:true,value:{
    current:current.value,previous:previous.value,difference,
    changePercent:previous.value===0?null:Math.round(difference/Math.abs(previous.value)*10000)/100,
    direction:difference>0?"up":difference<0?"down":"unchanged",
  },quality:{...quality,level:quality.estimatedInputs.length?"medium":"high",missingInputs:[]}};
}
