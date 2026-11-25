import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readDailyFactRows} from "@/lib/data/dailyFacts.server";
import {readPeriodSoldLines} from "@/lib/data/periodItemSales.server";
import {readMenuCatalogRows} from "@/lib/data/menuCatalog.server";
import {readMenuCategoryLabels} from "@/lib/data/menuCategoryLabels.server";
import {readCafeEvents,readCityResearchCoverage} from "@/lib/data/cafeEvents.server";
import {readAllPages} from "@/lib/pos/toast/readAllPages";
import {addCalendarDays} from "@/lib/pos/toast/scheduleDates";
import {buildBriefContent,type BriefContent,type MorningBriefEvidence} from "./morningBrief";

export type BriefCafe={businessId:string;businessName:string;currency:string|null};
export type BriefEvidenceResult={evidence:MorningBriefEvidence;content:BriefContent;
  /** Yesterday's POS data is complete: certified sales and covered items. */
  posComplete:boolean};

/** A complete imported rollup is not independent closeout verification.
 * No source calls here: wait for the existing reconciliation state. */
async function toastCloseoutReady(db:SupabaseClient,id:string,day:string){
  const mappings=await readAllPages((start,end)=>db.from("toast_location_mappings")
    .select("restaurant_guid").eq("business_id",id).not("verified_at","is",null)
    .order("restaurant_guid").range(start,end));
  if(!mappings.length)return false;
  const states=await readAllPages((start,end)=>db.from("toast_day_status")
    .select("restaurant_guid,import_state,recon_state,coverage_complete,rechecking_reason")
    .eq("business_id",id).eq("business_date",day)
    .order("restaurant_guid").range(start,end));
  return mappings.every(mapping=>states.some(state=>state.restaurant_guid===mapping.restaurant_guid&&
    state.import_state==="imported"&&state.coverage_complete===true&&!state.rechecking_reason&&
    ["matched","checked_internal"].includes(state.recon_state)));
}

/** Reads the brief's sources once per café, from the canonical readers.
 * Every read is independent and caught: a failing source becomes "missing"
 * in the brief, never a skipped brief. */
export async function readBriefEvidence(db:SupabaseClient,cafe:BriefCafe,
  day:{today:string;yesterday:string},now:Date):Promise<BriefEvidenceResult>{
  const id=cafe.businessId,week={from:day.today,to:addCalendarDays(day.today,7)};
  const [daily,sold,menu,labels,events,coverage,reconciled]=await Promise.all([
    readDailyFactRows(db,id,day.yesterday,day.yesterday).catch(()=>null),
    readPeriodSoldLines(db,id,{from:day.yesterday,to:day.yesterday}),
    readMenuCatalogRows(db,id).catch(()=>[]),
    readMenuCategoryLabels(db,id).catch(()=>new Map<string,boolean>()),
    readCafeEvents(db,id,week.from,week.to).catch(()=>null),
    readCityResearchCoverage(db,id,week.from,week.to).catch(()=>null),
    toastCloseoutReady(db,id,day.yesterday).catch(()=>false),
  ]);
  const row=daily?.length===1&&daily[0].business_date===day.yesterday&&
    daily[0].sales_data_status==="actual"&&Number.isSafeInteger(daily[0].net_sales_cents)?daily[0]:null;
  const evidence:MorningBriefEvidence={
    businessName:cafe.businessName,currency:cafe.currency,today:day.today,yesterday:day.yesterday,
    netSalesCents:row&&reconciled?Number(row.net_sales_cents):null,
    sold:{available:sold.available,linked:sold.linked,unlinked:sold.unlinked},
    menu:menu.map(m=>({id:m.id,name:m.name,base_name:m.base_name,category:m.category})),
    categoryLabels:labels,
    events:{available:events!==null,items:events??[],coverage:coverage?.status??null},
  };
  return {evidence,content:buildBriefContent(evidence,now),posComplete:Boolean(row)&&reconciled&&sold.available};
}
