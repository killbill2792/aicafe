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

export async function readToastTodaySoFar(db:SupabaseClient,businessId:string,now=new Date(),
  request?:Request):Promise<TodaySoFarRead>{
  const {data,error}=await db.from("toast_location_mappings")
    .select("restaurant_guid,toast_time_zone,closeout_hour")
    .eq("business_id",businessId).not("verified_at","is",null);
  if(error)return {available:false,missing:["todayLiveUnavailable"]};
  const mappings=((data??[]) as Mapping[]).filter(m=>m.toast_time_zone&&m.closeout_hour!=null);
  if(!mappings.length)return {available:false,missing:["todayLiveNoToastLocation"]};
  // All locations of one café share its business day; use the first mapping's clock.
  const businessDate=currentToastBusinessDay(now,mappings[0].toast_time_zone!,mappings[0].closeout_hour!);
  const key=businessId+"|"+businessDate;
  const hit=cache.get(key);
  if(hit&&now.getTime()-hit.at<CACHE_MS)return {available:true,value:hit.value};
  const deadlineAt=Date.now()+READ_BUDGET_MS;
  const client=request?null:createToastClient(db,businessId);
  const get:Request=request??((path,guid)=>client!.request(path,guid,z.array(z.unknown()),{deadlineAt}));
  const pages:ToastDayPage[]=[];
  let read=0,failed=0,truncated=false;
  for(const m of mappings){
    try{
      const own:ToastDayPage[]=[];
      for(let page=1;;page++){
        if(page>MAX_PAGES||Date.now()>=deadlineAt){truncated=true;break;}
        const rows=await get("/orders/v2/ordersBulk?businessDate="+businessDate.replaceAll("-","")+
          "&pageSize=100&page="+page,m.restaurant_guid);
        own.push(parseToastDayPage(rows,m.restaurant_guid,businessDate,m.toast_time_zone!,m.closeout_hour!));
        if(rows.length<100)break;
      }
      pages.push(...own);read++;
    }catch{failed++;}
  }
  if(!read)return {available:false,missing:["todayLiveReadFailed"]};
  const value=summarizeToastToday({businessDate,readAt:now.toISOString(),pages,
    locationsRead:read,locationsFailed:failed,truncated});
  // Only cache a complete read, so a failed location is retried on the next question.
  if(!failed&&!truncated)cache.set(key,{at:now.getTime(),value});
  return {available:true,value};
}

/** Test helper: forget cached reads. */
export function clearTodaySoFarCache(){cache.clear();}
