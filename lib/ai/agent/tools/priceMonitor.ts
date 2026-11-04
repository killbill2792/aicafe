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

/** Pure mapping of the same canonical monitor rows the Operating Board uses. */
export function mapPriceMonitorRows(rows:readonly OwnerProposalRow[],reports:readonly OwnerReportRow[],
    asOf:string,timezone:string){
  const today=monitorCafeDate(asOf,timezone);
  const reportById=new Map(reports.map(r=>[r.proposal_id,r]));
  return rows.map(r=>{
    const effect=r.canonical_effect_payload as Record<string,unknown>|null;
    const spec=r.monitor_spec as Record<string,unknown>|null;
    const days=spec?.durationDays;
    const durationDays=typeof days==="number"&&Number.isSafeInteger(days)&&days>0?days:null;
    const startDate=r.monitoring_start_date;
    const day=startDate?Math.max(0,monitorDayIndex(startDate,today)):null;
    return {proposalId:r.id,threadId:r.thread_id,
      productName:typeof effect?.productName==="string"?effect.productName:"Unknown item",
      status:r.status,startDate,durationDays,day,
      oldPriceCents:typeof effect?.oldPriceCents==="number"?effect.oldPriceCents:null,
      newPriceCents:typeof effect?.newPriceCents==="number"?effect.newPriceCents:null,
      reportStatus:reportById.get(r.id)?.status??null};
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
