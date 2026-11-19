import {z} from "zod";
import {receivingInputSchema,invoiceToolInputSchema} from "@/lib/ai/supervisor/loop/supplierReceiving.server";
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
  description:"Read scoped editable drafts, approvals/attempts and saved POs: quantities, dates, dispatch, receiving. Unresolved approval without receipt is not absent; report status/attempt. Explicit retry/cancel only approved with no attempt; executing/uncertain: receipt-only recovery. Replace drafts only. Ordered/sent/received/paid differ; dates never prove arrival; missing receipt=unknown.",
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
 inspect_purchase_reconciliation:{
  agentId:"maya",schema:z.strictObject({purchaseOrderId:z.uuid()}),
  description:"Read exact saved PO UUID; reconcile ordered/received/accepted/damaged/invoiced/outstanding quantities, prices and totals. Missing receipt=unknown. Read-only; clarify unknown identity.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const {purchaseOrderId}=z.strictObject({purchaseOrderId:z.uuid()}).parse(raw);
   if(!ctx.receivingRead)return {source:"purchase_reconciliation",period:null,agentId:"maya",
    missing:["receiving_read_unavailable"],reconciliation:null};
   const result=await ctx.receivingRead(purchaseOrderId);
   return {source:"purchase_reconciliation",period:null,agentId:"maya",...result};
  }
 },
 propose_purchase_receiving:{
  agentId:"maya",schema:receivingInputSchema,
  description:"Draft physical PO receipt after reconciliation; stable reference, prior correction revision, received/accepted/damaged base quantities ×10000 via calculate. Owner/receiving evidence, never invoice/dispatch alone or guesses. Stock only after owner click; no generic purchase bypass.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=receivingInputSchema.parse(raw);
   if(!ctx.receivingPropose)return {source:"supplier_purchase_proposal",proposalKind:"receiving",period:null,agentId:"maya",
    missing:["receiving_proposal_unavailable"],draft:false,inventoryUpdated:false};
   return {source:"supplier_purchase_proposal",proposalKind:"receiving",period:null,agentId:"maya",missing:[],
    draft:true,saved:false,approvalRequired:true,inventoryUpdated:false,...await ctx.receivingPropose(input)};
  }
 },
 propose_invoice_reconciliation:{
  agentId:"maya",schema:invoiceToolInputSchema,
  description:"Draft invoice after PO/reconciliation and verified supplier document or owner report. Prior correction revision; unmatched orderLineId=null, unknown tax/freight/discount=null. gmailMessageId only verified sender. expenseDate/existingExpenseId=null unless explicit verified recognition/match. Owner click; no stock/payment.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const input=invoiceToolInputSchema.parse(raw);
   if(!ctx.invoicePropose)return {source:"supplier_purchase_proposal",proposalKind:"invoice",period:null,agentId:"maya",
    missing:["invoice_proposal_unavailable"],draft:false};
   return {source:"supplier_purchase_proposal",proposalKind:"invoice",period:null,agentId:"maya",missing:[],
    draft:true,saved:false,approvalRequired:true,inventoryUpdated:false,paymentMade:false,...await ctx.invoicePropose(input)};
  }
 },
 propose_supplier_discrepancy_followup:{
  agentId:"maya",schema:z.strictObject({purchaseOrderId:z.uuid()}),
  description:"After exact unresolved PO reconciliation, draft separate owner-click Gmail follow-up for server-verified contact/current versions. No send, guessed address, inferred missing goods or uncertain retry. Ask owner for missing contact/permission.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const {purchaseOrderId}=z.strictObject({purchaseOrderId:z.uuid()}).parse(raw);
   if(!ctx.receivingFollowup)return {source:"supplier_vendor_dispatch",period:null,agentId:"maya",
    missing:["supplier_followup_unavailable"],proposalCreated:false,sent:false};
   try{
    const result=await ctx.receivingFollowup(purchaseOrderId);
    return {source:"gmail_proposal",period:null,agentId:"maya",missing:[],
     proposalCreated:true,draft:true,saved:false,approvalRequired:true,requiredApproval:"owner_click",
     operation:"send",sent:false,...result};
   }catch{return {source:"supplier_vendor_dispatch",period:null,agentId:"maya",
    missing:["supplier_followup_requires_verified_contact_or_open_evidence"],proposalCreated:false,sent:false};}
  }
 },
 inspect_supplier_purchase:{
  agentId:"maya",schema:supplierPurchaseInputSchema,
  description:"Inspect future order using canonical ingredients/saved quotes, required quantity/unit, needed-by (null if unspecified). Returns café-currency carts, integer-cent subtotals and gaps. Subtotal excludes unknown shipping/tax; public snippets aren't firm offers. No invented prices. Read-only before proposal.",
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
  description:"After quote inspection SAVE future PO draft, not received-stock propose_purchases. Server recomputes ingredient, availability, currency, quote, pack, freight/tax uncertainty; no model prices/authority. New/separate order replaceProposalId=null. Explicit correction: read get_supplier_purchase_orders, match exact draft UUID; clarify ambiguity, never infer replacement from increase/change. Server checks owner/café/thread/revision. Exact owner click readies order; no send/stock/expense.",
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
  description:"Record explicit CURRENT authenticated owner outcome for ONE saved PO after get_supplier_purchase_orders. Only exact PO/channel/outcome; server attaches verbatim owner message. Owner-reported canonical outcome closes matching terminal notice, not independent acceptance/delivery/stock/expense proof. Never infer from Gmail SENT, history, ambiguous yes or other café. Clarify target/outcome; no model note/claims.",
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
  description:"Draft separate inert Gmail SEND approval for approved saved PO after get_supplier_purchase_orders, inspect vendorCommunications/Gmail permission. Server uses PO and owner-verified recipient; never auto-send. No history ≠ unreachable. Missing verified contact/permission or phone/portal: explain gaps, ask_owner channel/prior negotiation/outcome. No invented addresses, acceptance or retries.",
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
