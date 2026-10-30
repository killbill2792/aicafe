import {eventReadinessInput} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import type {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Model proposes owner-reviewable wording; only the existing loop writes it. */
export type EventPlanPort={
  propose(input:z.infer<typeof eventReadinessInput>):Promise<{proposalId:string;revision:number}>;
};

export const eventPlanTools={
  propose_event_plan:{
    agentId:"alex",schema:eventReadinessInput,
    description:"Draft a single day's event-readiness plan for owner approval, using saved event UUIDs from get_events or the system-provided event-day facts. Give a brief summary, estimated busy hours only when justified, and 1–3 specific actions with reasons across staff, prep, ordering, promo, hours or operations. This is an inert plan, not an executed shift/order/menu/POS change. The owner decides whether to use it.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=eventReadinessInput.parse(raw);
      if(!ctx.eventPlans)return {source:"event_plan_proposal",period:null,missing:["eventPlanningUnavailable"]};
      const result=await ctx.eventPlans.propose(input);
      return {source:"event_plan_proposal",period:{from:input.startDate,to:input.endDate},
        agentId:"alex",missing:[],draft:true,saved:false,...result};
    },
  },
} as const;
