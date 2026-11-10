import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import type {OwnerProposalRow,OwnerReportRow} from "@/lib/ai/supervisor/loop/reads.server";
import {monitorDayIndex} from "@/lib/operating/board";

/** An ISO date from readSupervisorCafeIdentity is already café-local. For an
 * instant, convert to the café timezone before counting business dates. */
export function monitorCafeDate(asOf:string,timezone:string):string{
  if(/^\d{4}-\d{2}-\d{2}$/.test(asOf))return asOf;
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"})
    .formatToParts(new Date(asOf));
  const value=(type:string)=>parts.find(p=>p.type===type)?.value??"";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Source-verified Toast price changes are OBSERVATIONS, never experiments.
 * This is a pure handoff for the existing Operating Board/owner notifier:
 * it schedules no job, sends no message and does not claim order-level proof.
 * The caller must supply records annotated by the authorized current-source
 * receipt, not old owner_manual/initial rows from menu_price_history. */
export type VerifiedToastPriceDelta={
 businessId:string;restaurantGuid:string;menuItemId:string;posItemId:string;
 contextKey:string;sourceType:"connected_pos";sourceProvider:"toast";
 oldPriceCents:number;newPriceCents:number;publicationVersion:string;
 observedAt:string;sourceEffectiveAt:string|null;
};
export type ToastObservationWindow={
 kind:"observational";businessId:string;restaurantGuid:string;
 menuItemId:string;posItemId:string;contextKey:string;publicationVersion:string;
 oldPriceCents:number;newPriceCents:number;observedAt:string;
 sourceEffectiveAt:string|null;day:number;from:string;to:string;
 due:boolean;interrupted:boolean;coverage:"not_assessed";
 deliveryKey:string;
};
/** Seven elapsed 24-hour windows, preserving partial exposure when a second
 * verified version arrives. Source lag and missing sales are NOT zero sales. */
export function planVerifiedToastPriceObservations(
 rows:readonly VerifiedToastPriceDelta[],asOf:string,
):ToastObservationWindow[]{
 const now=Date.parse(asOf);
 if(!Number.isFinite(now))return [];
 const DAY_MS=24*60*60*1000;
 const valid=rows.filter(r=>{
  const t=Date.parse(r.observedAt);
  const idPrefix="toast:"+r.restaurantGuid.toLowerCase()+":";
  return r.sourceType==="connected_pos"&&r.sourceProvider==="toast"&&
   Boolean(r.businessId&&r.restaurantGuid&&r.menuItemId&&r.contextKey&&
     r.publicationVersion&&r.posItemId.toLowerCase().startsWith(idPrefix))&&
   Number.isFinite(t)&&t<=now&&
   Number.isSafeInteger(r.oldPriceCents)&&r.oldPriceCents>0&&
   Number.isSafeInteger(r.newPriceCents)&&r.newPriceCents>0&&
   r.oldPriceCents!==r.newPriceCents;
 }).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 const output:ToastObservationWindow[]=[];
 for(let i=0;i<valid.length;i++){
  const r=valid[i],start=Date.parse(r.observedAt);
  const next=valid.slice(i+1).find(n=>n.businessId===r.businessId&&
   n.restaurantGuid===r.restaurantGuid&&n.posItemId===r.posItemId&&
   n.contextKey===r.contextKey);
  const nextStart=next?Date.parse(next.observedAt):Infinity;
  for(let day=1;day<=7;day++){
   const from=start+(day-1)*DAY_MS,naturalEnd=start+day*DAY_MS;
   if(from>=nextStart)break;
   const end=Math.min(naturalEnd,nextStart);
   output.push({kind:"observational",businessId:r.businessId,
    restaurantGuid:r.restaurantGuid,menuItemId:r.menuItemId,
    posItemId:r.posItemId,contextKey:r.contextKey,
    publicationVersion:r.publicationVersion,oldPriceCents:r.oldPriceCents,
    newPriceCents:r.newPriceCents,observedAt:r.observedAt,
    sourceEffectiveAt:r.sourceEffectiveAt,day,
    from:new Date(from).toISOString(),to:new Date(end).toISOString(),
    due:now>=end,interrupted:end<naturalEnd,coverage:"not_assessed",
    deliveryKey:JSON.stringify([r.businessId,r.restaurantGuid,r.posItemId,
      r.contextKey,r.publicationVersion,day])});
  }
 }
 return output;
}

/** Pure mapping of the same canonical monitor rows the Operating Board uses. */
export function mapPriceMonitorRows(rows:readonly OwnerProposalRow[],reports:readonly OwnerReportRow[],
    asOf:string,timezone:string){
  const today=monitorCafeDate(asOf,timezone);
  // The canonical reader returns reports newest-first. Keep the latest report
  // per proposal, including when a proposal has more than one report row.
  const reportById=new Map<string,OwnerReportRow>();
  for(const report of [...reports].sort((a,b)=>b.generated_at.localeCompare(a.generated_at))){
    if(!reportById.has(report.proposal_id))reportById.set(report.proposal_id,report);
  }
  return rows.map(r=>{
    const effect=r.canonical_effect_payload as Record<string,unknown>|null;
    const spec=r.monitor_spec as Record<string,unknown>|null;
    const days=spec?.durationDays;
    const durationDays=typeof days==="number"&&Number.isSafeInteger(days)&&days>0?days:null;
    const startDate=r.monitoring_start_date;
    const elapsed=startDate?monitorDayIndex(startDate,today):null;
    const ended=elapsed!==null&&durationDays!==null&&elapsed>durationDays;
    // Derived display lifecycle only: never mutate an approval or the loop's
    // persisted status. A missing final report is not evidence of a result.
    const stage=ended?"finished":
      r.status==="manual_pending"?"waiting_on_owner":
      elapsed===null?"not_started":elapsed<=0?"scheduled":"monitoring";
    const day=ended||elapsed===null?null:Math.max(0,elapsed);
    const finalReport=reportById.get(r.id);
    const result=finalReport?.report&&typeof finalReport.report==="object"
      ?finalReport.report as Record<string,unknown>:null;
    const finalResult=finalReport?{
      status:finalReport.status,
      recommendation:result?.recommendation==="keep"||result?.recommendation==="revert"||
        result?.recommendation==="adjust"?result.recommendation:null,
      coveredDays:typeof result?.coveredDays==="number"?result.coveredDays:null,
      observedRevenueCents:typeof result?.observedRevenueCents==="number"?result.observedRevenueCents:null,
      realizedRevenueDifferenceCents:typeof result?.realizedRevenueDifferenceCents==="number"?
        result.realizedRevenueDifferenceCents:null,
      source:typeof result?.source==="string"?result.source:null,
    }:null;
    return {proposalId:r.id,threadId:r.thread_id,
      productName:typeof effect?.productName==="string"?effect.productName:"Unknown item",
      status:r.status,stage,startDate,durationDays,day,
      finalReportMissing:ended&&!finalReport,finalResult,
      oldPriceCents:typeof effect?.oldPriceCents==="number"?effect.oldPriceCents:null,
      newPriceCents:typeof effect?.newPriceCents==="number"?effect.newPriceCents:null,
      reportStatus:finalReport?.status??null};
  });
}


export const priceMonitorTools={
  get_price_monitor_status:{
    agentId:"alex",
    schema:z.strictObject({}),
    description:"Read existing price-change and price-experiment monitoring status, including upcoming start dates and completed reports. Never create or restart an experiment.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      priceMonitorTools.get_price_monitor_status.schema.parse(raw);
      if(!ctx.readPriceMonitors)return {source:"supervisor_loop",period:null,missing:["monitor_reader_unavailable"],monitors:[]};
      try{
        const monitors=await ctx.readPriceMonitors();
        return {source:"supervisor_loop",period:null,agentId:"alex",missing:[],monitors};
      }catch{
        return {source:"supervisor_loop",period:null,agentId:"alex",missing:["monitor_read_failed"],monitors:[]};
      }
    },
  },
} as const;
