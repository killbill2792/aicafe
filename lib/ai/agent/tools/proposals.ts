import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {resolveEntity,ownerChoiceGuard,normalizedName,ownerNamedTarget} from "../resolve";
import {safeDifferenceCents} from "@/lib/calc/explainMath";
import {money} from "../explain";
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
      nameOf:item=>item.name,idOf:item=>item.id,describe:item=>item.category+" · "+(item.priceCents===null?"open price":(item.priceCents/100).toFixed(2))});
    // Re-evaluate the owner words against the *whole* active catalog, not
    // only the name attached to the model-selected UUID. "Latte" names both
    // Latte and Iced Latte, even if the model proposed the iced item's ID.
    const ownerTokens=new Set(normalizedName(ctx.resolveState?.ownerText??"").split(" ").filter(t=>t.length>=3));
    const productTokens=new Set(normalizedName(product.name).split(" "));
    const relevant=[product,...active.filter(item=>item.id!==product.id&&
      normalizedName(item.name).split(" ").some(t=>ownerTokens.has(t)&&productTokens.has(t)))];
    const counts=new Map<string,number>();
    for(const item of relevant){
      const key=normalizedName(item.name);
      counts.set(key,(counts.get(key)??0)+1);
    }
    const candidates=matched.status==="ambiguous"?matched.candidates:
      relevant.length>1?relevant.slice(0,4).map(item=>{
        const detail=item.category+" · "+(item.priceCents===null?"open price":(item.priceCents/100).toFixed(2));
        const label=(counts.get(normalizedName(item.name))??0)>1?item.name+" — "+detail:item.name;
        return {id:item.id,label:label.slice(0,60),detail};
      }):null;
    if(candidates){
      const guard=ownerChoiceGuard(ctx.resolveState,input.product_id,candidates);
      if(guard)return {source:"price_change_proposal",period:null,...guard};
      if(!ctx.resolveState)return {source:"price_change_proposal",period:null,
        missing:["ownerChoiceRequired"],needsOwnerChoice:true,candidates};
    }
    // The model's UUID is not an owner instruction. For an ordinary turn,
    // require the chosen item name (as whole words), or a choice recorded
    // from the immediately preceding clarification card.
    if(!ownerNamedTarget(ctx.resolveState,input.product_id,product.name)){
      return {source:"price_change_proposal",period:null,agentId:"alex",
        missing:["targetNotConfirmed"],draft:false,saved:false};
    }
    if(!ctx.proposals)return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:["proposalsUnavailable"]};
    const result=await ctx.proposals.proposePriceChange({
      productId:input.product_id,newPriceCents:input.new_price_cents});
    const priceDeltaCents=safeDifferenceCents(result.newPriceCents,result.oldPriceCents);
    return {source:"price_change_proposal",period:null,agentId:"alex",
      draft:true,saved:false,missing:[],...result,priceDeltaCents,
      explain:priceDeltaCents===null?[]:[{
       label:result.productName,inputs:[{name:"newPrice",value:money(result.newPriceCents)},
         {name:"oldPrice",value:money(result.oldPriceCents)}],
       formula:"subtract",result:money(priceDeltaCents),period:null,
       source:"propose_price_change",provenance:"ownerProvided"}]};
  },
}} as const;
