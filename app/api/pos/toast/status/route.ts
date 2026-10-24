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
 const db=await authorizeToastOwner(id.data);
 if(!db)return send(404,{error:"not_found"});
 // All historical reads are ordered by a unique, stable compound key.
 // Never infer completeness from Supabase's default 1,000-row limit.
 let fetched;
 try{
  fetched=await Promise.all([
   db.from("toast_api_credentials").select("state,last_error_category").eq("business_id",id.data).maybeSingle(),
   db.from("toast_location_mappings").select("restaurant_guid,verified_at,toast_time_zone,toast_start_date").eq("business_id",id.data),
   readAllPages((start,end)=>db.from("toast_sync_runs")
    .select("id,kind,state,days_done,days_total,resume_at,requested_from,requested_to")
    .eq("business_id",id.data).order("id").range(start,end)),
   readAllPages((start,end)=>db.from("toast_day_status")
    .select("business_date,restaurant_guid,import_state,recon_state,net_sales_cents,toast_net_sales_cents,delta_net_cents,order_count,last_error_category,coverage_complete")
    .eq("business_id",id.data).order("business_date",{ascending:false})
    .order("restaurant_guid").range(start,end)),
   readAllPages((start,end)=>db.from("toast_day_owner_flags")
    .select("business_date,restaurant_guid,cleared_at").eq("business_id",id.data)
    .is("cleared_at",null).order("business_date",{ascending:false})
    .order("restaurant_guid").range(start,end)),
   db.from("toast_analytics_credentials").select("verified_at").eq("business_id",id.data).maybeSingle(),
   db.from("toast_first_import_check").select("answered_at").eq("business_id",id.data).maybeSingle(),
   db.from("businesses").select("timezone").eq("id",id.data).maybeSingle(),
  ]);
 }catch{return send(503,{error:"status_unavailable"});}
 const [c,m,runRows,statusRows,flagRows,a,check,business]=fetched;
 if([c,m,a,check,business].some(x=>x.error))return send(503,{error:"status_unavailable"});
 if(!m.data?.length)return send(404,{error:"not_found"});
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
 const health=await db.from("toast_sync_health_v").select("last_good_sync_at,stale").eq("business_id",id.data);
 if(health.error)return send(503,{error:"status_unavailable"});
 const good=(health.data??[]).map(h=>h.last_good_sync_at).filter(Boolean).sort().at(-1)??null;
 const state=c.data?.state==="verified"&&m.data.every(x=>x.verified_at)?"connected":
  !c.data?"not_connected":"needs_attention";
 const active=(r.data??[]).filter(x=>x.kind==="backfill"&&["queued","running","paused_rate_limited"].includes(x.state));
 const flags=new Set((f.data??[]).map(x=>x.restaurant_guid+":"+x.business_date));
 const needing=(s.data??[]).filter(x=>x.import_state==="failed"||
  ["mismatch","analytics_timeout","coverage_invalid"].includes(x.recon_state)||
  Boolean(x.last_error_category)||flags.has(x.restaurant_guid+":"+x.business_date));
 // Owner flags can precede an import, and must remain visible even with NO status row.
 const needsLook=needing.map(x=>({date:x.business_date,restaurantGuid:x.restaurant_guid,
  oursCents:x.net_sales_cents,toastCents:x.toast_net_sales_cents,deltaCents:x.delta_net_cents,
  reason:flags.has(x.restaurant_guid+":"+x.business_date)?"owner_flag":
   x.last_error_category??x.recon_state}));
 for(const flag of f.data){
  if(!needing.some(x=>x.business_date===flag.business_date&&
    x.restaurant_guid===flag.restaurant_guid))
   needsLook.push({date:flag.business_date,restaurantGuid:flag.restaurant_guid,
    oursCents:null,toastCents:null,deltaCents:null,reason:"owner_flag"});
 }
 const completeDates=[...new Set(s.data.map(x=>x.business_date))].filter(date=>
  dayCoverage(mappings,s.data,date).complete);
 const mostRecent=()=>new Intl.DateTimeFormat("en-CA",{timeZone:zone,
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const base=Date.parse(mostRecent()+"T12:00:00Z");
 const recentDates=Array.from({length:14},(_,i)=>new Date(base-(i+1)*86400000).toISOString().slice(0,10));
 const response={
  connection:state,errorCategory:c.data?.last_error_category??null,
  lastGoodSyncAt:good,stale:state==="connected"&&!good||Boolean(health.data?.some(x=>x.stale)),
  backfill:{daysDone:active.reduce((n,x)=>n+x.days_done,0),
   daysTotal:active.reduce((n,x)=>n+x.days_total,0),
   state:active.some(x=>x.state==="paused_rate_limited")?"paused_rate_limited":active[0]?.state??null,
   resumeAt:active.map(x=>x.resume_at).filter((x):x is string=>Boolean(x)).sort()[0]??null},
  failedRuns:(r.data??[]).filter(x=>x.state==="failed").length,
  queuedRanges:(r.data??[]).filter(x=>["queued","running","paused_rate_limited"].includes(x.state)&&x.requested_from&&x.requested_to).map(x=>({from:x.requested_from,to:x.requested_to})),
  needsLook,
  firstImportRows:completeDates.slice(0,7).map(date=>{
   const selected=dayCoverage(m.data,s.data,date).rows;
   return {date,oursCents:dayTotals(mappings,s.data,date).netSalesCents,
    toastCents:!a.data?.verified_at||selected.some(x=>x?.toast_net_sales_cents==null)?null:
     selected.reduce((n,x)=>n+(x?.toast_net_sales_cents??0),0)};
  }),
  recent:recentDates.map(date=>{
   const totals=dayTotals(m.data,s.data,date);
   const eligible=applicableLocations(mappings,date);
   const problem=needsLook.some(x=>x.date===date&&eligible.some(m=>m.restaurant_guid===x.restaurantGuid));
   return {date,netSalesCents:totals.netSalesCents,orders:totals.orders,
    status:problem?"needs_look":!totals.complete?"missing":totals.checked?"checked":"checking"};
  }),
  analytics:{connected:Boolean(a.data),verified:Boolean(a.data?.verified_at)},
  firstImportCheck:check.data?.answered_at?"answered":completeDates.length>=7?"due":"hidden",
  timeZone:m.data[0].toast_time_zone,startDate:[...m.data.map(x=>x.toast_start_date).filter((x):x is string=>Boolean(x))].sort()[0]??null,
  restaurantGuids:m.data.map(x=>x.restaurant_guid)
 };
 const checked=statusSchema.safeParse(response);
 return checked.success?send(200,checked.data):send(503,{error:"status_unavailable"});
}
