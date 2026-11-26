import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {runSql} from "@/lib/ai/research/tools.server";
import {readToastDayTrust} from "@/lib/data/toastDayTrust.server";

// Internal customer monitor only. Not a model tool and not a general view reader.
// All aggregation happens in the same scoped SQL executor as Luna's research.
type View="cv_toast_records"|"cv_customer_visits"|"cv_customer_products";
type Request={view:View;group_by:string[]|null;metrics:Array<{fn:"count"|"count_distinct"|"sum"|"avg";column:string}>;
 filters:Array<{column:string;op:string;value:unknown}>;date_from:string;date_to:string;limit:1|100};
const fields={
 cv_toast_records:["source_ref","record_type","counts_in_sales","data.aiCafeCustomer.identityRef","data.aiCafeCustomer.displayName","data.aiCafeCustomer.netSalesCents","data.aiCafeCustomer.discountParticipation","data.aiCafeCustomer.loyaltyParticipation","data.aiCafeCustomer.recordedRefundCents","data.quantity"],
 cv_customer_visits:["source_ref","identity_ref","first_observed_visit","returning_visit","net_sales_cents","period_account_revenue_share_squared","order_duration_seconds","historical_recipe_contribution_cents","history_account_net_sales_cents","observed_lapse_flag","observed_reappearance_flag","observed_return_7d","observed_return_30d","observed_return_60d","observed_return_90d","business_date"],
 cv_customer_products:["source_ref","quantity","pair_occurrence","visit_ref","product_ref","paired_product_ref","modifier_ref","order_channel","business_weekday","local_hour","fact_kind","visit_class"],
} satisfies Record<View,string[]>;
const coverageSchema=z.object({
 scope:z.literal("all_eligible_checks_in_period"),eligibleChecks:z.number().int().nonnegative(),
 linkedChecks:z.number().int().nonnegative(),namedChecks:z.number().int().nonnegative(),
 knownMoneyChecks:z.number().int().nonnegative(),linkedKnownMoneyChecks:z.number().int().nonnegative(),
 recordedNetCents:z.number().nullable(),linkedRecordedNetCents:z.number().nullable(),
 expectedLocationDays:z.number().int().nonnegative(),completeLocationDays:z.number().int().nonnegative(),complete:z.boolean()
});
const envelopeSchema=z.object({rows:z.array(z.record(z.string(),z.unknown())),source_count:z.number().int().nonnegative(),
 incomplete:z.boolean(),current_day:z.boolean(),coverage:coverageSchema});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date=/^\d{4}-\d{2}-\d{2}$/;
function dateLiteral(v:unknown):string{
 if(typeof v!=="string"||!date.test(v))throw Error("invalid_monitor_date");
 return "'"+v+"'::date";
}
function column(view:View,name:string,numeric=false):string{
 if(!fields[view].includes(name))throw Error("invalid_monitor_column");
 if(!name.startsWith("data."))return '"'+name+'"';
 const path="'{"+name.split(".").slice(1).join(",")+"}'";
 return numeric?"case when jsonb_typeof(data #> "+path+")='number' then (data #>> "+path+")::numeric end":"data #>> "+path;
}
export function customerMonitorStatement(p:Request,businessId:string):string{
 if(!uuid.test(businessId)||!fields[p.view]||p.date_from>p.date_to||![1,100].includes(p.limit)||!p.metrics.length)throw Error("invalid_monitor_scope");
 const id="'"+businessId+"'::uuid",from=dateLiteral(p.date_from),to=dateLiteral(p.date_to);
 const args=[id,from,to].join(",");
 const kind=p.filters.find(f=>f.column==="record_type"&&f.op==="=")?.value;
 const source=p.view==="cv_toast_records"?
  "public.toast_records_for("+args+",ARRAY['"+(kind==="check"?"check":kind==="item"?"item":(()=>{throw Error("invalid_record_type")})())+"']::text[])":
  p.view==="cv_customer_visits"?"public.customer_visits_for("+args+")":"public.customer_products_for("+args+")";
 const predicates=p.filters.map(f=>{
  const c=column(p.view,f.column);
  if(f.column==="data.aiCafeCustomer.identityRef"&&f.op==="is_not_null"&&f.value===null)return "("+c+") is not null";
  if(f.column==="business_date"&&f.op==="between"&&Array.isArray(f.value)&&f.value.length===2)return c+" between "+dateLiteral(f.value[0])+" and "+dateLiteral(f.value[1]);
  if(f.column==="counts_in_sales"&&f.op==="="&&f.value===true)return c+" = true";
  if(f.op==="="&&typeof f.value==="string"&&(
   f.column==="record_type"&&["check","item"].includes(f.value)||
   f.column==="fact_kind"&&["item","modifier","basket_pair"].includes(f.value)||
   f.column==="visit_class"&&f.value==="observed_returning"))return c+" = '"+f.value+"'";
  throw Error("invalid_monitor_filter");
 });
 const groups=(p.group_by??[]).map(v=>column(p.view,v));
 const metrics=p.metrics.map(m=>{
  if(!["count","count_distinct","sum","avg"].includes(m.fn))throw Error("invalid_monitor_metric");
  const c=column(p.view,m.column,m.fn==="sum"||m.fn==="avg");
  return (m.fn==="count_distinct"?"count(distinct "+c+")":m.fn+"("+c+")")+' as "'+m.fn+"_"+m.column+'"';
 });
 return "with scoped_source as materialized (select * from "+source+" where business_id="+id+
  " and business_date between "+from+" and "+to+(predicates.length?" and "+predicates.join(" and "):"")+
  "), page_rows as (select "+[...groups,...metrics].join(",")+" from scoped_source"+(groups.length?" group by "+groups.join(","):"")+" limit "+(p.limit+1)+") "+
  "select (select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from page_rows q) as rows, "+
  "(select count(*) from scoped_source) as source_count, "+
  "(select coalesce(bool_or(status in ('open','estimated','needs_match','provisional')),false) from scoped_source) as incomplete, "+
  "(select (now() at time zone timezone)::date between "+from+" and "+to+" from public.businesses where id="+id+") as current_day, "+
  "public.customer_query_coverage("+args+") as coverage";
}
const failed=()=>({rows:[] as Record<string,unknown>[],missing:["source_read_failed"],notes:[] as string[],truncated:false,error:"source_read_failed",customerCoverage:undefined});
export async function readCustomerMonitorSql(p:Request,{db,businessId}:{db:SupabaseClient;businessId:string}){
 try{
  const sql=customerMonitorStatement(p,businessId);
  // The detector runs on a server-authorized café, not a model-selected ID.
  // SQL itself rechecks membership and scopes every statement to this café.
  const {data:owner,error}=await db.from("memberships").select("user_id").eq("business_id",businessId).eq("role","owner").order("user_id").limit(1).maybeSingle();
  if(error||!owner||!uuid.test(owner.user_id))return failed();
  const result=await runSql({db,businessId,ownerUserId:owner.user_id},sql);
  if(result.ok!==true||!Array.isArray(result.rows)||result.rows.length!==1)return failed();
  const parsed=envelopeSchema.safeParse(result.rows[0]);if(!parsed.success)return failed();
  const value=parsed.data,rows:Record<string,unknown>[]=[];
  let chars=0;
  for(const row of value.rows){
   chars+=JSON.stringify(row).length;if(rows.length>=p.limit||chars>6000)break;
   rows.push(row);
  }
  const truncated=rows.length<value.rows.length;
  const trust=await readToastDayTrust(db,businessId,p.date_from,p.date_to);
  return {rows,truncated,error:undefined,customerCoverage:value.coverage,notes:trust.notes,
   missing:[...(value.source_count===0||!rows.length?["empty"]:[]),...(value.incomplete?["incompleteEvidence"]:[]),
    ...(value.current_day?["currentDayIncomplete"]:[]),...trust.quality,...(truncated?["result_truncated"]:[])]};
 }catch{return failed();}
}
