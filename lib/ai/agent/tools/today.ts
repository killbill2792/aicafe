import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import type {TodaySoFar} from "@/lib/pos/toast/todaySoFar";

const empty=z.strictObject({});

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
    description:"Provisional sales so far for the current business day, read live from Toast (open and paid checks). Not final: the closeout import replaces it. Use when the owner asks about today; say it is so far, and name any missing locations or a truncated read.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.readTodaySoFar)return {source:"today_live",period:null,agentId:"alex",missing:["todayLiveReaderUnavailable"]};
      const read=await ctx.readTodaySoFar().catch(()=>null);
      if(!read)return {source:"today_live",period:null,agentId:"alex",missing:["todayLiveReadFailed"]};
      if(!read.available)return {source:"today_live",period:null,agentId:"alex",missing:read.missing};
      const t=read.value;
      return {source:"today_live",period:{from:t.businessDate,to:t.businessDate},agentId:"alex",
        provisional:true,readAt:t.readAt,
        missing:todayLiveMissing(t),
        netSalesCents:t.netSalesCents,orders:t.orders,openChecks:t.openChecks,
        discountsCents:t.discountsCents,refundsCents:t.refundsCents,tipCents:t.tipCents,
        topItems:t.topItems};
    },
  },
} as const;
