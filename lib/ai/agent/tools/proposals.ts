import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
export const priceChangeProposalSchema=z.strictObject({
  product_id:z.uuid(),new_price_cents:z.number().int().safe().positive().max(100000),
});
export const proposalTools={propose_price_change:{
  agentId:"alex",schema:priceChangeProposalSchema,
  description:"Only when the owner requests or agrees to a specific price. Call get_menu_items first to obtain the active product UUID. Creates an inert approval card; NEVER say the price changed.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
    const input=priceChangeProposalSchema.parse(raw);
    if(!ctx.proposals)return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:["proposalsUnavailable"]};
    const result=await ctx.proposals.proposePriceChange({
      productId:input.product_id,newPriceCents:input.new_price_cents});
    return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:[],...result};
  },
}} as const;
