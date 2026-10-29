import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {readToastTodaySoFar,type TodaySoFarRead} from "@/lib/pos/toast/todaySoFar.server";
import type {TodaySoFar} from "@/lib/pos/toast/todaySoFar";

/** The ONE path for "today so far": a live Toast reading saved every 15
 * minutes (cron) or when the chat needs a fresher one. Home and the chat both
 * read this saved reading, so they always show the same number. */
export const TODAY_LIVE_FRESH_MS=15*60_000;
const readingSchema=z.object({provisional:z.literal(true),businessDate:z.iso.date(),readAt:z.string(),
 netSalesCents:z.number().int(),grossSalesCents:z.number().int(),discountsCents:z.number().int(),
 refundsCents:z.number().int(),tipCents:z.number().int(),orders:z.number().int(),openChecks:z.number().int(),
 unparsedOrders:z.number().int(),topItems:z.array(z.object({name:z.string(),quantity:z.number(),netSalesCents:z.number().int()})),
 locationsRead:z.number().int(),locationsFailed:z.number().int(),truncated:z.boolean()});
const missingTable=(code:unknown)=>["42P01","PGRST205"].includes(String(code??""));

/** The latest saved reading and its age, or null (none yet, or table not installed). */
export async function readSavedTodayLive(db:SupabaseClient,businessId:string,now=new Date()):
 Promise<{value:TodaySoFar;ageMs:number}|null>{
 const {data,error}=await db.from("toast_today_live").select("reading,read_at")
  .eq("business_id",businessId).maybeSingle();
 if(error){if(missingTable(error.code))return null;throw error;}
 if(!data)return null;
 const parsed=readingSchema.safeParse(data.reading);
 if(!parsed.success)return null;
 return {value:parsed.data as TodaySoFar,ageMs:Math.max(0,now.getTime()-Date.parse(String(data.read_at)))};
}
export async function saveTodayLive(admin:SupabaseClient,businessId:string,value:TodaySoFar){
 const {error}=await admin.from("toast_today_live").upsert({business_id:businessId,business_date:value.businessDate,
  read_at:value.readAt,net_sales_cents:value.netSalesCents,orders:value.orders,reading:value,
  updated_at:new Date().toISOString()},{onConflict:"business_id"});
 if(error&&!missingTable(error.code))throw error;
}
/** A fresh saved reading, else a new live read from Toast (saved for everyone). */
export async function todaySoFarForBusiness(admin:SupabaseClient,businessId:string,
 opts:{now?:Date;maxAgeMs?:number}={}):Promise<TodaySoFarRead>{
 const now=opts.now??new Date();
 const saved=await readSavedTodayLive(admin,businessId,now).catch(()=>null);
 if(saved&&saved.ageMs<(opts.maxAgeMs??TODAY_LIVE_FRESH_MS))return {available:true,value:saved.value};
 const read=await readToastTodaySoFar(admin,businessId,now);
 // Only a complete reading replaces the saved one.
 if(read.available&&!read.value.locationsFailed&&!read.value.truncated)
  await saveTodayLive(admin,businessId,read.value).catch(()=>{});
 return read;
}
