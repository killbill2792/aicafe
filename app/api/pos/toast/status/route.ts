import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
export const dynamic="force-dynamic";
const money=z.number().int().safe();
const day=z.iso.date();
export const statusSchema=z.object({
 connection:z.enum(["not_connected","needs_attention","connected"]),
 errorCategory:z.string().nullable(),lastGoodSyncAt:z.string().nullable(),stale:z.boolean(),
 backfill:z.object({daysDone:z.number().int(),daysTotal:z.number().int(),
  state:z.string().nullable(),resumeAt:z.string().nullable()}),
 failedRuns:z.number().int(),
 needsLook:z.array(z.object({date:day,restaurantGuid:GUID,oursCents:money.nullable(),toastCents:money.nullable(),
  deltaCents:money.nullable(),reason:z.string()})),
 recent:z.array(z.object({date:day,netSalesCents:money.nullable(),orders:z.number().int().nullable(),
  status:z.enum(["checked","checking","needs_look","missing"])})),
 analytics:z.object({connected:z.boolean(),verified:z.boolean()}),
 firstImportCheck:z.enum(["hidden","due","answered"]),
 timeZone:z.string(),startDate:day.nullable(),
 restaurantGuids:z.array(GUID),
}).strict();
const send=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return send(404,{error:"not_found"});
 const id=GUID.safeParse(new URL(request.url).searchParams.get("businessId"));
 if(!id.success)return send(404,{error:"not_found"});
 const db=await authorizeToastOwner(id.data);
 if(!db)return send(404,{error:"not_found"});
 const [c,m,r,s,f,a,check]=await Promise.all([
  db.from("toast_api_credentials").select("state,last_error_category").eq("business_id",id.data).maybeSingle(),
  db.from("toast_location_mappings").select("restaurant_guid,verified_at,toast_time_zone,toast_start_date").eq("business_id",id.data),
  db.from("toast_sync_runs").select("kind,state,days_done,days_total,resume_at").eq("business_id",id.data).limit(1000),
  db.from("toast_day_status").select("business_date,restaurant_guid,import_state,recon_state,net_sales_cents,toast_net_sales_cents,delta_net_cents,order_count,last_error_category,coverage_complete").eq("business_id",id.data).order("business_date",{ascending:false}).limit(500),
  db.from("toast_day_owner_flags").select("business_date,restaurant_guid,cleared_at").eq("business_id",id.data).is("cleared_at",null).limit(500),
  db.from("toast_analytics_credentials").select("verified_at").eq("business_id",id.data).maybeSingle(),
  db.from("toast_first_import_check").select("answered_at").eq("business_id",id.data).maybeSingle(),
 ]);
 if([c,m,r,s,f,a,check].some(x=>x.error))return send(503,{error:"status_unavailable"});
 if(!m.data?.length)return send(404,{error:"not_found"});
 if((r.data??[]).length>=1000||(s.data??[]).length>=500||(f.data??[]).length>=500)
  return send(503,{error:"status_unavailable"});
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
 const recentDates=[...new Set((s.data??[]).map(x=>x.business_date))].slice(0,14);
 const response={
  connection:state,errorCategory:c.data?.last_error_category??null,
  lastGoodSyncAt:good,stale:state==="connected"&&!good||Boolean(health.data?.some(x=>x.stale)),
  backfill:{daysDone:active.reduce((n,x)=>n+x.days_done,0),
   daysTotal:active.reduce((n,x)=>n+x.days_total,0),
   state:active.some(x=>x.state==="paused_rate_limited")?"paused_rate_limited":active[0]?.state??null,
   resumeAt:active.map(x=>x.resume_at).filter((x):x is string=>Boolean(x)).sort()[0]??null},
  failedRuns:(r.data??[]).filter(x=>x.state==="failed").length,
  needsLook:needing.map(x=>({date:x.business_date,restaurantGuid:x.restaurant_guid,oursCents:x.net_sales_cents,
   toastCents:x.toast_net_sales_cents,deltaCents:x.delta_net_cents,
   reason:flags.has(x.restaurant_guid+":"+x.business_date)?"owner_flag":
    x.last_error_category??x.recon_state})),
  recent:recentDates.map(date=>{
   const rows=(s.data??[]).filter(x=>x.business_date===date);
   const problem=rows.some(x=>needing.includes(x));
   return {date,netSalesCents:rows.some(x=>x.net_sales_cents==null)?null:
    rows.reduce((n,x)=>n+x.net_sales_cents,0),
    orders:rows.some(x=>x.order_count==null)?null:rows.reduce((n,x)=>n+x.order_count,0),
    status:problem?"needs_look":rows.some(x=>x.import_state!=="imported")?"missing":
      rows.every(x=>["matched","checked_internal"].includes(x.recon_state))?"checked":"checking"};
  }),
  analytics:{connected:Boolean(a.data),verified:Boolean(a.data?.verified_at)},
  firstImportCheck:check.data?.answered_at?"answered":
    [...new Set((s.data??[]).map(x=>x.business_date))].filter(date=>
      m.data.every(loc=>(s.data??[]).some(row=>row.business_date===date&&
      row.restaurant_guid===loc.restaurant_guid&&row.import_state==="imported"&&row.coverage_complete))
    ).length>=7?"due":"hidden",
  timeZone:m.data[0].toast_time_zone,startDate:m.data[0].toast_start_date??null,
  restaurantGuids:m.data.map(x=>x.restaurant_guid)
 };
 const checked=statusSchema.safeParse(response);
 return checked.success?send(200,checked.data):send(503,{error:"status_unavailable"});
}
