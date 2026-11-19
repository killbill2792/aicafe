import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readSupplierPurchaseOrders} from "./supplierPurchasing.server";
import {reconcilePurchaseOrder,type ReceivingDocument,type InvoiceDocument} from "@/lib/purchasing/reconciliation";

const docLimit=100,lineLimit=500;
const integer=(value:unknown):number=>{
 if(typeof value==="number"&&Number.isSafeInteger(value))return value;
 if(typeof value==="string"&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value)))return Number(value);
 return NaN;
};
const nullableInteger=(value:unknown):number|null=>value===null?null:integer(value);

/** Owner and café scope is supplied by the existing authenticated caller.
 * Never accept a model-provided owner or business. Bounded history includes
 * every revision needed by the pure comparison; truncation fails closed. */
export async function readSupplierReconciliation(db:SupabaseClient,
 businessId:string,ownerUserId:string,purchaseOrderId:string){
 const orderResult=await readSupplierPurchaseOrders(db,businessId,ownerUserId,purchaseOrderId);
 const po=orderResult.orders.find(o=>o.id===purchaseOrderId);
 if(!po||!po.supplierId)return {missing:["purchase_order_unavailable"],reconciliation:null};
 if(orderResult.truncated||orderResult.orders.length!==1)
  return {missing:["purchase_order_scope_ambiguous"],reconciliation:null};
 if(po.lines.some(l=>!l.orderLineId||!l.ingredientId||!l.baseUnit||!l.orderedBaseQuantity))
  return {missing:["purchase_order_line_identity_or_conversion_missing"],reconciliation:null};
 const [receipts,invoices]=await Promise.all([
  db.from("purchase_receipts").select("id,receiving_reference,revision,business_id,purchase_order_id,supplier_id,verification_kind,verification_ref,verified_at,received_on,source_ref")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId)
   .eq("purchase_order_id",purchaseOrderId).eq("supplier_id",po.supplierId)
   .order("revision",{ascending:false}).limit(docLimit+1),
  db.from("supplier_invoices").select("id,invoice_reference,revision,business_id,purchase_order_id,supplier_id,currency_code,subtotal_cents,tax_cents,freight_cents,discount_cents,total_cents,canonical_expense_id,recognized_expense_on,recognized_expense_key,identity_verification_ref")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId)
   .eq("purchase_order_id",purchaseOrderId).eq("supplier_id",po.supplierId)
   .order("revision",{ascending:false}).limit(docLimit+1)
 ]);
 if(receipts.error||invoices.error)
  return {missing:["receiving_or_invoice_source_unavailable"],reconciliation:null};
 const rr=receipts.data??[],ii=invoices.data??[];
 if(rr.length>docLimit||ii.length>docLimit)
  return {missing:["receiving_or_invoice_history_truncated"],reconciliation:null};
 const [receiptLines,invoiceLines]=await Promise.all([
  rr.length?db.from("purchase_receipt_lines").select("receipt_id,source_line_key,order_line_id,ingredient_id,received_base4,accepted_base4,damaged_base4,canonical_stock_line_id")
   .eq("business_id",businessId).eq("purchase_order_id",purchaseOrderId)
   .in("receipt_id",rr.map(r=>r.id)).limit(lineLimit+1):Promise.resolve({data:[],error:null}),
  ii.length?db.from("supplier_invoice_lines").select("invoice_id,source_line_key,order_line_id,ingredient_id,quantity_base4,subtotal_cents")
   .eq("business_id",businessId).eq("purchase_order_id",purchaseOrderId)
   .in("invoice_id",ii.map(r=>r.id)).limit(lineLimit+1):Promise.resolve({data:[],error:null}),
 ]);
 if(receiptLines.error||invoiceLines.error)
  return {missing:["receiving_or_invoice_line_source_unavailable"],reconciliation:null};
 const rl=receiptLines.data??[],il=invoiceLines.data??[];
 if(rl.length>lineLimit||il.length>lineLimit)
  return {missing:["receiving_or_invoice_lines_truncated"],reconciliation:null};
 const newest=<T extends {revision:unknown}>(records:readonly T[],key:(record:T)=>string):T[]=>{
  const map=new Map<string,T>();
  for(const row of records){
   const old=map.get(key(row));
   if(!old||integer(row.revision)>integer(old.revision))map.set(key(row),row);
  }
  return [...map.values()];
 };
 const currentReceipts=newest(rr,r=>r.receiving_reference);
 const currentInvoices=newest(ii,r=>r.invoice_reference);
 const stockIds=[...new Set<string>(rl.flatMap(l=>l.canonical_stock_line_id?[String(l.canonical_stock_line_id)]:[]))];
 const expenseIds=[...new Set<string>(currentInvoices.flatMap(i=>i.canonical_expense_id?[String(i.canonical_expense_id)]:[]))];
 const [stockRead,expenseRead,closureRead]=await Promise.all([
  stockIds.length?db.from("pantry_stock_purchases").select("line_id,ingredient_id,purchase_date,quantity_base,voided_at,source,source_ref,cost_cents,expense_line_id")
   .eq("business_id",businessId).in("line_id",stockIds).limit(lineLimit+1):Promise.resolve({data:[],error:null}),
  expenseIds.length?db.from("expenses").select("id,amount_cents,spent_on,dedupe_key,status")
   .eq("business_id",businessId).in("id",expenseIds).limit(docLimit+1):Promise.resolve({data:[],error:null}),
  db.from("purchase_reconciliation_events").select("event_key")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId).eq("purchase_order_id",po.id)
   .eq("event_kind","closure_verified").eq("event_key","closure:"+po.revision+":"+rr.length+":"+ii.length)
   .limit(1)
 ]);
 const stockRows=stockRead.data??[],expenseRows=expenseRead.data??[];
 const activeReceiptIds=new Set(currentReceipts.map(r=>r.id));
 const activeLines=rl.filter(l=>activeReceiptIds.has(l.receipt_id));
 const activeStockIds=new Set(activeLines.flatMap(l=>l.canonical_stock_line_id?[String(l.canonical_stock_line_id)]:[]));
 const stockVerified=!stockRead.error&&currentReceipts.length>0&&
  stockRows.length===stockIds.length&&stockIds.every(id=>{
   const s=stockRows.find(r=>r.line_id===id);
   return Boolean(s&&(activeStockIds.has(id)?s.voided_at===null:s.voided_at!==null));
  })&&activeLines.length>0&&activeLines.every(l=>{
   const accepted=integer(l.accepted_base4);
   if(accepted===0)return !l.canonical_stock_line_id;
   if(!Number.isSafeInteger(accepted)||accepted<=0)return false;
   const receipt=currentReceipts.find(r=>r.id===l.receipt_id);
   const s=stockRows.find(r=>r.line_id===l.canonical_stock_line_id);
   return Boolean(receipt&&s&&s.voided_at===null&&s.ingredient_id===l.ingredient_id&&
    s.purchase_date===receipt.received_on&&Math.round(Number(s.quantity_base)*10000)===accepted&&
    s.source==="chat_text"&&s.source_ref==="supplier-receiving:"+po.id+":"+s.line_id&&
    s.cost_cents===null&&s.expense_line_id===null);
  });
 const expenseVerified=!expenseRead.error&&currentInvoices.length>0&&
  expenseRows.length===expenseIds.length&&currentInvoices.every(i=>{
   if(!i.canonical_expense_id)return !i.recognized_expense_on&&!i.recognized_expense_key;
   const x=expenseRows.find(row=>row.id===i.canonical_expense_id);
   return Boolean(x&&x.status==="actual"&&integer(x.amount_cents)===integer(i.total_cents)&&
    x.spent_on===i.recognized_expense_on&&x.dedupe_key===i.recognized_expense_key);
  });
 const normalizedReceipts:ReceivingDocument[]=rr.map(r=>({
  businessId:r.business_id,purchaseOrderId:r.purchase_order_id,supplierId:r.supplier_id,
  id:r.receiving_reference,revision:integer(r.revision),
  // Only authenticated receiving evidence stored by a verified gateway may
  // enter this restricted table. A supplier document alone is never enough.
  verifiedPhysicalReceipt:["owner_confirmed","authenticated_receiving_record"].includes(r.verification_kind)
   &&Boolean(r.verification_ref&&r.verified_at),
  lines:rl.filter(l=>l.receipt_id===r.id).map(l=>({
   id:l.source_line_key,orderLineId:l.order_line_id??"",ingredientId:l.ingredient_id??"",
   receivedBase4:integer(l.received_base4),acceptedBase4:integer(l.accepted_base4),
   damagedBase4:integer(l.damaged_base4)
  }))
 }));
 const normalizedInvoices:InvoiceDocument[]=ii.map(r=>({
  businessId:r.business_id,purchaseOrderId:r.purchase_order_id,supplierId:r.supplier_id,
  id:r.invoice_reference,revision:integer(r.revision),currency:r.currency_code,
  subtotalCents:integer(r.subtotal_cents),taxCents:nullableInteger(r.tax_cents),
  freightCents:nullableInteger(r.freight_cents),discountCents:nullableInteger(r.discount_cents),
  totalCents:integer(r.total_cents),lines:il.filter(l=>l.invoice_id===r.id).map(l=>({
   id:l.source_line_key,orderLineId:l.order_line_id??"",ingredientId:l.ingredient_id??"",
   quantityBase4:integer(l.quantity_base4),subtotalCents:integer(l.subtotal_cents)
  }))
 }));
 const compared=reconcilePurchaseOrder({
  businessId,id:po.id,supplierId:po.supplierId,currency:po.currency,
  lines:po.lines.map(l=>({id:l.orderLineId!,ingredientId:l.ingredientId!,
    orderedBase4:Math.round(l.orderedBaseQuantity!*10000),subtotalCents:integer(l.lineSubtotalCents)}))
 },normalizedReceipts,normalizedInvoices);
 const closureEvidenceReady=compared.matchingEvidence&&stockVerified&&expenseVerified&&po.status==="approved_for_ordering";
 const closureVerified=closureEvidenceReady&&!closureRead.error&&Boolean(closureRead.data?.length);
 return {missing:[...(stockRead.error?["canonical_stock_read_unavailable"]:[]),
   ...(expenseRead.error?["canonical_expense_read_unavailable"]:[]),
   ...(closureRead.error?["receiving_closure_read_unavailable"]:[])],reconciliation:{
  purchaseOrderId:po.id,supplierId:po.supplierId,poRevision:po.revision,supplierName:po.supplierName,
  currency:compared.currency,poStatus:po.status,neededBy:po.neededBy,
  // These are recorded evidence quantities, NOT a physical stock count.
  physicalEvidenceStatus:rr.length?"recorded_evidence":"not_yet_verified",
  verifiedInvoiceTotalCents:compared.verifiedInvoiceTotalCents,
  issues:compared.issues,matchingEvidence:compared.matchingEvidence,
  closureVerified,closureEvidenceReady,payableCents:closureEvidenceReady?compared.verifiedInvoiceTotalCents:null,paidCents:null,
  outstandingPaymentCents:null,
  canonicalStockEffectVerified:stockVerified,canonicalExpenseEffectVerified:expenseVerified&&expenseIds.length>0,
  expenseRecognitionStatus:expenseIds.length?expenseVerified?"verified":"unverified":"not_requested",
  receiptVersionCount:rr.length,invoiceVersionCount:ii.length,
  receipts:currentReceipts.map(r=>({receivingReference:r.receiving_reference,revision:integer(r.revision),
    receivedOn:r.received_on,lines:rl.filter(l=>l.receipt_id===r.id).map(l=>({
      orderLineId:l.order_line_id,receivedQuantity:integer(l.received_base4)/10000,
      acceptedQuantity:integer(l.accepted_base4)/10000,damagedQuantity:integer(l.damaged_base4)/10000}))})),
  invoices:currentInvoices.map(i=>({invoiceReference:i.invoice_reference,revision:integer(i.revision),
   totalCents:integer(i.total_cents),currency:i.currency_code,canonicalExpenseId:i.canonical_expense_id??null})),
  lines:compared.lines.map(l=>{
   const source=po.lines.find(line=>line.orderLineId===l.orderLineId)!;
   return {orderLineId:l.orderLineId,ingredientId:l.ingredientId,itemName:source.itemName,
    baseUnit:source.baseUnit,expectedDeliveryOn:source.expectedDeliveryOn,
    orderedQuantity:l.orderedBase4/10000,verifiedReceivedQuantity:l.verifiedReceivedBase4/10000,
    acceptedQuantity:l.acceptedBase4/10000,damagedQuantity:l.damagedBase4/10000,
    invoicedQuantity:l.invoicedBase4/10000,unverifiedOutstandingQuantity:l.outstandingBase4/10000};
  })
 }};
}
