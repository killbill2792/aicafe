import {eventReadinessInput} from "@/lib/ai/supervisor/loop/eventReadiness.server";
import type {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Model proposes owner-reviewable wording; only the existing loop writes it. */
export type EventPlanPort={
  propose(input:z.infer<typeof eventReadinessInput>):Promise<{proposalId:string;revision:number;
    reused?:boolean;status?:string}>;
};

export const eventPlanTools={
  propose_event_plan:{
    agentId:"alex",schema:eventReadinessInput,
    description:"Draft an event-readiness plan for one date or a verified multi-day occurrence when the same preparation is applicable throughout, using saved event UUIDs. Give café-specific importance, a brief summary, date-specific estimated busy hours only when justified, and 1–3 specific actions with reasons. Reuse unchanged prior preparation decisions; do not repeat owner approval. This is an inert plan, not an executed shift/order/menu/POS change. The owner decides whether to use it.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=eventReadinessInput.parse(raw);
      if(!ctx.eventPlans)return {source:"event_plan_proposal",period:null,missing:["eventPlanningUnavailable"]};
      const result=await ctx.eventPlans.propose(input);
      return {source:"event_plan_proposal",period:{from:input.startDate,to:input.endDate},
        agentId:"alex",missing:[],draft:!result.reused,saved:false,...result};
    },
  },
} as const;
