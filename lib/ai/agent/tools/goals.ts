import {z} from "zod";
import {GOAL_METRICS,GOAL_MIN_DAYS,GOAL_MAX_DAYS,MAX_GUARDRAILS} from "@/lib/calc/goals/goalSpec";
import type {AgentToolContext,AgentToolResult} from "./index";

const metric=z.enum(GOAL_METRICS);
export const proposeGoalSchema=z.strictObject({
  metric,item_id:z.uuid().nullable(),direction:z.enum(["up","down"]),
  target_kind:z.enum(["percent","absolute"]),
  /** percent: e.g. 5 for 5%; absolute: in the metric's unit (cents for money, count otherwise). */
  target:z.number().finite().positive().max(1e9),
  days:z.number().int().min(GOAL_MIN_DAYS).max(GOAL_MAX_DAYS),
  guardrails:z.array(z.strictObject({metric,item_id:z.uuid().nullable(),
    direction:z.enum(["not_below","not_above"]),percent:z.number().finite().positive().max(100)})).max(MAX_GUARDRAILS),
});
export const goalStatusSchema=z.strictObject({goal_id:z.uuid().nullable()});

export type GoalPort={
  propose(input:{metric:z.infer<typeof metric>;itemId:string|null;direction:"up"|"down";
    targetKind:"percent"|"absolute";target:number;days:number;
    guardrails:Array<{metric:z.infer<typeof metric>;itemId:string|null;direction:"not_below"|"not_above";percent:number}>}):
    Promise<{proposalId:string;revision:number;title:string}>;
  /** goalId null lists the owner's goals; an id returns that goal's live score. */
  status(goalId:string|null):Promise<Record<string,unknown>>;
};

export const goalTools={
  propose_goal:{
    agentId:"leo",schema:proposeGoalSchema,
    description:"Draft a goal for the owner to confirm, e.g. 'average ticket up 5% for 30 days'. Metrics: net_sales, orders, avg_ticket (whole café) or item_units, item_revenue (one menu item: find its UUID with get_menu_items). Suggest one guardrail when a change could hurt another number (e.g. orders not_below 10). A goal tracks numbers; it changes nothing.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const v=proposeGoalSchema.parse(raw);
      if(!ctx.goals)return {source:"goal_proposal",period:null,missing:["not_supported"]};
      const result=await ctx.goals.propose({metric:v.metric,itemId:v.item_id,direction:v.direction,
        targetKind:v.target_kind,target:v.target,days:v.days,
        guardrails:v.guardrails.map(g=>({metric:g.metric,itemId:g.item_id,direction:g.direction,percent:g.percent}))});
      return {source:"goal_proposal",period:null,agentId:"leo",missing:[],draft:true,saved:false,...result};
    },
  },
  get_goal_status:{
    agentId:"leo",schema:goalStatusSchema,
    description:"List the owner's goals (goal_id null), or read one goal's progress so far. Report the summary text; numbers are daily averages.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const v=goalStatusSchema.parse(raw);
      if(!ctx.goals)return {source:"goals",period:null,missing:["not_supported"]};
      return {source:"goals",period:null,agentId:"leo",missing:[],...await ctx.goals.status(v.goal_id)};
    },
  },
} as const;
