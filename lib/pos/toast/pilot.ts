import "server-only";
import {createHash} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosOrder} from "@/lib/pos/types";
import {ToastApiError,GUID} from "./client";
import {createToastAdapter} from "./adapter";
import {z} from "zod";
export const businessDateSchema=z.iso.date();
export type ToastDaySnapshot=ReturnType<typeof snapshotToastBusinessDay>;
function safeSum(xs:number[]) {
 const sum=xs.reduce((a,b)=>a+b,0);
 if(!Number.isSafeInteger(sum))throw new ToastApiError("invalid_response");
 return sum;
}
export function snapshotToastBusinessDay(orders:PosOrder[],date:string,restaurantGuid:string) {
 if(!businessDateSchema.safeParse(date).success||!GUID.safeParse(restaurantGuid).success)
   throw new ToastApiError("invalid_response");
 if(orders.length>2000)throw new ToastApiError("invalid_response");
 const seen=new Set<string>();
 const quantities:Record<string,number>={};
 for(const o of orders) {
   if(seen.has(o.posOrderId)||!o.posOrderId.startsWith("toast:"+restaurantGuid+":"))
     throw new ToastApiError("invalid_response");
   seen.add(o.posOrderId);
   if(!Number.isFinite(new Date(o.closedAt).getTime())||o.processingFeeStatus!=="missing")
     throw new ToastApiError("invalid_response");
   for(const line of o.lines) {
     if(line.voided||!line.posItemId)continue;
     if(!Number.isFinite(line.quantity)||line.quantity<0)throw new ToastApiError("invalid_response");
     quantities[line.posItemId]=(quantities[line.posItemId]??0)+line.quantity;
   }
 }
 const canonical=[...orders].sort((a,b)=>a.posOrderId.localeCompare(b.posOrderId));
 return {
   business_date:date,restaurant_guid:restaurantGuid,order_count:orders.length,
   gross_sales_cents:safeSum(orders.map(o=>o.grossSalesCents)),
   net_sales_cents:safeSum(orders.map(o=>o.netSalesCents)),
   discounts_cents:safeSum(orders.map(o=>o.discountsCents)),
   refunds_cents:safeSum(orders.map(o=>o.refundsCents)),
   tax_cents:safeSum(orders.map(o=>o.taxCents)),
   tip_cents:safeSum(orders.map(o=>o.tipCents)),
   product_quantities:Object.fromEntries(Object.entries(quantities).sort(([a],[b])=>a.localeCompare(b))),
   orders_snapshot:canonical,
   snapshot_sha256:createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
 };
}
export const reportSchema=z.object({
 orderCount:z.number().int().nonnegative(),
 grossSalesCents:z.number().int(),
 netSalesCents:z.number().int(),
 discountsCents:z.number().int(),
 refundsCents:z.number().int(),
 taxCents:z.number().int(),
 tipCents:z.number().int(),
 productQuantities:z.record(z.string(),z.number().nonnegative()),
}).strict();
export function matchToastReport(snapshot:ToastDaySnapshot,report:z.infer<typeof reportSchema>):boolean {
 const computed=JSON.stringify(Object.entries(snapshot.product_quantities).sort());
 const supplied=JSON.stringify(Object.entries(report.productQuantities).sort());
 return snapshot.order_count===report.orderCount &&
 snapshot.gross_sales_cents===report.grossSalesCents &&
 snapshot.net_sales_cents===report.netSalesCents &&
 snapshot.discounts_cents===report.discountsCents &&
 snapshot.refunds_cents===report.refundsCents &&
 snapshot.tax_cents===report.taxCents && snapshot.tip_cents===report.tipCents &&
 computed===supplied;
}
export async function stageToastOneDay(
 db:SupabaseClient,params:{businessId:string;locationId:string;restaurantGuid:string;businessDate:string}
) {
 const {businessId,locationId,restaurantGuid,businessDate}=params;
 if(!businessDateSchema.safeParse(businessDate).success||businessDate>new Date().toISOString().slice(0,10)||!GUID.safeParse(restaurantGuid).success||
    !GUID.safeParse(businessId).success||!GUID.safeParse(locationId).success)
    throw new ToastApiError("invalid_response");
 const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
   .select("verified_at,location_id").eq("business_id",businessId)
   .eq("restaurant_guid",restaurantGuid).maybeSingle();
 if(mapError||!mapping?.verified_at||mapping.location_id!==locationId)
   throw new ToastApiError("unauthorized_location");
 const adapter=createToastAdapter({db,businessId,restaurantGuid});
 const iso=businessDate.replace(/-/g,"");
 const orders=await adapter.fetchBusinessDayOrders(iso);
 const snapshot=snapshotToastBusinessDay(orders,businessDate,restaurantGuid);
 const {data:existing,error:readError}=await db.from("toast_pilot_days")
   .select("snapshot_sha256,state").eq("business_id",businessId)
   .eq("restaurant_guid",restaurantGuid).eq("business_date",businessDate).maybeSingle();
 if(readError)throw new ToastApiError("unavailable");
 // Changed provider facts invalidate any previous manual report matching.
 const changed=existing?.snapshot_sha256!==snapshot.snapshot_sha256;
 const {error:saveError}=await db.from("toast_pilot_days").upsert({
   business_id:businessId,location_id:locationId,...snapshot,
   state:changed?"awaiting_report":existing?.state??"awaiting_report",
   report_checked_at:changed?null:undefined,fetched_at:new Date().toISOString(),
 },{onConflict:"business_id,restaurant_guid,business_date"});
 if(saveError)throw new ToastApiError("unavailable");
 const {error:healthError}=await db.from("toast_sync_health").upsert({
   business_id:businessId,restaurant_guid:restaurantGuid,
   last_attempt_at:new Date().toISOString(),last_order_fetch_at:new Date().toISOString(),
   last_failure_category:null,
 },{onConflict:"business_id,restaurant_guid"});
 if(healthError)throw new ToastApiError("unavailable");
 return {orderCount:snapshot.order_count,grossSalesCents:snapshot.gross_sales_cents,
   netSalesCents:snapshot.net_sales_cents,checksum:snapshot.snapshot_sha256,
   state:changed?"awaiting_report":existing?.state??"awaiting_report"};
}
/** Separate checks before canonical sales are touched; this module intentionally
 * CANNOT mark rollups actual or import orders without an authorized reconciliation step. */
export async function reconcileStagedDay(db:SupabaseClient,params:{
 businessId:string;restaurantGuid:string;businessDate:string;
 report:z.infer<typeof reportSchema>
}) {
 const {businessId,restaurantGuid,businessDate,report}=params;
 const {data,error}=await db.from("toast_pilot_days")
   .select("*").eq("business_id",businessId)
   .eq("restaurant_guid",restaurantGuid).eq("business_date",businessDate).maybeSingle();
 if(error||!data)throw new ToastApiError("not_configured");
 const snapshot=data as ToastDaySnapshot;
 const matches=matchToastReport(snapshot,report);
 const {error:save}=await db.from("toast_pilot_days").update({
   state:matches?"matched_owner_report":"needs_review",
   report_checked_at:new Date().toISOString(),
 }).eq("business_id",businessId).eq("restaurant_guid",restaurantGuid)
   .eq("business_date",businessDate).eq("snapshot_sha256",snapshot.snapshot_sha256);
 if(save)throw new ToastApiError("unavailable");
 return {matches,state:matches?"matched_owner_report":"needs_review"};
}
