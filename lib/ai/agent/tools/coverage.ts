import type {AgentToolContext} from "./index";
import {coveredWindow,dateOffset,type CalcPeriod,type CoverageFallback} from "@/lib/calc/periods";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export type CoveredSalesWindow={
 period:CalcPeriod;label:string|null;labelKey?:string;labelParams?:{from:string;to:string};coverageFallback:CoverageFallback|null;
 todayImported?:boolean;lastFullDay?:string|null;
 lastFullDayTotals?:{netSalesCents:number|null;ordersCount:number|null;drinksCount:number|null}|null;
 lastRecordedDay?:string|null;
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
   const window=coveredWindow(requested,history.value.map(day=>day.date));
   if(!window.labelKey||!window.labelParams)return window;
   const format=(value:string)=>new Intl.DateTimeFormat(ctx.locale,{
    month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(value+"T12:00:00Z"));
   const template={en,es,ar}[ctx.locale].MetricsNotes.periodLatestData;
   return {...window,label:template.replace("{from}",format(window.labelParams.from))
    .replace("{to}",format(window.labelParams.to))};
  }catch{return unchanged;}
 }
 const copy={en,es,ar}[ctx.locale].DataNotes;
 if(typeof ctx.tools.getSalesTrend!=="function")
  return {...unchanged,lastFullDay:null,lastFullDayTotals:null,
   dataNote:copy.todaySalesCheckUnavailable};
 const onlyNoRows=(keys:readonly string[])=>keys.length===1&&keys[0]==="noCoveredSalesRows";
 let currentFailed=false,imported=false,importUncertain=false;
 try{
  const current=await ctx.tools.getSalesTrend(requested);
  if(!current.available&&!onlyNoRows(current.quality.missingInputs))
   currentFailed=true;
  imported=current.available&&current.value.some(day=>day.date===ctx.asOf);
  importUncertain=imported&&current.quality.missingInputs.some(key=>
   key==="toastDayStatusUnavailable"||key==="toastCheckEvidenceUnavailable"||
   key.startsWith("toastImportIncompleteDays:")||key.startsWith("toastDayStatusMissing:")||
   key.startsWith("toastDaysNeedLook:"));
 }catch{currentFailed=true;}
 if(imported&&importUncertain)return {...unchanged,lastRecordedDay:ctx.asOf,
  lastFullDay:null,lastFullDayTotals:null,dataNote:copy.todayStoredUnverified};
 if(imported)return {...unchanged,todayImported:true};
 let historicFailed=false;
 let previous:{date:string;netSalesCents?:number|null;ordersCount?:number|null;drinksCount?:number|null}|undefined;
 try{
  const history=await ctx.tools.getSalesTrend({from:dateOffset(ctx.asOf,-364),to:dateOffset(ctx.asOf,-1)});
  if(history.available)previous=[...history.value].filter(day=>day.date<ctx.asOf)
   .sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
  else if(!onlyNoRows(history.quality.missingInputs))historicFailed=true;
 }catch{historicFailed=true;}
 // A historical row alone does not prove that the Toast import finished.
 // Recheck the candidate day so quality flags from unrelated historical dates
 // cannot incorrectly qualify (or disqualify) this day's completeness.
 let lastFullDay:string|null=null;
 if(previous){
  try{
   const checked=await ctx.tools.getSalesTrend({from:previous.date,to:previous.date});
   const warnings=checked.quality.missingInputs;
   if(checked.available&&checked.value.some(row=>row.date===previous!.date)&&
      checked.quality.level!=="low"&&warnings.length===0){
    lastFullDay=previous.date;
   }
  }catch{ /* Preserve the stored observation but do not call it complete. */ }
 }
 const amount=previous&&Number.isSafeInteger(previous.netSalesCents)?previous.netSalesCents!:null;
 const formatted=amount===null?"—":new Intl.NumberFormat(ctx.locale,{
  style:"currency",currency:ctx.currency??"XXX"}).format(amount/100);
 const note=currentFailed?
  (previous?copy.todaySalesCheckFailedWithHistory.replace("{date}",previous.date).replace("{amount}",formatted):
   copy.todaySalesCheckUnavailable):
  historicFailed?copy.lastFullDayCheckFailed:
  lastFullDay?copy.todayNotImported.replace("{date}",lastFullDay).replace("{amount}",formatted):
   previous?copy.todayLastRecordedUnverified.replace("{date}",previous.date).replace("{amount}",formatted):
   copy.todayNotImportedNoHistory;
 return {...unchanged,...(!currentFailed?{todayImported:false}:{}),
  lastFullDay,lastRecordedDay:previous?.date??null,
  lastFullDayTotals:lastFullDay?{netSalesCents:amount,ordersCount:previous?.ordersCount??null,
   drinksCount:previous?.drinksCount??null}:null,dataNote:safeNote};
}
