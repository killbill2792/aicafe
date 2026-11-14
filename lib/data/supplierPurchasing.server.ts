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
    "available_status,available_checked_at,delivery_on")
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
 sentToSupplier:false;receivedIntoInventory:false;
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
 return {orders:orders.map(row=>({
  id:row.id,status:row.status,revision:row.revision,supplierName:row.supplier_name_snapshot,
  currency:row.currency_code,subtotalCents:row.subtotal_cents,neededBy:row.needed_by,
  approvedAt:row.approved_at,
  lines:(lines.data??[]).filter(line=>line.purchase_order_id===row.id).map(line=>({
   itemName:line.item_name_snapshot,packs:line.packs,
   packUnit:line.pack_unit,packQuantity:line.pack_quantity,
   lineSubtotalCents:line.subtotal_cents,quotedOn:line.quoted_on
  })),
  sentToSupplier:false as const,receivedIntoInventory:false as const,
 })),truncated:(result.data??[]).length>40};
}
