import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
export const priceExperimentSchema=z.strictObject({
 product_id:z.uuid(),new_price_cents:z.number().int().safe().positive().max(100000).nullable(),
 increase_cents:z.number().int().safe().positive().max(100000).nullable(),
 days:z.number().int().min(1).max(90),
}).refine(v=>(v.new_price_cents===null)!==(v.increase_cents===null),"Supply exactly one price change");
export const priceExperimentTools={propose_price_experiment:{
 agentId:"alex",schema:priceExperimentSchema,
 description:"Draft an inert owner approval card to run a menu-price experiment; never claim a POS price changed. Find a real product UUID with get_menu_items first.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const v=priceExperimentSchema.parse(raw);
  if(!ctx.proposals?.proposePriceExperiment)return {source:"price_experiment_proposal",period:null,missing:["not_supported"],reason:"Experiment approvals are not configured."};
  const result=await ctx.proposals.proposePriceExperiment({productId:v.product_id,newPriceCents:v.new_price_cents,increaseCents:v.increase_cents,days:v.days});
  return {source:"price_experiment_proposal",period:null,agentId:"alex",missing:[],draft:true,saved:false,...result};
 },
}} as const;
