import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {ToolError} from "../toolErrors";

/** One validation reason for every attempt to propose a nonpositive increase. */
export function requirePositivePriceIncrease(increase:number|null):asserts increase is number{
  if(increase===null||!Number.isSafeInteger(increase)||increase<=0)
    throw new ToolError("validation","price_increase_must_be_positive: Enter a positive price increase; checking an existing monitor does not require a new proposal.");
}

/** The loop refused because another approved or running proposal watches the same item.
 * Nothing was created; the model tells the owner and asks whether to wait for it to end. */
export function runningOverlapResult(error:unknown,source:string):AgentToolResult|null{
  if(!(error instanceof Error)||error.name!=="ProposalOverlapError"||!("running" in error))return null;
  const running=(error as Error&{running:{proposalId:string;status:string;endsOn:string|null}}).running;
  return {source,period:null,agentId:"alex",draft:false,saved:false,missing:["runningExperimentSameItem"],
    reason:"running_experiment_same_item: An approved or running price test or price change already covers this item"+
      (running.endsOn?" until "+running.endsOn:"")+". Nothing was created. Two at once would mix their sales. "+
      "Tell the owner and ask whether to wait until it ends.",
    runningExperiment:{proposalId:running.proposalId,status:running.status,endsOn:running.endsOn}};
}
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
  let result:Awaited<ReturnType<NonNullable<typeof ctx.proposals.proposePriceExperiment>>>;
  try{
    result=await ctx.proposals.proposePriceExperiment({productId:v.product_id,newPriceCents:v.new_price_cents,increaseCents:v.increase_cents,days:v.days});
  }catch(error){
    const overlap=runningOverlapResult(error,"price_experiment_proposal");
    if(overlap)return overlap;
    throw error;
  }
  return {source:"price_experiment_proposal",period:null,agentId:"alex",missing:[],draft:true,saved:false,...result};
 },
}} as const;
