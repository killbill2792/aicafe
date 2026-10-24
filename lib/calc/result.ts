/** Shared provenance-aware result for partial-data calculators. */
export type CalcProvenance="recorded"|"ownerProvided"|"estimate";
export type CalcInput={name:string;value:number|string|null;provenance:CalcProvenance};
export type CalcTier="full"|"partial"|"floor_only";
export type CalcResult={
  value:number|null;floor:number|null;range:{low:number;high:number}|null;
  tier:CalcTier;inputs:CalcInput[];missing:string[];
};
export function calcResult(input:CalcResult):CalcResult{
  if(input.floor!==null&&input.value===null)throw new Error("A computable floor must yield a value");
  return input;
}
