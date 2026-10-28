import type {AgentToolContext} from "./index";
import {dateOffset,type CalcPeriod,type CoverageFallback} from "@/lib/calc/periods";
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
 if(requested.from!==ctx.asOf||requested.to!==ctx.asOf)return unchanged;
 if(typeof ctx.tools.getSalesTrend!=="function")
  return {...unchanged,todayImported:false,lastFullDay:null,lastFullDayTotals:null};
 const current=await ctx.tools.getSalesTrend(requested);
 const imported=current.available&&current.value.some(day=>day.date===ctx.asOf);
 if(imported)return {...unchanged,todayImported:true};
 const historic=await ctx.tools.getSalesTrend({from:dateOffset(ctx.asOf,-364),to:dateOffset(ctx.asOf,-1)});
 const previous=historic.available?[...historic.value].filter(day=>day.date<ctx.asOf).sort((a,b)=>a.date.localeCompare(b.date)).at(-1):undefined;
 const money=previous?.netSalesCents;
 const amount=typeof money==="number"&&Number.isSafeInteger(money)?money:null;
 const note=previous?
  {en,es,ar}[ctx.locale].DataNotes.todayNotImported
   .replace("{date}",previous.date)
   .replace("{amount}",amount===null?"—":new Intl.NumberFormat(ctx.locale,{minimumFractionDigits:2,maximumFractionDigits:2}).format(amount/100)):
  {en,es,ar}[ctx.locale].DataNotes.todayNotImportedNoHistory;
 return {...unchanged,todayImported:false,lastFullDay:previous?.date??null,
  lastFullDayTotals:previous?{netSalesCents:amount,ordersCount:previous.ordersCount??null,
   drinksCount:previous.drinksCount??null}:null,dataNote:note};
}
