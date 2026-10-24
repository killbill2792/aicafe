import type {AgentToolContext} from "./index";
import {coveredWindow,dateOffset,type CalcPeriod} from "@/lib/calc/periods";
/** Reuses the strictly scoped, actual-sales reader; no new tenant selectors.
 * A missing current window does not imply zero sales. */
export async function resolveCoveredSalesWindow(ctx:AgentToolContext,requested:CalcPeriod):
 Promise<{period:CalcPeriod;label:string|null}>{
 const current=await ctx.tools.getSalesTrend(requested);
 if(current.available&&current.value.length)return {period:requested,label:null};
 const historical=await ctx.tools.getSalesTrend({
   from:dateOffset(requested.to,-364),to:requested.to,
 });
 if(!historical.available||!historical.value.length)return {period:requested,label:null};
 const covered=historical.value.map(day=>day.date);
 const selected=coveredWindow(requested,covered);
 return {period:selected.period,label:selected.label};
}
