import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {createToastClient} from "./client";
import {parseToastDayPage,type ToastDayPage} from "./dayParser";
import {currentToastBusinessDay,summarizeToastToday,type TodaySoFar} from "./todaySoFar";

/** Read-only: today's Toast orders read live. lib/data/todayLive.server.ts saves
 * the latest reading for Home and the chat; the closeout import stays the only
 * writer of the day's final sales. */
const MAX_PAGES=10;
const READ_BUDGET_MS=15_000;
const CACHE_MS=3*60_000;
const cache=new Map<string,{at:number;value:TodaySoFar}>();

type Mapping={restaurant_guid:string;toast_time_zone:string|null;closeout_hour:number|null};
type Request=(path:string,restaurantGuid:string)=>Promise<unknown[]>;

export type TodaySoFarRead={available:true;value:TodaySoFar}|{available:false;missing:string[]};
/** Receives each location's downloaded pages, so the 15-minute job can keep
 * today's orders without a second download. A reader with this hook always
 * downloads fresh: a cached summary has no orders to keep. */
export type LocationPages=(restaurantGuid:string,businessDate:string,pages:unknown[][])=>Promise<void>;

export async function readToastTodaySoFar(db:SupabaseClient,businessId:string,now=new Date(),
  request?:Request,onLocationPages?:LocationPages):Promise<TodaySoFarRead>{
  // Toast timezone decides which provider businessDate to request. The café's
  // reporting timezone decides live hour labels, exactly like the historical
  // pos_rebuild_sales_fact_rollups_v1 result and the registered Supervisor.
  const [{data,error},{data:cafe,error:cafeError}]=await Promise.all([
    db.from("toast_location_mappings")
      .select("restaurant_guid,toast_time_zone,closeout_hour")
      .eq("business_id",businessId).not("verified_at","is",null),
    db.from("businesses").select("timezone").eq("id",businessId).single(),
  ]);
  if(error)return {available:false,missing:["todayLiveUnavailable"]};
  const mappings=((data??[]) as Mapping[]).filter(m=>m.toast_time_zone&&m.closeout_hour!=null);
  if(!mappings.length)return {available:false,missing:["todayLiveNoToastLocation"]};
  const reportingZone=typeof cafe?.timezone==="string"?cafe.timezone:"";
  try{
    if(cafeError||!reportingZone)throw new Error("reporting_timezone_missing");
    new Intl.DateTimeFormat("en-US",{timeZone:reportingZone}).format(now);
  }catch{return {available:false,missing:["todayLiveReportingTimezoneUnavailable"]};}
  // All locations of one café share its business day; use the first mapping's clock.
  const businessDate=currentToastBusinessDay(now,mappings[0].toast_time_zone!,mappings[0].closeout_hour!);
  const key=businessId+"|"+businessDate+"|"+reportingZone;
  const hit=cache.get(key);
  if(hit&&!onLocationPages&&now.getTime()-hit.at<CACHE_MS)return {available:true,value:hit.value};
  const deadlineAt=Date.now()+READ_BUDGET_MS;
  const client=request?null:createToastClient(db,businessId);
  const get:Request=request??((path,guid)=>client!.request(path,guid,z.array(z.unknown()),{deadlineAt}));
  const pages:ToastDayPage[]=[];
  let read=0,failed=0,truncated=false;
  for(const m of mappings){
    try{
      const own:ToastDayPage[]=[];
      const raw:unknown[][]=[];
      for(let page=1;;page++){
        if(page>MAX_PAGES||Date.now()>=deadlineAt){truncated=true;break;}
        const rows=await get("/orders/v2/ordersBulk?businessDate="+businessDate.replaceAll("-","")+
          "&pageSize=100&page="+page,m.restaurant_guid);
        own.push(parseToastDayPage(rows,m.restaurant_guid,businessDate,m.toast_time_zone!,m.closeout_hour!));
        raw.push(rows);
        if(rows.length<100)break;
      }
      pages.push(...own);read++;
      // Keeping the orders is extra: it never changes or blocks the reading.
      if(onLocationPages&&raw.length)
        await onLocationPages(m.restaurant_guid,businessDate,raw).catch(()=>{
          console.warn("toast_live_pages_unsaved");
        });
    }catch{failed++;}
  }
  if(!read)return {available:false,missing:["todayLiveReadFailed"]};
  const value=summarizeToastToday({businessDate,readAt:now.toISOString(),
    timezone:reportingZone,pages,
    locationsRead:read,locationsFailed:failed,truncated});
  // Only cache a complete read, so a failed location is retried on the next question.
  if(!failed&&!truncated)cache.set(key,{at:now.getTime(),value});
  return {available:true,value};
}

/** Test helper: forget cached reads. */
export function clearTodaySoFarCache(){cache.clear();}
