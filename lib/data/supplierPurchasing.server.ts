import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {Ingredient,SupplierQuote} from "@/lib/purchasing/planOrder";
import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";

/** The sole purchasing evidence reader. Café identity and owner membership are
 * validated by simulationOwnerReader before this function is called. Never
 * turn old, currency-less quotes into current-currency offers. */
export async function readSupplierPurchasingEvidence(db:SupabaseClient,businessId:string){
 const [ingredients,quotes,business]=await Promise.all([
  db.from("ingredients").select("id,name,base_unit").eq("business_id",businessId)
    .is("archived_at",null).order("name").limit(2000),
  db.from("ai_supplier_quotes").select("id,supplier_name,item_name,ingredient_id,price_cents,"+
    "package_count,package_unit,currency_code,source_kind,quoted_on,valid_until,"+
    "available_status,available_checked_at,delivery_on,created_at")
    .eq("business_id",businessId).order("created_at",{ascending:false}).limit(501),
  db.from("businesses").select("currency,timezone").eq("id",businessId).maybeSingle(),
 ]);
 if(ingredients.error||quotes.error||business.error||!business.data)
  throw new Error("supplier_purchase_evidence_unavailable");
 if((ingredients.data??[]).length===2000)
  throw new Error("ingredient_catalog_truncated");
 if(!business.data.currency||!business.data.timezone)
  throw new Error("cafe_currency_or_timezone_missing");
 return {ingredients:(ingredients.data??[]) as Ingredient[],
  quotes:(quotes.data??[]).slice(0,500) as unknown as SupplierQuote[],
  truncated:(quotes.data??[]).length>500,
  currency:business.data.currency as string,timezone:business.data.timezone as string};
}

export type SupplierOrderStatus={
 id:string;status:string;revision:number;supplierName:string;currency:string;
 supplierId?:string;
 subtotalCents:number;neededBy:string|null;approvedAt:string;
 lines:Array<{itemName:string;packs:number;packUnit:string;packQuantity:number;
  lineSubtotalCents:number;quotedOn:string;
  orderLineId?:string;ingredientId?:string;baseUnit?:BaseUnit;orderedBaseQuantity?:number|null;
  unitPriceCents?:number;expectedDeliveryOn?:string|null}>;
 sentToSupplier:boolean;receivedIntoInventory:boolean;
 receivingEvidence?: "unavailable"|"not_yet_verified"|"partial_verified"|"complete_verified";
};
/** The same authenticated read path used by Supervisor: no separate owner PO store.
 * Approved-for-ordering means prepared internally, never sent or delivered. */
export async function readSupplierPurchaseOrders(db:SupabaseClient,businessId:string,ownerUserId:string,purchaseOrderId?:string):
 Promise<{orders:SupplierOrderStatus[];truncated:boolean}>{
 let query=db.from("purchase_orders")
  .select("id,status,revision,supplier_id,supplier_name_snapshot,currency_code,subtotal_cents,needed_by,approved_at")
  .eq("business_id",businessId).eq("owner_user_id",ownerUserId);
 if(purchaseOrderId)query=query.eq("id",purchaseOrderId);
 const result=await query.order("approved_at",{ascending:false}).limit(41);
 if(result.error)throw new Error("supplier_purchase_orders_unavailable");
 const orders=(result.data??[]).slice(0,40);
 if(!orders.length)return {orders:[],truncated:false};
 const lines=await db.from("purchase_order_lines")
  .select("id,purchase_order_id,ingredient_id,base_unit,item_name_snapshot,packs,pack_unit,pack_quantity,unit_price_cents,subtotal_cents,quoted_on,delivery_on,ordinal")
  .eq("business_id",businessId).in("purchase_order_id",orders.map(x=>x.id))
  .order("ordinal",{ascending:true}).limit(401);
 if(lines.error)throw new Error("supplier_purchase_order_lines_unavailable");
 if((lines.data??[]).length>400)throw new Error("supplier_purchase_order_lines_truncated");
 const dispatches=await db.from("purchase_order_dispatches")
   .select("purchase_order_id,state,provider_receipt_id").eq("business_id",businessId)
   .eq("owner_user_id",ownerUserId).in("purchase_order_id",orders.map(x=>x.id)).limit(41);
 if(dispatches.error)throw new Error("supplier_purchase_dispatch_status_unavailable");
 // Batched receipt and Pantry source reads, bounded and owner scoped.
 const receiptEvidence=await db.from("purchase_receipts")
  .select("id,purchase_order_id,receiving_reference,revision,received_on")
  .eq("business_id",businessId).eq("owner_user_id",ownerUserId)
  .in("purchase_order_id",orders.map(o=>o.id)).limit(401);
 const allReceipts=receiptEvidence.data??[];
 const latest=new Map<string,(typeof allReceipts)[number]>();
 for(const r of allReceipts){
  const key=r.purchase_order_id+":"+r.receiving_reference;
  if(!latest.has(key)||Number(r.revision)>Number(latest.get(key)!.revision))latest.set(key,r);
 }
 const currentReceipts=[...latest.values()];
 const receiptLines=currentReceipts.length?await db.from("purchase_receipt_lines")
  .select("receipt_id,purchase_order_id,order_line_id,ingredient_id,accepted_base4,canonical_stock_line_id")
  .eq("business_id",businessId).in("receipt_id",currentReceipts.map(r=>r.id)).limit(801):
  {data:[],error:null};
 const stockIds=[...new Set<string>((receiptLines.data??[]).flatMap(l=>l.canonical_stock_line_id?[String(l.canonical_stock_line_id)]:[]))];
 const stock=stockIds.length?await db.from("pantry_stock_purchases")
  .select("line_id,ingredient_id,purchase_date,quantity_base,source,source_ref,voided_at")
  .eq("business_id",businessId).in("line_id",stockIds).limit(801):{data:[],error:null};
 const statusFor=(id:string):SupplierOrderStatus["receivingEvidence"]=>{
  if(receiptEvidence.error||allReceipts.length>400||receiptLines.error||
    (receiptLines.data??[]).length>800||stock.error)return "unavailable";
  const receiptIds=new Set(currentReceipts.filter(r=>r.purchase_order_id===id).map(r=>r.id));
  if(!receiptIds.size)return "not_yet_verified";
  const accepted=new Map<string,number>();
  const selected=(receiptLines.data??[]).filter(l=>receiptIds.has(l.receipt_id));
  if(!selected.length)return "unavailable";
  for(const l of selected){
   const qty=Number(l.accepted_base4);
   if(l.accepted_base4===null||!Number.isSafeInteger(qty)||qty<0||!l.order_line_id)return "unavailable";
   if(!qty){if(l.canonical_stock_line_id)return "unavailable";continue;}
   const s=(stock.data??[]).find(r=>r.line_id===l.canonical_stock_line_id);
   const r=currentReceipts.find(rec=>rec.id===l.receipt_id);
   if(!s||!r||s.voided_at!==null||s.ingredient_id!==l.ingredient_id||
     s.purchase_date!==r.received_on||s.source!=="chat_text"||
     s.source_ref!=="supplier-receiving:"+id+":"+s.line_id||
     Math.round(Number(s.quantity_base)*10000)!==qty)return "unavailable";
   const total=(accepted.get(l.order_line_id)??0)+qty;
   if(!Number.isSafeInteger(total))return "unavailable";
   accepted.set(l.order_line_id,total);
  }
  if(!accepted.size)return "not_yet_verified";
  const ordered=(lines.data??[]).filter(l=>l.purchase_order_id===id);
  const equal=ordered.length>0&&ordered.every(l=>{
   const perPack=packBaseQuantity(Number(l.pack_quantity),l.pack_unit==="liter"?"l":l.pack_unit,l.base_unit as BaseUnit);
   return perPack!==null&&(accepted.get(l.id)??0)===Math.round(perPack*Number(l.packs)*10000);
  });
  return equal?"complete_verified":"partial_verified";
 };
 return {orders:orders.map(row=>({
  id:row.id,status:row.status,revision:row.revision,supplierName:row.supplier_name_snapshot,
  supplierId:row.supplier_id,
  currency:row.currency_code,subtotalCents:row.subtotal_cents,neededBy:row.needed_by,
  approvedAt:row.approved_at,
  lines:(lines.data??[]).filter(line=>line.purchase_order_id===row.id).map(line=>{
   // Reuse 14B pack conversion; needed quantity is not ordered quantity.
   // Preserve a missing/invalid conversion as unknown.
   const unit=line.base_unit as BaseUnit;
   const perPack=packBaseQuantity(Number(line.pack_quantity),
     line.pack_unit==="liter"?"l":line.pack_unit,unit);
   const scaled=perPack===null?null:Math.round(perPack*Number(line.packs)*10000);
   return {itemName:line.item_name_snapshot,packs:line.packs,
    packUnit:line.pack_unit,packQuantity:line.pack_quantity,
    lineSubtotalCents:line.subtotal_cents,quotedOn:line.quoted_on,
    orderLineId:line.id,ingredientId:line.ingredient_id,baseUnit:unit,
    orderedBaseQuantity:scaled!==null&&Number.isSafeInteger(scaled)&&scaled>0?scaled/10000:null,
    unitPriceCents:line.unit_price_cents,expectedDeliveryOn:line.delivery_on};
  }),
  sentToSupplier:(dispatches.data??[]).some(d=>d.purchase_order_id===row.id&&
    d.state==="provider_accepted"&&Boolean(d.provider_receipt_id)),
  receivedIntoInventory:statusFor(row.id)==="complete_verified"||statusFor(row.id)==="partial_verified",
  receivingEvidence:statusFor(row.id),
 })),truncated:(result.data??[]).length>40};
}

/** The owner-question answer is a projection of verified source and explicitly
 * attributed owner reports. A terminal supplier outcome is final for this PO
 * even if Gmail is disconnected or no provider dispatch was ever prepared. */
export function supplierCommunicationOwnerQuestion(input:{
 contactVerified:boolean;channel:string|null;state:string;
 ownerReportedOutcome:string|null
}):string|null{
 const {contactVerified,channel,state,ownerReportedOutcome}=input;
 if(ownerReportedOutcome==="supplier_accepted"||ownerReportedOutcome==="supplier_declined")return null;
 if(!contactVerified)
   return "Which channel do you use for this supplier: Gmail, phone, portal or something else? Please confirm the ordering contact.";
 if(channel!=="gmail")
   return "This supplier uses "+channel+". Was the order placed there, and what did they confirm?";
 if(state==="not_prepared")
   return "Shall I prepare this saved order as a Gmail send for your separate approval?";
 if(state==="prepared")
   return "The vendor email is drafted. Please approve it before any send.";
 if(state==="send_uncertain")
   return "Gmail outcome is uncertain. Please check the original email or help reconcile; I will not resend.";
 return "Gmail accepted the message, but did the supplier actually accept the order?";
}

/** The ONLY communication-status reader for those same saved POs. A reserved
 * Gmail POST with no verified receipt is uncertain, never "not sent". Off-Gmail
 * claims remain explicitly owner-reported and cannot prove provider delivery. */
export async function readSupplierOrderCommunications(
 db:SupabaseClient,businessId:string,ownerUserId:string,orderIds:string[]
):Promise<Array<{purchaseOrderId:string;state:string;channel:string|null;
 recipient:string|null;contactVerified:boolean;ownerReportedOutcome:string|null;
 providerVerified:boolean;ownerQuestion:string|null}>>{
 if(orderIds.length===0)return [];
 if(orderIds.length>40)throw new Error("vendor_order_scope_too_large");
 const orders=await db.from("purchase_orders").select("id,supplier_id")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId).in("id",orderIds);
 if(orders.error||orders.data?.length!==orderIds.length)
   throw new Error("vendor_order_status_unavailable");
 const supplierIds=[...new Set((orders.data??[]).map(o=>o.supplier_id))];
 const [contacts,dispatches,reports]=await Promise.all([
  db.from("cafe_supplier_order_contacts")
   .select("supplier_id,channel,email,verified_at,revoked_at")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId).in("supplier_id",supplierIds),
  db.from("purchase_order_dispatches").select("purchase_order_id,state,recipient_email,provider_receipt_id")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId).in("purchase_order_id",orderIds),
  db.from("purchase_order_channel_reports").select("purchase_order_id,outcome,reported_at")
   .eq("business_id",businessId).eq("owner_user_id",ownerUserId)
   .in("purchase_order_id",orderIds).order("reported_at",{ascending:false}).limit(400),
 ]);
 if(contacts.error||dispatches.error||reports.error)
   throw new Error("vendor_communication_status_unavailable");
 return (orders.data??[]).map(order=>{
  const contact=(contacts.data??[]).find(c=>c.supplier_id===order.supplier_id);
  const dispatch=(dispatches.data??[]).find(d=>d.purchase_order_id===order.id);
  const ownerReports=(reports.data??[]).filter(r=>r.purchase_order_id===order.id);
  // Terminal acceptance or decline must not be overwritten by later notes
  // labeled unknown/acknowledged. A correction needs an explicit owner action.
  const report=ownerReports.find(r=>r.outcome==="supplier_accepted"||r.outcome==="supplier_declined")
    ??ownerReports[0];
  const current=Boolean(contact?.verified_at&&!contact?.revoked_at);
  const state=dispatch?.state==="reserved"?"send_uncertain":dispatch?.state??"not_prepared";
  const question=supplierCommunicationOwnerQuestion({
   contactVerified:current,channel:contact?.channel??null,state,
   ownerReportedOutcome:report?.outcome??null
  });
  return {purchaseOrderId:order.id,state,channel:current?contact!.channel:null,
   recipient:current&&contact?.channel==="gmail"?contact.email:null,
   contactVerified:current,ownerReportedOutcome:report?.outcome??null,
   providerVerified:state==="provider_accepted"&&Boolean(dispatch?.provider_receipt_id),
   ownerQuestion:question};
 });
}
