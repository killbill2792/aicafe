import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import type {TodaySoFarRead} from "@/lib/pos/toast/todaySoFar.server";
import {currentToastBusinessDay,type TodaySoFar} from "@/lib/pos/toast/todaySoFar";
import {cafeToday} from "@/lib/metrics/core/clock";

/** The one shared provisional summary published by the Toast coordinator. */
export const TODAY_LIVE_FRESH_MS=15*60_000;
const readingSchema=z.object({provisional:z.literal(true),businessDate:z.iso.date(),readAt:z.string(),
 netSalesCents:z.number().int(),grossSalesCents:z.number().int(),discountsCents:z.number().int(),
 refundsCents:z.number().int(),tipCents:z.number().int(),orders:z.number().int(),openChecks:z.number().int(),
 unparsedOrders:z.number().int(),topItems:z.array(z.object({name:z.string(),quantity:z.number(),netSalesCents:z.number().int()})),
 locationsRead:z.number().int(),locationsFailed:z.number().int(),truncated:z.boolean(),
 hourlySales:z.array(z.object({hourLocal:z.number().int().min(0).max(23),
  netSalesCents:z.number().int(),ordersCount:z.number().int().nonnegative()})).max(24).optional(),
 hourlyUnassignedOrders:z.number().int().nonnegative().optional()});
const missingTable=(code:unknown)=>["42P01","PGRST205"].includes(String(code??""));

/** The latest saved reading and its age, or null (none yet, or table not installed). */
export async function readSavedTodayLive(db:SupabaseClient,businessId:string,now=new Date()):
 Promise<{value:TodaySoFar;ageMs:number}|null>{
 const {data,error}=await db.from("cv_sales_live").select("reading,read_at")
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
/** Toast's current business day for the café (before closeout, the previous date).
 * A café without its own verified Toast location (such as a test café that receives
 * a copied reading) uses today's date in its own time zone. */
export async function currentTodayBusinessDay(db:SupabaseClient,businessId:string,now=new Date()):Promise<string|null>{
 const {data,error}=await db.from("toast_location_mappings").select("toast_time_zone,closeout_hour")
  .eq("business_id",businessId).not("verified_at","is",null).limit(1).maybeSingle();
 if(error)return null;
 if(data?.toast_time_zone&&data.closeout_hour!=null)
  return currentToastBusinessDay(now,String(data.toast_time_zone),Number(data.closeout_hour));
 const cafe=await db.from("businesses").select("timezone").eq("id",businessId).maybeSingle();
 return !cafe.error&&cafe.data?.timezone?cafeToday(String(cafe.data.timezone),now):null;
}
/** Home and Luna read the one shared provisional snapshot. Never initiate a
 * full-day Toast retrieval from a user question. If stale, preserve its true
 * as-of and let the coordinator perform incremental recovery. */
export async function todaySoFarForBusiness(admin:SupabaseClient,businessId:string,
 opts:{now?:Date;maxAgeMs?:number;keepOrders?:boolean}={}):Promise<TodaySoFarRead>{
 const now=opts.now??new Date();
 const [saved,businessDay]=await Promise.all([readSavedTodayLive(admin,businessId,now).catch(()=>null),
  currentTodayBusinessDay(admin,businessId,now).catch(()=>null)]);
 if(saved&&businessDay&&saved.value.businessDate===businessDay)return {available:true,value:saved.value};
 return {available:false,missing:["todayLiveReadFailed"]};
}
/** Home's bounded attempt when no current-day saved reading exists.
 * Delegates to the ONE live reader; never introduces another Toast query. */
export async function readHomeTodayLiveFallback(admin:SupabaseClient,businessId:string,timeoutMs=4_000):
 Promise<{value:TodaySoFar;ageMs:number}|null>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const read=await Promise.race([
   todaySoFarForBusiness(admin,businessId).catch(()=>{
    console.error("home.today_live.fallback_failed");return null;
   }),
   new Promise<null>(resolve=>{
    timer=setTimeout(()=>{
     console.error("home.today_live.fallback_timeout");resolve(null);
    },timeoutMs);
   }),
  ]);
  if(!read)return null;
  if(!read.available){
   console.error("home.today_live.fallback_unavailable");return null;
  }
  return {value:read.value,ageMs:Math.max(0,Date.now()-Date.parse(read.value.readAt))};
 }finally{
  if(timer)clearTimeout(timer);
 }
}
