import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {Ingredient,SupplierQuote} from "@/lib/purchasing/planOrder";

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
 subtotalCents:number;neededBy:string|null;approvedAt:string;
 lines:Array<{itemName:string;packs:number;packUnit:string;packQuantity:number;
  lineSubtotalCents:number;quotedOn:string}>;
 sentToSupplier:boolean;receivedIntoInventory:false;
};
/** The same authenticated read path used by Supervisor: no separate owner PO store.
 * Approved-for-ordering means prepared internally, never sent or delivered. */
export async function readSupplierPurchaseOrders(db:SupabaseClient,businessId:string,ownerUserId:string):
 Promise<{orders:SupplierOrderStatus[];truncated:boolean}>{
 const result=await db.from("purchase_orders")
  .select("id,status,revision,supplier_name_snapshot,currency_code,subtotal_cents,needed_by,approved_at")
  .eq("business_id",businessId).eq("owner_user_id",ownerUserId)
  .order("approved_at",{ascending:false}).limit(41);
 if(result.error)throw new Error("supplier_purchase_orders_unavailable");
 const orders=(result.data??[]).slice(0,40);
 if(!orders.length)return {orders:[],truncated:false};
 const lines=await db.from("purchase_order_lines")
  .select("purchase_order_id,item_name_snapshot,packs,pack_unit,pack_quantity,subtotal_cents,quoted_on,ordinal")
  .eq("business_id",businessId).in("purchase_order_id",orders.map(x=>x.id))
  .order("ordinal",{ascending:true}).limit(401);
 if(lines.error)throw new Error("supplier_purchase_order_lines_unavailable");
 if((lines.data??[]).length>400)throw new Error("supplier_purchase_order_lines_truncated");
 const dispatches=await db.from("purchase_order_dispatches")
   .select("purchase_order_id,state,provider_receipt_id").eq("business_id",businessId)
   .eq("owner_user_id",ownerUserId).in("purchase_order_id",orders.map(x=>x.id)).limit(41);
 if(dispatches.error)throw new Error("supplier_purchase_dispatch_status_unavailable");
 return {orders:orders.map(row=>({
  id:row.id,status:row.status,revision:row.revision,supplierName:row.supplier_name_snapshot,
  currency:row.currency_code,subtotalCents:row.subtotal_cents,neededBy:row.needed_by,
  approvedAt:row.approved_at,
  lines:(lines.data??[]).filter(line=>line.purchase_order_id===row.id).map(line=>({
   itemName:line.item_name_snapshot,packs:line.packs,
   packUnit:line.pack_unit,packQuantity:line.pack_quantity,
   lineSubtotalCents:line.subtotal_cents,quotedOn:line.quoted_on
  })),
  sentToSupplier:(dispatches.data??[]).some(d=>d.purchase_order_id===row.id&&
    d.state==="provider_accepted"&&Boolean(d.provider_receipt_id)),
  receivedIntoInventory:false as const,
 })),truncated:(result.data??[]).length>40};
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
  const report=(reports.data??[]).find(r=>r.purchase_order_id===order.id);
  const current=Boolean(contact?.verified_at&&!contact?.revoked_at);
  const state=dispatch?.state==="reserved"?"send_uncertain":dispatch?.state??"not_prepared";
  const question=!current?
   "Which channel do you use for this supplier: Gmail, phone, portal or something else? Please confirm the ordering contact.":
   contact?.channel!=="gmail"?
   "This supplier uses "+contact?.channel+". Was the order placed there, and what did they confirm?":
   state==="not_prepared"?"Shall I prepare this saved order as a Gmail send for your separate approval?":
   state==="prepared"?"The vendor email is drafted. Please approve it before any send.":
   state==="send_uncertain"?"Gmail outcome is uncertain. Please check the original email or help reconcile; I will not resend.":
   report?.outcome==="supplier_accepted"?null:"Gmail accepted the message, but did the supplier actually accept the order?";
  return {purchaseOrderId:order.id,state,channel:current?contact!.channel:null,
   recipient:current&&contact?.channel==="gmail"?contact.email:null,
   contactVerified:current,ownerReportedOutcome:report?.outcome??null,
   providerVerified:state==="provider_accepted"&&Boolean(dispatch?.provider_receipt_id),
   ownerQuestion:question};
 });
}
