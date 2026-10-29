import {getToastCheckEvidence} from "@/lib/data/getToastCheckEvidence";
import {timeReader} from "@/lib/perf/timeReader.server";
import {lastSalesImportAt} from "@/lib/data/canonical/lastSalesImport.server";
import {NextResponse} from "next/server";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
export const dynamic="force-dynamic";
import {statusSchema,toastOwnerDbRows} from "@/lib/pos/toast/statusSchema";
import {readAllPages} from "@/lib/pos/toast/readAllPages";
import {dayCoverage,dayTotals,applicableLocations} from "@/lib/pos/toast/ownerCoverage";
const send=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return send(404,{error:"not_found"});
 const id=GUID.safeParse(new URL(request.url).searchParams.get("businessId"));
 if(!id.success)return send(404,{error:"not_found"});
 const db=await timeReader("Toast","status.authorizeToastOwner",()=>authorizeToastOwner(id.data));
 if(!db)return send(404,{error:"not_found"});
 const timed=<T>(name:string,read:()=>Promise<T>)=>timeReader("Toast","status."+name,read);
 // All historical reads are ordered by a unique, stable compound key.
 // Never infer completeness from Supabase's default 1,000-row limit.
 let fetched;
 try{
  fetched=await Promise.all([
   timed("credentials",async()=>db.from("toast_api_credentials").select("state,last_error_category,scopes_available").eq("business_id",id.data).maybeSingle()),
   timed("locationMappings",async()=>db.from("toast_location_mappings").select("restaurant_guid,location_id,verified_at,toast_time_zone,toast_start_date,recheck_total").eq("business_id",id.data)),
   timed("syncRuns",()=>readAllPages((start,end)=>db.from("toast_sync_runs")
    .select("id,kind,state,days_done,days_total,resume_at,requested_from,requested_to")
    .eq("business_id",id.data).order("id").range(start,end))),
   timed("dayStatus",()=>readAllPages((start,end)=>db.from("toast_day_status")
    .select("business_date,restaurant_guid,import_state,recon_state,net_sales_cents,toast_net_sales_cents,delta_net_cents,order_count,last_error_category,coverage_complete,unparsed_count,paid_other_day,rechecking_reason,owner_confirmed_at")
    .eq("business_id",id.data).order("business_date",{ascending:false})
    .order("restaurant_guid").range(start,end))),
   timed("ownerFlags",()=>readAllPages((start,end)=>db.from("toast_day_owner_flags")
    .select("business_date,restaurant_guid,cleared_at").eq("business_id",id.data)
    .is("cleared_at",null).order("business_date",{ascending:false})
    .order("restaurant_guid").range(start,end))),
   timed("analyticsCredentials",async()=>db.from("toast_analytics_credentials").select("verified_at,last_error_category").eq("business_id",id.data).maybeSingle()),
   timed("firstImportCheck",async()=>db.from("toast_first_import_check").select("answered_at").eq("business_id",id.data).maybeSingle()),
   timed("businessTimezone",async()=>db.from("businesses").select("timezone").eq("id",id.data).maybeSingle()),
   timed("ownerAttentionDays",()=>readAllPages((start,end)=>db.from("toast_owner_attention_days_v").select("business_date,restaurant_guid")
    .eq("business_id",id.data).order("business_date").order("restaurant_guid").range(start,end))),
   timed("ownerSummaryEntries",()=>readAllPages((start,end)=>db.from("toast_owner_summary_entries")
    .select("restaurant_guid,business_date,net_sales_cents,orders_count,comparison,delta_net_cents,delta_orders,discounts_cents,refunds_cents,voids_count,source")
    .eq("business_id",id.data).order("business_date").order("restaurant_guid").range(start,end))),
   timed("checkEvidence",()=>getToastCheckEvidence(db,id.data)),
   timed("locationNames",async()=>db.from("locations").select("id,name").eq("business_id",id.data)),
  ]);
 }catch{return send(503,{error:"status_unavailable"});}
 const [c,m,runRows,statusRows,flagRows,a,check,business,attention,entries,evidence,locationNames]=fetched;
 if([c,m,a,check,business,locationNames].some(x=>x.error))return send(503,{error:"status_unavailable"});
 const validated=toastOwnerDbRows.safeParse({
  mappings:m.data,runs:runRows,days:statusRows,flags:flagRows
 });
 if(!validated.success)return send(503,{error:"status_unavailable"});
 const {mappings,runs,days,flags:activeFlags}=validated.data;
 const r={data:runs},s={data:days},f={data:activeFlags};
 // Configured-but-not-yet-tested restaurants need the café timezone,
 // rather than crashing because Toast closeout metadata is not available yet.
 const zone=business.data?.timezone;
 if(!zone)return send(503,{error:"status_unavailable"});
 try{new Intl.DateTimeFormat("en-CA",{timeZone:zone});}
 catch{return send(503,{error:"status_unavailable"});}
 const health=await timed("syncHealth",async()=>db.from("toast_sync_health_v").select("last_good_sync_at,stale,warnings,days_with_unreadable_orders").eq("business_id",id.data));
 if(health.error)return send(503,{error:"status_unavailable"});
 let good:string|null;
 try{good=await timed("lastSalesImportAt",()=>lastSalesImportAt(db,id.data));}catch{return send(503,{error:"status_unavailable"});}
 const state=c.data?.state==="verified"&&mappings.length>0&&mappings.every(x=>x.verified_at)?"connected":
  !c.data?"not_connected":"needs_attention";
 const active=(r.data??[]).filter(x=>["backfill","repull_modified"].includes(x.kind)&&["queued","running","paused_rate_limited"].includes(x.state));
 const flags=new Set((f.data??[]).map(x=>x.restaurant_guid+":"+x.business_date));
 const needing=(s.data??[]).filter(x=>attention.some(a=>a.restaurant_guid===x.restaurant_guid&&a.business_date===x.business_date));
 // Owner flags can precede an import, and must remain visible even with NO status row.
 const needsLook=needing.map(x=>{
  const entry=entries.find(e=>e.restaurant_guid===x.restaurant_guid&&e.business_date===x.business_date&&e.comparison==="owner_summary_mismatch");
  return {date:x.business_date,restaurantGuid:x.restaurant_guid,
  oursCents:x.net_sales_cents,toastCents:entry?.net_sales_cents??x.toast_net_sales_cents,deltaCents:entry?.delta_net_cents??x.delta_net_cents,
  unreadableOrders:x.unparsed_count,
  reason:entry?"owner_summary_mismatch":x.unparsed_count>0?"unparsed_orders":flags.has(x.restaurant_guid+":"+x.business_date)?"owner_flag":
   x.last_error_category??x.recon_state};});
 for(const flag of f.data){
  if(!needing.some(x=>x.business_date===flag.business_date&&
    x.restaurant_guid===flag.restaurant_guid))
   needsLook.push({date:flag.business_date,restaurantGuid:flag.restaurant_guid,
    oursCents:null,toastCents:null,deltaCents:null,unreadableOrders:0,reason:"owner_flag"});
 }
 const completeDates=[...new Set(s.data.map(x=>x.business_date))].filter(date=>
  dayCoverage(mappings,s.data,date).complete);
 const mostRecent=()=>new Intl.DateTimeFormat("en-CA",{timeZone:zone,
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const base=Date.parse(mostRecent()+"T12:00:00Z");
 const recentDates=Array.from({length:14},(_,i)=>new Date(base-(i+1)*86400000).toISOString().slice(0,10));
 const response={
  connection:state,importEnabled:process.env.TOAST_AUTO_IMPORT_ENABLED==="true",
  missingLaborScope:(c.data?.scopes_available as Record<string,unknown>|undefined)?.labor===false,
  missingMenuScope:(c.data?.scopes_available as Record<string,unknown>|undefined)?.menus===false,
  errorCategory:c.data?.last_error_category??null,
  lastGoodSyncAt:good,stale:state==="connected"&&!good||Boolean(health.data?.some(x=>x.stale)),
  backfill:{daysDone:active.reduce((n,x)=>n+x.days_done,0),
   daysTotal:active.reduce((n,x)=>n+x.days_total,0),
   state:active.some(x=>x.state==="paused_rate_limited")?"paused_rate_limited":active[0]?.state??null,
   resumeAt:active.map(x=>x.resume_at).filter((x):x is string=>Boolean(x)).sort()[0]??null},
  failedRuns:(r.data??[]).filter(x=>x.state==="failed").length,
  queuedRanges:(r.data??[]).filter(x=>["queued","running","paused_rate_limited"].includes(x.state)&&x.requested_from&&x.requested_to).map(x=>({from:x.requested_from,to:x.requested_to})),
  needsLook,needsLookCount:new Set(attention.map(a=>a.business_date)).size,
  checkEvidence:evidence??{mode:"internal",reason:"no_analytics_credentials",compared:0,matched:0},
  summaryEntries:entries,
  comparisonDays:days.filter(d=>d.import_state==="imported").slice(0,7*mappings.length).map(d=>({date:d.business_date,restaurantGuid:d.restaurant_guid,oursCents:d.net_sales_cents})),
  warnings:(health.data??[]).map(h=>h.warnings).filter(w=>w?.time_zone_mismatch),
  daysWithUnreadableOrders:(health.data??[]).reduce((n,h)=>n+h.days_with_unreadable_orders,0),
  rechecking:{total:mappings.reduce((n,m)=>n+m.recheck_total,0),
   remaining:days.filter(d=>d.rechecking_reason==="closeout_changed").length},
  firstImportRows:completeDates.slice(0,7).map(date=>{
   const totals=dayTotals(mappings,s.data,date);
   return {date,oursCents:totals.netSalesCents,
    toastCents:totals.toastNetSalesCents};
  }),
  recent:recentDates.map(date=>{
   const totals=dayTotals(mappings,s.data,date);
   const eligible=applicableLocations(mappings,date);
   const problem=needsLook.some(x=>x.date===date&&eligible.some(m=>m.restaurant_guid===x.restaurantGuid));
   return {date,netSalesCents:totals.netSalesCents,orders:totals.orders,paidOtherDay:totals.paidOtherDay,
    status:problem?"needs_look":!totals.complete?"missing":
     eligible.length>0&&eligible.every(m=>days.some(d=>d.business_date===date&&
       d.restaurant_guid===m.restaurant_guid&&d.owner_confirmed_at))?"owner_confirmed":
     eligible.length>0&&eligible.every(m=>entries.some(e=>e.restaurant_guid===m.restaurant_guid&&e.business_date===date&&e.comparison==="owner_summary_match"))?"owner_match":
     totals.checked?(days.filter(d=>d.business_date===date&&eligible.some(m=>m.restaurant_guid===d.restaurant_guid)).every(d=>d.recon_state==="matched")?"checked":"checked_internal"):"checking"};
  }),
  analytics:{connected:Boolean(a.data),verified:Boolean(a.data?.verified_at),errorCategory:a.data?.last_error_category??null},
  firstImportCheck:check.data?.answered_at?"answered":completeDates.length>=7?"due":"hidden",
  timeZone:zone,startDate:[...mappings.map(x=>x.toast_start_date).filter((x):x is string=>Boolean(x))].sort()[0]??null,
  restaurantNames:Object.fromEntries(mappings.map(m=>[m.restaurant_guid,(locationNames.data??[]).find(l=>l.id===m.location_id)?.name??""])),
  restaurantGuids:mappings.map(x=>x.restaurant_guid)
 };
 const checked=statusSchema.safeParse(response);
 return checked.success?send(200,checked.data):send(503,{error:"status_unavailable"});
}
