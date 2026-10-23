import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";

/** Rebuild derived, date-scoped facts from canonical orders. CSV synthetic orders
 * have no real transaction hour: they are excluded from hourly analytics. */
export async function rebuildSalesFactRollups(db:SupabaseClient,businessId:string,dates:string[],timezone:string) {
 for(const date of [...new Set(dates)]) {
  const {data,error}=await db.from("orders")
   .select("id,location_id,closed_at,employee_id,net_sales_cents,pos_order_id")
   .eq("business_id",businessId).eq("business_date",date);
  if(error)throw error;
  const hourly=new Map<string,{business_id:string;location_id:string|null;business_date:string;hour_local:number;net_sales_cents:number;orders_count:number}>();
  const staff=new Map<string,{business_id:string;employee_id:string;business_date:string;net_sales_cents:number;orders_count:number}>();
  for(const o of data??[]) {
   if(!Number.isSafeInteger(Number(o.net_sales_cents)))throw new Error("Unsafe POS amount");
   if(!o.pos_order_id.startsWith("csv-")) {
    const hour=Number(formatInTimeZone(new Date(o.closed_at),timezone,"H"));
    const k=JSON.stringify([o.location_id,hour]);
    const row=hourly.get(k)??{business_id:businessId,location_id:o.location_id,business_date:date,hour_local:hour,net_sales_cents:0,orders_count:0};
    row.net_sales_cents+=Number(o.net_sales_cents);row.orders_count++;hourly.set(k,row);
   }
   if(o.employee_id) {
    const row=staff.get(o.employee_id)??{business_id:businessId,employee_id:o.employee_id,business_date:date,net_sales_cents:0,orders_count:0};
    row.net_sales_cents+=Number(o.net_sales_cents);row.orders_count++;staff.set(o.employee_id,row);
   }
  }
  // Production tables may not have a unique constraint; replace date partitions.
  // Never mutate orders or payroll facts.
  for(const [table,rows] of [["hourly_sales_rollup",[...hourly.values()]],["employee_sales_rollup",[...staff.values()]]] as const) {
   const removed=await db.from(table).delete().eq("business_id",businessId).eq("business_date",date);
   if(removed.error)throw removed.error;
   if(rows.length){const inserted=await db.from(table).insert(rows);if(inserted.error)throw inserted.error;}
  }
 }
}
