import "server-only";
import {z} from "zod";
import {effectHash,registerLoopCapability,proposeLoop,type OwnerLoopScope} from "./engine";
import {readSupplierReconciliation} from "@/lib/data/supplierReceiving.server";
import {proposalRequestKey} from "./requestKeys";
import {simulationOwnerReader} from "./simulationOwner.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {computeDedupeKey} from "@/lib/expenses/dedupeKey";
import {readSupplierPurchaseOrders} from "@/lib/data/supplierPurchasing.server";

/** Prepare, never send, the same immutable owner-click Gmail effect.
 * Recipient and evidence versions are server-derived. Reservation is made
 * only after the existing gateway's click; a lost provider response cannot
 * generate another send for the same discrepancy revision. */
export async function prepareSupplierDiscrepancyFollowup(scope:OwnerLoopScope,purchaseOrderId:string){
 const {client}=await simulationOwnerReader(scope);
 const result=await readSupplierReconciliation(client,scope.businessId,scope.ownerUserId,purchaseOrderId);
 const r=result.reconciliation;
 if(result.missing.length||!r||r.poStatus!=="approved_for_ordering"||!r.issues.length||r.closureVerified)
   throw new Error("supplier_followup_evidence_unavailable");
 const {data:contact,error}=await client.from("cafe_supplier_order_contacts")
   .select("id,email,verified_at,revoked_at,channel")
   .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
   .eq("supplier_id",r.supplierId).maybeSingle();
 if(error||!contact?.email||!contact.verified_at||contact.revoked_at||contact.channel!=="gmail")
   throw new Error("supplier_followup_verified_contact_required");
 const binding={purchaseOrderId:r.purchaseOrderId,contactId:contact.id,poRevision:r.poRevision,
   receiptVersions:r.receiptVersionCount,invoiceVersions:r.invoiceVersionCount};
 const eventKey="followup:"+binding.poRevision+":"+binding.receiptVersions+":"+binding.invoiceVersions;
 const reserved=await client.from("purchase_reconciliation_events").select("id")
   .eq("business_id",scope.businessId).eq("purchase_order_id",r.purchaseOrderId).eq("event_key",eventKey).limit(1);
 if(reserved.error||reserved.data?.length)throw new Error("supplier_followup_already_attempted");
 // Report actual stored receipt facts, not a guess about physical arrival,
 // and never send internal accounting or payment information to the supplier.
 const lines=r.lines.map(l=>l.itemName+": ordered "+l.orderedQuantity+" "+l.baseUnit+
   (r.physicalEvidenceStatus==="recorded_evidence"?
    "; recorded accepted "+l.acceptedQuantity+" "+l.baseUnit+"; damaged "+l.damagedQuantity+" "+l.baseUnit:
    "; physical receiving not yet verified"));
 const body="Hello, please help us reconcile purchase order "+r.purchaseOrderId+".\n"+
   lines.join("\n")+"\nPlease confirm delivery status and remaining quantities and clarify or correct any invoice discrepancies. "+
   "Thank you.";
 const [{gmailCapabilityId},{supervisorLoopRegistry},{SupabaseLoopRepository}]=await Promise.all([
   import("./gmail.server"),import("./priceExperiment.server"),import("./supabase.server")
 ]);
 const key=proposalRequestKey(scope.threadId,JSON.stringify({supplierFollowup:binding,recipient:contact.email,body}));
 const draft=await proposeLoop(scope,supervisorLoopRegistry,new SupabaseLoopRepository(),gmailCapabilityId,{
   operation:"send",action:null,to:[contact.email],cc:[],bcc:[],subject:"Purchase order follow-up "+r.purchaseOrderId,
   body,messageId:null,threadId:null,labelId:null,labelName:null,supplierFollowup:binding
 },key);
 if(draft.status!=="draft")throw new Error("supplier_followup_no_new_send");
 return {proposalId:draft.id,revision:draft.revision,purchaseOrderId:r.purchaseOrderId,recipient:contact.email};
}

export const supplierReceivingCapabilityId="maya.supplier_receiving.v1";
const ref=z.string().trim().min(1).max(160);
const quantity=z.number().int().nonnegative().max(10000000000000);
const line=z.strictObject({orderLineId:z.uuid(),receivedBase4:quantity,acceptedBase4:quantity,damagedBase4:quantity});
export const receivingInputSchema=z.strictObject({
 purchaseOrderId:z.uuid(),receivingReference:ref,receivedOn:z.iso.date(),
 // A reference identifies the SAME physical installment across source channels.
 // Do not create a replacement reference for a corrected receipt.
 expectedReceiptRevision:z.number().int().nonnegative().safe(),
 lines:z.array(line).min(1).max(10)
});
export type ReceivingInput=z.infer<typeof receivingInputSchema>;
const effectSchema=z.strictObject({
 ...receivingInputSchema.shape,
 poRevision:z.number().int().positive().safe(),
 supplierId:z.uuid(),supplierName:z.string().min(1).max(120),
 lines:z.array(z.strictObject({...line.shape,ingredientId:z.uuid(),itemName:z.string().min(1).max(160),
  baseUnit:z.enum(["g","ml","each"])})).min(1).max(10)
});
export const supplierReceivingCapability=registerLoopCapability({
 id:supplierReceivingCapabilityId,version:1,inputSchema:receivingInputSchema,effectSchema,
 proposalDescription:"Prepare a physical receiving confirmation for one exact PO and delivery reference. Owner must review and explicitly attest actual quantities and condition before stock changes. Never use an invoice, supplier dispatch or future order as receipt evidence.",
 dependencyScope:effect=>({kind:"supplier_receiving",purchaseOrderId:effect.purchaseOrderId}),
 simulate:async(scope,input)=>{
  const {client}=await simulationOwnerReader(scope);
  const result=await readSupplierPurchaseOrders(client,scope.businessId,scope.ownerUserId,input.purchaseOrderId);
  const po=result.orders[0];
  if(result.truncated||result.orders.length!==1||!po||po.id!==input.purchaseOrderId||
    po.status!=="approved_for_ordering"||!po.supplierId)throw new Error("receiving_po_unavailable");
  const reference=input.receivingReference.trim().toLowerCase();
  const {data,error}=await client.from("purchase_receipts").select("id,revision")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .eq("purchase_order_id",po.id).eq("receiving_reference",reference)
    .order("revision",{ascending:false}).limit(1);
  if(error||Number(data?.[0]?.revision??0)!==input.expectedReceiptRevision)
    throw new Error("receiving_revision_changed");
  if(new Set(input.lines.map(l=>l.orderLineId)).size!==input.lines.length)
    throw new Error("receiving_line_duplicate");
  const lines=input.lines.map(l=>{
   const source=po.lines.find(p=>p.orderLineId===l.orderLineId);
   if(!source?.ingredientId||!source.baseUnit||l.receivedBase4!==l.acceptedBase4+l.damagedBase4)
     throw new Error("receiving_line_invalid");
   return {...l,ingredientId:source.ingredientId,itemName:source.itemName,baseUnit:source.baseUnit};
  });
  if(!input.expectedReceiptRevision&&lines.some(l=>l.receivedBase4===0))
   throw new Error("receiving_quantity_missing");
  // The approval UI is the physical-side attestation boundary: model-extracted
  // facts are a draft, not authenticated receipt or permission before the click.
  return {effect:effectSchema.parse({...input,receivingReference:reference,poRevision:po.revision,
   supplierId:po.supplierId,supplierName:po.supplierName,lines}),
   baseline:{ownerMustConfirmPhysicalReceipt:true,stockOnly:true,invoiceOrDispatchIsNotReceipt:true},
   monitorSpec:{durationDays:1,metricScope:"supplier_receiving"}};
 },
 commit:async(scope,effect,proposalId)=>{
  if(!proposalId)throw new Error("receiving_proposal_required");
  const db=await createServerSupabaseClient();
  const {data:{user},error:authError}=await db.auth.getUser();
  if(authError||user?.id!==scope.ownerUserId)throw new Error("receiving_owner_required");
  // Authenticated owner session + exact click attempt from the existing
  // gateway. The SQL transaction calls the canonical Pantry RPC, never
  // an independent stock writer or service-role impersonation.
  const {data,error}=await db.rpc("supervisor_commit_supplier_receiving",{
   p_business_id:scope.businessId,p_thread_id:scope.threadId,
   p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(error||!data||data.purchaseOrderId!==effect.purchaseOrderId||
    Number(data.revision)!==effect.expectedReceiptRevision+1||
    typeof data.receiptId!=="string")throw new Error("receiving_effect_unverified",{cause:error});
  const proof=await createAdminSupabaseClient().rpc("supervisor_supplier_receiving_effect_proof",{
   p_business_id:scope.businessId,p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(proof.error||proof.data!==data.receiptId)throw new Error("receiving_stock_readback_unverified");
  return {status:"verified",evidenceSource:"purchase_receipts+pantry_stock_purchases"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{},recommendation:"keep",source:"purchase_receipts"})
});

export const supplierInvoiceCapabilityId="maya.supplier_invoice.v1";
const cents=z.number().int().nonnegative().max(900000000000000);
const invoiceLine=z.strictObject({
 orderLineId:z.uuid().nullable(),sourceItemName:z.string().trim().min(1).max(200),
 quantityBase4:quantity.positive().nullable(),subtotalCents:cents
});
export const invoiceInputSchema=z.strictObject({
 purchaseOrderId:z.uuid().nullable(),standaloneSupplierName:z.string().trim().min(2).max(120).nullable().optional(),invoiceReference:ref,expectedInvoiceRevision:z.number().int().nonnegative().safe(),
 issuedOn:z.iso.date(),dueOn:z.iso.date().nullable(),currency:z.string().regex(/^[A-Z]{3}$/),
 subtotalCents:cents,taxCents:cents.nullable(),freightCents:cents.nullable(),
 discountCents:cents.nullable(),totalCents:cents,lines:z.array(invoiceLine).min(1).max(50),
 // Only an explicitly requested, independently confirmed accounting event
 // may enter canonical expenses. Default null retains a supplier claim.
 expenseDate:z.iso.date().nullable(),existingExpenseId:z.uuid().nullable()
});
export type InvoiceInput=z.infer<typeof invoiceInputSchema>;
export const invoiceToolInputSchema=z.strictObject({...invoiceInputSchema.shape,gmailMessageId:z.string().min(8).max(100).nullable()});
export type InvoiceToolInput=z.infer<typeof invoiceToolInputSchema>;
const invoiceSourceSchema=z.strictObject({
 sourceRef:z.string().min(1).max(400),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
 sourceKind:z.enum(["owner_report","owner_attachment","gmail_message"])
});
const invoiceProposalInput=z.strictObject({...invoiceInputSchema.shape,...invoiceSourceSchema.shape});
const invoiceEffectSchema=z.strictObject({...invoiceProposalInput.shape,
 poRevision:z.number().int().positive().safe().nullable(),supplierId:z.uuid(),supplierName:z.string().min(1).max(120),
 expenseDedupeKey:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 lines:z.array(z.strictObject({...invoiceLine.shape,ingredientId:z.uuid().nullable(),baseUnit:z.enum(["g","ml","each"]).nullable()})).min(1).max(50)
});
export type InvoiceSource=z.infer<typeof invoiceSourceSchema>;
export const supplierInvoiceCapability=registerLoopCapability({
 id:supplierInvoiceCapabilityId,version:1,inputSchema:invoiceProposalInput,effectSchema:invoiceEffectSchema,
 proposalDescription:"Draft a vendor invoice reconciliation; owner confirms invoice identity and values. Invoice alone never verifies physical receipt or payment. Record an actual canonical expense only when the owner explicitly requested recognition on a specific date.",
 dependencyScope:effect=>({kind:"supplier_invoice",purchaseOrderId:effect.purchaseOrderId}),
 simulate:async(scope,input)=>{
  const {client}=await simulationOwnerReader(scope);
  if(input.purchaseOrderId===null){
   if(!input.standaloneSupplierName||input.expenseDate||input.existingExpenseId||input.sourceKind==="gmail_message"||input.lines.some(l=>l.orderLineId!==null))
    throw new Error("standalone_invoice_requires_owner_document_no_expense_or_order_line");
   const {data:supplier,error}=await client.from("cafe_suppliers").select("id,display_name")
    .eq("business_id",scope.businessId).eq("normalized_name",input.standaloneSupplierName.trim().toLowerCase()).maybeSingle();
   const reference=input.invoiceReference.trim().toLowerCase();
   if(error||!supplier)throw new Error("standalone_invoice_supplier_not_saved");
   const prior=await client.from("supplier_invoices").select("purchase_order_id,revision,owner_user_id")
    .eq("business_id",scope.businessId).eq("supplier_id",supplier.id).eq("invoice_reference",reference)
    .order("revision",{ascending:false}).limit(1);
   if(prior.error||Number(prior.data?.[0]?.revision??0)!==input.expectedInvoiceRevision||
    (prior.data?.[0]&&(prior.data[0].purchase_order_id!==null||prior.data[0].owner_user_id!==scope.ownerUserId)))
     throw new Error("invoice_identity_or_revision_changed");
   return {effect:invoiceEffectSchema.parse({...input,invoiceReference:reference,
    poRevision:null,supplierId:supplier.id,supplierName:supplier.display_name,expenseDedupeKey:null,
    lines:input.lines.map(l=>({...l,ingredientId:null,baseUnit:null}))}),
    baseline:{ownerConfirmsInvoice:true,expenseRecognitionRequested:false,stockEffect:false,paymentEffect:false,exactInvoice:false},
    monitorSpec:{durationDays:1,metricScope:"supplier_invoice"}};
  }
  if(input.standaloneSupplierName)throw new Error("invoice_choose_one_identity");
  const result=await readSupplierPurchaseOrders(client,scope.businessId,scope.ownerUserId,input.purchaseOrderId);
  const po=result.orders[0];
  if(result.truncated||result.orders.length!==1||!po||po.id!==input.purchaseOrderId||
    po.status!=="approved_for_ordering"||!po.supplierId)throw new Error("invoice_po_unavailable");
  const reference=input.invoiceReference.trim().toLowerCase();
  const {data,error}=await client.from("supplier_invoices").select("purchase_order_id,revision")
    .eq("business_id",scope.businessId).eq("supplier_id",po.supplierId).eq("invoice_reference",reference)
    .order("revision",{ascending:false}).limit(1);
  if(error||Number(data?.[0]?.revision??0)!==input.expectedInvoiceRevision||
    (data?.[0]&&data[0].purchase_order_id!==po.id))throw new Error("invoice_identity_or_revision_changed");
  const lines=input.lines.map(l=>{
   const source=l.orderLineId?po.lines.find(p=>p.orderLineId===l.orderLineId):null;
   if(l.orderLineId&&(!source?.ingredientId||!source.baseUnit||l.quantityBase4===null))
     throw new Error("invoice_line_identity_missing");
   return {...l,ingredientId:source?.ingredientId??null,baseUnit:source?.baseUnit??null};
  });
  const exactInvoice=input.currency===po.currency&&
   lines.every(l=>l.ingredientId&&l.quantityBase4!==null)&&
   lines.reduce((sum,l)=>sum+BigInt(l.subtotalCents),BigInt(0))===BigInt(input.subtotalCents)&&
   input.taxCents!==null&&input.freightCents!==null&&input.discountCents!==null&&
   BigInt(input.subtotalCents)+BigInt(input.taxCents)+BigInt(input.freightCents)-BigInt(input.discountCents)===BigInt(input.totalCents);
  if(input.expenseDate&&!exactInvoice)throw new Error("invoice_expense_requires_complete_evidence");
  if(input.existingExpenseId&&!input.expenseDate)throw new Error("invoice_existing_expense_date_required");
  if(input.existingExpenseId){
   const expense=await client.from("expenses").select("id,dedupe_key,status")
    .eq("business_id",scope.businessId).eq("id",input.existingExpenseId).maybeSingle();
   if(expense.error||!expense.data||expense.data.status!=="actual"||
    expense.data.dedupe_key!==computeDedupeKey({businessId:scope.businessId,spentOn:input.expenseDate!,
     amountCents:input.totalCents,vendor:po.supplierName}))
     throw new Error("invoice_existing_expense_mismatch");
  }
  return {effect:invoiceEffectSchema.parse({...input,invoiceReference:reference,lines,
    poRevision:po.revision,supplierId:po.supplierId,supplierName:po.supplierName,
    expenseDedupeKey:input.expenseDate?computeDedupeKey({businessId:scope.businessId,
     spentOn:input.expenseDate,amountCents:input.totalCents,vendor:po.supplierName}):null}),
    baseline:{ownerConfirmsInvoice:true,expenseRecognitionRequested:input.expenseDate!==null,
     stockEffect:false,paymentEffect:false,exactInvoice},
    monitorSpec:{durationDays:1,metricScope:"supplier_invoice"}};
 },
 commit:async(scope,effect,proposalId)=>{
  if(!proposalId)throw new Error("invoice_proposal_required");
  const db=await createServerSupabaseClient();
  const {data:{user},error:authError}=await db.auth.getUser();
  if(authError||user?.id!==scope.ownerUserId)throw new Error("invoice_owner_required");
  const {data,error}=await db.rpc("supervisor_commit_supplier_invoice",{
   p_business_id:scope.businessId,p_thread_id:scope.threadId,p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(error||!data||data.purchaseOrderId!==effect.purchaseOrderId||
    Number(data.revision)!==effect.expectedInvoiceRevision+1||typeof data.invoiceId!=="string")
    throw new Error("invoice_effect_unverified",{cause:error});
  const proof=await createAdminSupabaseClient().rpc("supervisor_supplier_invoice_effect_proof",{
    p_business_id:scope.businessId,p_proposal_id:proposalId,p_effect_hash:effectHash(effect)
  });
  if(proof.error||proof.data!==data.invoiceId)throw new Error("invoice_finance_readback_unverified");
  return {status:"verified",evidenceSource:"supplier_invoices+expenses"};
 },
 monitor:async()=>null,
 report:async()=>({status:"complete",result:{},recommendation:"keep",source:"supplier_invoices"})
});
