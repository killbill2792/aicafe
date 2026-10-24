import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {resolveEntity,ownerChoiceGuard} from "../resolve";
export const priceChangeProposalSchema=z.strictObject({
  product_id:z.uuid(),new_price_cents:z.number().int().safe().positive().max(100000),
});
export const proposalTools={propose_price_change:{
  agentId:"alex",schema:priceChangeProposalSchema,
  description:"Only when the owner requests or agrees to a specific price. Call get_menu_items first to obtain the active product UUID. Creates an inert approval card; NEVER say the price changed.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
    const input=priceChangeProposalSchema.parse(raw);
    const menu=await ctx.tools.getMenuCatalog();
    if(!menu.available)return {source:"price_change_proposal",period:null,missing:menu.quality.missingInputs};
    const active=menu.value.filter(item=>item.active);
    const product=active.find(item=>item.id===input.product_id);
    if(!product)return {source:"price_change_proposal",period:null,missing:["notFound"]};
    const matched=resolveEntity("product",product.name,active,{
      nameOf:item=>item.name,idOf:item=>item.id,describe:item=>item.category+" · "+(item.priceCents/100).toFixed(2)});
    if(matched.status==="ambiguous"){
      const guard=ownerChoiceGuard(ctx.resolveState,input.product_id);
      if(guard)return {source:"price_change_proposal",period:null,...guard};
      if(!ctx.resolveState?.ambiguous.some(group=>group.some(c=>c.id===input.product_id)))
        return {source:"price_change_proposal",period:null,missing:["ownerChoiceRequired"],needsOwnerChoice:true,candidates:matched.candidates};
    }
    if(!ctx.proposals)return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:["proposalsUnavailable"]};
    const result=await ctx.proposals.proposePriceChange({
      productId:input.product_id,newPriceCents:input.new_price_cents});
    return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:[],...result};
  },
}} as const;
