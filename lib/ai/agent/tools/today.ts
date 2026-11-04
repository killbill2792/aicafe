import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import type {TodaySoFar} from "@/lib/pos/toast/todaySoFar";
import {TODAY_LIVE_FRESH_MS} from "@/lib/data/todayLive.server";

const empty=z.strictObject({});

/** One age policy for both Supervisor sales tools; the underlying reading is
 * the Home reader, and an old same-day fallback is not described as live. */
export function todayReadingFreshness(readAt:string,timezone:string,locale:string,now=new Date()){
  const stamp=Date.parse(readAt);
  const stale=!Number.isFinite(stamp)||now.getTime()-stamp>=TODAY_LIVE_FRESH_MS;
  const lastUpdated=Number.isFinite(stamp)?new Intl.DateTimeFormat(locale,{
    timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).format(new Date(stamp)):null;
  return {stale,lastUpdated, freshnessLabel:stale&&lastUpdated?"last updated "+lastUpdated:null};
}


/** Gaps in a live reading, as missing codes. */
export function todayLiveMissing(t:TodaySoFar):string[]{
  return [...(t.locationsFailed?["todayLiveLocationsFailed:"+t.locationsFailed]:[]),
    ...(t.truncated?["todayLiveTruncated"]:[]),
    ...(t.unparsedOrders?["todayLiveUnparsedOrders:"+t.unparsedOrders]:[])];
}

/** "How's today going?": provisional sales so far for the current business day,
 * read live from the POS. The closeout import later replaces it. */
export const todayTools={
  get_today_so_far:{
    agentId:"alex",schema:empty,
    description:"Provisional sales so far for the current business day, read live from Toast (open and paid checks). Not final: the closeout import replaces it. Use when the owner asks about today; say it is so far only when fresh; if stale say last updated HH:MM, not so far today. Name any missing locations or a truncated read.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.readTodaySoFar)return {source:"today_live",period:null,agentId:"alex",missing:["todayLiveReaderUnavailable"]};
      const read=await ctx.readTodaySoFar().catch(()=>null);
      if(!read)return {source:"today_live",period:null,agentId:"alex",missing:["todayLiveReadFailed"]};
      if(!read.available)return {source:"today_live",period:null,agentId:"alex",missing:read.missing};
      const t=read.value;
      const freshness=todayReadingFreshness(t.readAt,ctx.timezone,ctx.locale);
      return {source:"today_live",period:{from:t.businessDate,to:t.businessDate},agentId:"alex",
        provisional:true,readAt:t.readAt,...freshness,
        missing:todayLiveMissing(t),
        netSalesCents:t.netSalesCents,orders:t.orders,openChecks:t.openChecks,
        discountsCents:t.discountsCents,refundsCents:t.refundsCents,tipCents:t.tipCents,
        topItems:t.topItems};
    },
  },
} as const;
