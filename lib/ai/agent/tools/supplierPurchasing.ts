import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {supplierPurchaseInputSchema,supplierPurchaseProposalToolInputSchema} from "@/lib/ai/supervisor/loop/purchaseOrders.server";

/** Two deliberate steps: investigate read-only evidence, then create a durable
 * approval proposal using the SAME server-bound Supervisor planner. A model
 * cannot smuggle in a café ID, quote price, or authorization kind. */
export const supplierPurchasingTools={
 get_supplier_purchase_orders:{
  agentId:"maya",schema:z.strictObject({}),
  description:"Read owner-scoped EDITABLE drafts, UNRESOLVED approved/executing proposals and actual prepared POs. An approved or executing proposal without a PO receipt is NOT an absent order: report its saved ID, status and effect-attempt state instead of making another draft or claiming completion. Only draft IDs can be replaced. Approved with no attempt requires a NEW explicit owner retry/cancel; executing or uncertain effects are receipt-reconciliation-only, NEVER resent automatically. approved_for_ordering is NOT sent, received or paid.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   z.strictObject({}).parse(raw);
   if(!ctx.purchasing)return {source:"purchase_orders",period:null,agentId:"maya",
    missing:["purchasing_unavailable"],orders:[],drafts:[],draftsTruncated:false,
    unresolvedApprovals:[],unresolvedApprovalsTruncated:false};
   const result=await ctx.purchasing.list();
   return {source:"purchase_orders",period:null,agentId:"maya",
    missing:[...(result.truncated?["purchase_order_history_truncated"]:[]),
      ...(result.draftsTruncated?["supplier_po_draft_history_truncated"]:[]),
      ...(result.unresolvedApprovalsTruncated?["supplier_po_unresolved_history_truncated"]:[]),
      ...(result.unresolvedApprovals.length?["supplier_po_approval_unresolved"]:[])],
    orders:result.orders,truncated:result.truncated,
    drafts:result.drafts,draftsTruncated:result.draftsTruncated,
    unresolvedApprovals:result.unresolvedApprovals,
    unresolvedApprovalsTruncated:result.unresolvedApprovalsTruncated};
  }
 },
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
  agentId:"maya",schema:supplierPurchaseProposalToolInputSchema,
  description:"After inspecting supplier quotations, autonomously prepare and SAVE an owner-approval purchase order for FUTURE supplies. Do not confuse with propose_purchases (that records ALREADY RECEIVED stock). Server recomputes actual ingredient, availability, currency, quote, package, freight/tax uncertainty; model cannot set price or authorize execution. Set replaceProposalId=null for a NEW order, including a separate order while another draft is pending. For a correction of a saved draft, FIRST read get_supplier_purchase_orders, verify which exact draft the owner wants changed, then set replaceProposalId to its returned UUID. Never choose a draft to cancel merely because the owner uses words like increase/change; ask when the target is ambiguous. Server checks same owner, café, thread and immutable revision. The returned proposal is a DRAFT; only the owner's specific approval click makes it ready for ordering. This does NOT contact suppliers, update stock or create an expense.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=supplierPurchaseProposalToolInputSchema.parse(raw);
   if(!ctx.purchasing)return {source:"supplier_purchase_proposal",period:null,agentId:"maya",missing:["purchasing_unavailable"],draft:false,saved:false};
   const result=await ctx.purchasing.propose(input);
   return {source:"supplier_purchase_proposal",period:null,agentId:"maya",missing:[],
    draft:true,saved:false,approvalRequired:true,orderSent:false,inventoryUpdated:false,...result};
  }
 }
} as const;
