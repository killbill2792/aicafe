import type {AgentToolContext,AgentToolResult} from "./index";
import {supplierPurchaseInputSchema} from "@/lib/ai/supervisor/loop/purchaseOrders.server";

/** Two deliberate steps: investigate read-only evidence, then create a durable
 * approval proposal using the SAME server-bound Supervisor planner. A model
 * cannot smuggle in a café ID, quote price, or authorization kind. */
export const supplierPurchasingTools={
 inspect_supplier_purchase:{
  agentId:"maya",schema:supplierPurchaseInputSchema,
  description:"Investigate a future supply/order request using canonical café ingredients and saved supplier quotations. Input actual required item quantity/unit and needed-by date (null if not specified). Returns full-café-currency supplier carts, exact integer-cent subtotals and missing evidence. A subtotal is NEVER a verified full cost: shipping/tax unknown. Never mark public search snippets as firm offers. If no valid quotes, explain gaps; do not fabricate prices. Read-only; use BEFORE proposing a future supplier purchase order.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=supplierPurchaseInputSchema.parse(raw);
   if(!ctx.purchasing)return {source:"supplier_purchase_plan",period:null,agentId:"maya",missing:["purchasing_unavailable"],offers:[]};
   const plan=await ctx.purchasing.inspect(input);
   return {source:"supplier_purchase_plan",period:null,agentId:"maya",
    missing:plan.missing,offers:plan.offers,comparison:plan.comparison,
    complete:plan.offers.length>0,sourceTrust:"owner_reported"};
  }
 },
 propose_supplier_purchase_order:{
  agentId:"maya",schema:supplierPurchaseInputSchema,
  description:"After inspecting supplier quotations, autonomously prepare and SAVE an owner-approval purchase order for FUTURE supplies. Do not confuse with propose_purchases (that records ALREADY RECEIVED stock). Server recomputes actual ingredient, availability, currency, quote, package, freight/tax uncertainty; model cannot set price or authorize execution. The returned proposal is a DRAFT; only the owner's specific approval click makes it ready for ordering. This does NOT contact suppliers, update stock or create an expense.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=supplierPurchaseInputSchema.parse(raw);
   if(!ctx.purchasing)return {source:"supplier_purchase_proposal",period:null,agentId:"maya",missing:["purchasing_unavailable"],draft:false,saved:false};
   const result=await ctx.purchasing.propose(input);
   return {source:"supplier_purchase_proposal",period:null,agentId:"maya",missing:[],
    draft:true,saved:false,approvalRequired:true,orderSent:false,inventoryUpdated:false,...result};
  }
 }
} as const;
