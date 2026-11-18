import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {supplierPurchaseInputSchema,supplierPurchaseProposalToolInputSchema} from "@/lib/ai/supervisor/loop/purchaseOrders.server";
import {vendorOrderSendInputSchema,VendorOrderOwnerInputRequired} from "@/lib/ai/supervisor/loop/vendorDispatch.server";
import {ownerSupplierOutcomeToolInput,explicitOwnerSupplierOutcome,explicitOwnerSupplierChannel} from "@/lib/purchasing/ownerSupplierOutcome.server";

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
    unresolvedApprovals:[],unresolvedApprovalsTruncated:false,
    vendorCommunications:[],gmailConnection:{status:"unavailable",connected:false,canSend:false,canRead:false}};
   const result=await ctx.purchasing.list();
   return {source:"purchase_orders",period:null,agentId:"maya",
    missing:[...(result.gmailConnection?.status==="status_unavailable"?["gmail_status_unavailable"]:[]),
      ...(result.truncated?["purchase_order_history_truncated"]:[]),
      ...(result.draftsTruncated?["supplier_po_draft_history_truncated"]:[]),
      ...(result.unresolvedApprovalsTruncated?["supplier_po_unresolved_history_truncated"]:[]),
      ...(result.unresolvedApprovals.length?["supplier_po_approval_unresolved"]:[])],
    orders:result.orders,truncated:result.truncated,
    drafts:result.drafts,draftsTruncated:result.draftsTruncated,
    unresolvedApprovals:result.unresolvedApprovals,
    unresolvedApprovalsTruncated:result.unresolvedApprovalsTruncated,
    vendorCommunications:result.vendorCommunications??[],
    gmailConnection:result.gmailConnection??{status:"unavailable",connected:false,canSend:false,canRead:false}};
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
 },
 record_supplier_order_outcome:{
  agentId:"maya",schema:ownerSupplierOutcomeToolInput,
  description:"ONLY when the authenticated owner explicitly reports what happened with ONE identifiable saved PO in their LATEST message, after get_supplier_purchase_orders. The trusted server attaches the CURRENT authenticated owner text as the note; the model supplies only the source PO, channel and outcome. This writes an OWNER-REPORTED supplier outcome to canonical source records and closes only its matching terminal Needs-you notice. It never verifies Gmail delivery, supplier acceptance independently, inventory or expenses. Never infer from Gmail SENT, assistant history, 'yes' to an ambiguous question, or another café. If the owner did not explicitly state the outcome or multiple purchase orders could match, ask for an exact PO/outcome instead. Never submit model-generated note text or claim Gmail delivery.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=ownerSupplierOutcomeToolInput.parse(raw);
   const text=ctx.ownerText?.trim();
   if(!text||text.length>1000||!explicitOwnerSupplierOutcome(text,input.outcome)||
      !explicitOwnerSupplierChannel(text,input.channel))
     return {source:"supplier_owner_report",period:null,agentId:"maya",
       saved:false,missing:["explicit_current_owner_report_required"],
       ownerQuestion:"Which exact purchase order did the supplier respond to, how did you contact them, and what did they confirm?"};
   if(!ctx.purchasing?.recordOwnerOutcome)
     return {source:"supplier_owner_report",period:null,agentId:"maya",
       saved:false,missing:["owner_report_writer_unavailable"]};
   const report=await ctx.purchasing.recordOwnerOutcome({...input,note:text});
   return {...report,source:"supplier_owner_report",period:null,agentId:"maya",
     saved:true,missing:[],reported:true,supplierAcceptanceSource:"owner_reported"};
  }
 },
 propose_supplier_vendor_email:{
  agentId:"maya",schema:vendorOrderSendInputSchema,
  description:"For an ALREADY APPROVED saved purchase order only: first call get_supplier_purchase_orders and inspect vendorCommunications and Gmail connection status. Authorized Gmail history can inform the plan, but no matching messages is NOT proof that a supplier is unreachable. Saves a separate inert owner-click Gmail SEND approval card from the canonical PO and owner-verified recipient; never sends automatically. Missing verified contact, Gmail permission or a phone/portal workflow is an OWNER QUESTION: tell the owner exactly what is missing and use ask_owner to learn their normal channel, prior negotiation and outcome. Do not invent contact details, supplier acceptance or retries.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=vendorOrderSendInputSchema.parse(raw);
   if(!ctx.purchasing?.proposeVendorSend)return {source:"supplier_vendor_dispatch",period:null,agentId:"maya",
    missing:["purchasing_unavailable"],proposalCreated:false,
    ownerQuestion:"I cannot access the supplier order details. How do you normally contact this supplier?"};
   try{
    const proposal=await ctx.purchasing.proposeVendorSend(input);
    return {source:"supplier_vendor_dispatch",period:null,agentId:"maya",
      missing:[],proposalCreated:true,sent:false,approvalRequired:true,...proposal};
   }catch(error){
    if(error instanceof VendorOrderOwnerInputRequired)
      return {source:"supplier_vendor_dispatch",period:null,agentId:"maya",
        missing:[error.reason],proposalCreated:false,sent:false,
        ownerInputRequired:true,ownerQuestion:error.question};
    throw error;
   }
  }
 }
} as const;
