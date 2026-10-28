import type {AgentToolContext} from "./index";
import {coveredWindow,dateOffset,type CalcPeriod,type CoverageFallback} from "@/lib/calc/periods";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type CoveredSalesWindow={
 period:CalcPeriod;label:string|null;coverageFallback:CoverageFallback|null;
 todayImported?:boolean;lastFullDay?:string|null;
 lastFullDayTotals?:{netSalesCents:number|null;ordersCount:number|null;drinksCount:number|null}|null;
 dataNote?:string;
};
/** Do not silently substitute historical dates for the period the owner asked for.
 * A separate, labeled last complete day can accompany a missing "today". */
export async function resolveCoveredSalesWindow(ctx:AgentToolContext,requested:CalcPeriod):
 Promise<CoveredSalesWindow>{
 const unchanged={period:requested,label:null,coverageFallback:null};
 if(requested.from!==ctx.asOf||requested.to!==ctx.asOf){
  // Preserve legacy pricing coverage without changing any chat reporting period.
  if(typeof ctx.tools.getSalesTrend!=="function")return unchanged;
  try{
   const current=await ctx.tools.getSalesTrend(requested);
   if(current.available&&current.value.length)return unchanged;
   const history=await ctx.tools.getSalesTrend({
    from:dateOffset(requested.to,-364),to:requested.to,
   });
   if(!history.available||!history.value.length)return unchanged;
   return coveredWindow(requested,history.value.map(day=>day.date));
  }catch{return unchanged;}
 }
 const copy={en,es,ar}[ctx.locale].DataNotes;
 if(typeof ctx.tools.getSalesTrend!=="function")
  return {...unchanged,lastFullDay:null,lastFullDayTotals:null,
   dataNote:copy.todaySalesCheckUnavailable};
 let currentFailed=false,imported=false;
 try{
  const current=await ctx.tools.getSalesTrend(requested);
  if(!current.available&&!current.quality.missingInputs.includes("noCoveredSalesRows"))
   currentFailed=true;
  imported=current.available&&current.value.some(day=>day.date===ctx.asOf);
 }catch{currentFailed=true;}
 if(imported)return {...unchanged,todayImported:true};
 let historicFailed=false;
 let previous:{date:string;netSalesCents?:number|null;ordersCount?:number|null;drinksCount?:number|null}|undefined;
 try{
  const history=await ctx.tools.getSalesTrend({from:dateOffset(ctx.asOf,-364),to:dateOffset(ctx.asOf,-1)});
  if(history.available)previous=[...history.value].filter(day=>day.date<ctx.asOf)
   .sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
  else if(!history.quality.missingInputs.includes("noCoveredSalesRows"))historicFailed=true;
 }catch{historicFailed=true;}
 const amount=previous&&Number.isSafeInteger(previous.netSalesCents)?previous.netSalesCents!:null;
 const formatted=amount===null?"—":new Intl.NumberFormat(ctx.locale,{
  minimumFractionDigits:2,maximumFractionDigits:2}).format(amount/100);
 const note=currentFailed?
  (previous?copy.todaySalesCheckFailedWithHistory.replace("{date}",previous.date).replace("{amount}",formatted):
   copy.todaySalesCheckUnavailable):
  historicFailed?copy.lastFullDayCheckFailed:
  previous?copy.todayNotImported.replace("{date}",previous.date).replace("{amount}",formatted):
   copy.todayNotImportedNoHistory;
 return {...unchanged,...(!currentFailed?{todayImported:false}:{}),
  lastFullDay:previous?.date??null,
  lastFullDayTotals:previous?{netSalesCents:amount,ordersCount:previous.ordersCount??null,
   drinksCount:previous.drinksCount??null}:null,dataNote:note};
}
