// Generated physical metadata is an audit/CI gate, NEVER a model access grant.
// Use only a disposable migrated local Supabase database. No business rows read.
import {readFileSync,writeFileSync} from "node:fs";
import pg from "pg";
const {Client}=pg;
const snapshotPath="docs/plans/u3-physical-schema-census.generated.json";
const connection=process.env.U3_CATALOG_DB_URL;
if(!connection)throw Error("U3_CATALOG_DB_URL required (disposable migrated Supabase)");
const url=new URL(connection);
if(!["127.0.0.1","localhost","::1","[::1]"].includes(url.hostname)||
  url.port!=="54322"||url.protocol!=="postgresql:")
 throw Error("U3 census refuses non-disposable or non-local database");
const sql=`
select jsonb_agg(jsonb_build_object(
 'relation',c.relname,
 'kind',case when c.relkind='r' then 'table' else 'view' end,
 'rls',c.relrowsecurity,
 'columns',(select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) order by a.attnum)
    from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
 'foreign_keys',(select coalesce(jsonb_agg(jsonb_build_object('constraint',fk.conname,'target',ft.relname) order by fk.conname),'[]'::jsonb)
    from pg_constraint fk join pg_class ft on ft.oid=fk.confrelid
    where fk.contype='f' and fk.conrelid=c.oid)
) order by c.relname) as catalog
from pg_class c
where c.relnamespace='public'::regnamespace and c.relkind in ('r','v')
`;
const client=new Client({connectionString:connection,connectionTimeoutMillis:4000,statement_timeout:15000});
let live,logicalColumns;
try{
 await client.connect();
 const {rows}=await client.query(sql);
 live=rows[0]?.catalog;
 const logical=await client.query(
  "SELECT table_name AS relation,column_name AS field "+
  "FROM information_schema.columns WHERE table_schema='u3_research' "+
  "ORDER BY table_name,column_name");
 logicalColumns=logical.rows;
}finally{await client.end().catch(()=>{});}
if(!Array.isArray(live))throw Error("Migrated catalog query returned no relations");
const reference=JSON.parse(readFileSync(snapshotPath,"utf8"));
if(reference.notAuthorization!==true||!Array.isArray(reference.relations))
 throw Error("U3 census snapshot must remain non-authorizing generated metadata");
const count=(relations)=>({
 tables:relations.filter(x=>x.kind==="table").length,
 columns:relations.filter(x=>x.kind==="table").reduce((sum,x)=>sum+x.columns.length,0),
 views:relations.filter(x=>x.kind==="view").length,
 foreignKeys:relations.filter(x=>x.kind==="table").reduce((sum,x)=>sum+x.foreign_keys.length,0)
});
const stats=count(live);
const expected=count(reference.relations);
const byName=new Map(reference.relations.map(x=>[x.relation,x]));
// PostgreSQL physical attribute ordinal is not a business semantic. Migration
// CREATE order and production ALTER order can differ without source drift.
// Compare every column name/type/nullability and every FK, not the row order.
const canonical=relation=>relation?JSON.stringify({
 relation:relation.relation,kind:relation.kind,rls:relation.rls,
 columns:[...(relation.columns??[])].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
 foreign_keys:[...(relation.foreign_keys??[])].sort((a,b)=>
  String(a.constraint).localeCompare(String(b.constraint))||
  String(a.target).localeCompare(String(b.target)))
}):null;
// The production snapshot is the inventory authority. One pre-existing POS
// payroll table has stricter NOT NULL flags in production than in the original
// migrated CREATE definition (which correctly allows unknown wage breakdowns).
// Audit that exact known *physical-schema* discrepancy; NEVER invent zeros,
// silently change payroll semantics, or use it as an AI source admission grant.
// Every other type, field, foreign key, RLS or nullability discrepancy fails.
const documentedPayrollNullability=new Set([
 "regular_cents","overtime_cents","double_overtime_cents","gross_cents",
 "employee_tax_cents","employer_tax_cents","net_cents","source"
]);
function documentedProductionConstraintDifference(actual,production){
 if(!actual||!production||
   actual.relation!=="employee_pay_period_facts"||
   production.relation!=="employee_pay_period_facts")return false;
 const withoutNullability=r=>canonical({...r,columns:r.columns.map(c=>[c[0],c[1],true])});
 if(withoutNullability(actual)!==withoutNullability(production))return false;
 const cols=new Map(production.columns.map(c=>[c[0],c]));
 const differences=actual.columns.filter(c=>cols.get(c[0])?.[2]!==c[2]);
 return differences.length===documentedPayrollNullability.size&&
   differences.every(c=>documentedPayrollNullability.has(c[0])&&
    cols.get(c[0])?.[2]===true&&c[2]===false);
}
const notedDeltas=live.filter(x=>canonical(byName.get(x.relation))!==canonical(x)&&
 documentedProductionConstraintDifference(x,byName.get(x.relation)))
 .map(x=>x.relation);
const drift=live.filter(x=>canonical(byName.get(x.relation))!==canonical(x)&&
 !documentedProductionConstraintDifference(x,byName.get(x.relation)))
 .map(x=>x.relation);
const differences=drift.slice(0,6).map(relation=>{
 const currentRelation=live.find(x=>x.relation===relation);
 const previous=byName.get(relation);
 const expectedCols=new Map((previous?.columns??[]).map(c=>[c[0],c]));
 const actualCols=new Map((currentRelation?.columns??[]).map(c=>[c[0],c]));
 return {relation,expectedRls:previous?.rls,actualRls:currentRelation?.rls,
  changedColumns:[...actualCols].filter(([k,v])=>JSON.stringify(expectedCols.get(k))!==JSON.stringify(v)),
  removedColumns:[...expectedCols.keys()].filter(k=>!actualCols.has(k)),
  expectedForeignKeys:previous?.foreign_keys,actualForeignKeys:currentRelation?.foreign_keys};
});
const current=new Set(live.map(x=>x.relation));
const removed=reference.relations.filter(x=>!current.has(x.relation)).map(x=>x.relation);
// Independently compare the entire reviewed physical-to-logical research surface
// against the *actually migrated* SQL views. This is a generated schema-property
// check, not a fixed collection of owner-question scenarios.
const migration=readFileSync("supabase/migrations/20261120210000_u3_canonical_research.sql","utf8");
const tag="$u3_sources$";
const begin=migration.indexOf(tag),end=migration.indexOf(tag,begin+tag.length);
if(begin<0||end<0)throw Error("U3 source admission manifest missing");
const manifest=JSON.parse(migration.slice(begin+tag.length,end));
if(!Array.isArray(manifest)||!manifest.length)
 throw Error("U3 source admission manifest empty");
const expectedLogical=new Map(manifest.map(source=>[source.table,source.fields]));
expectedLogical.set("toast_records",[
 "source","source_ref","status","business_date","record_type","record_ref",
 "order_ref","check_ref","counts_in_sales","data"
]);
expectedLogical.set("toast_changes",[
 "change_id","entity","entity_guid","business_date","changed_at",
 "field_path","before_scalar","after_scalar"
]);
// Additional reviewed projections use the same signed scope and restricted
// role, but have different grains/columns from their physical sources.
expectedLogical.set("cafe_settings",[
 "timezone","currency","opened_on","payroll_tax_rate","payroll_tax_rate_status",
 "payroll_tax_rate_source","target_operating_margin","target_operating_margin_status",
 "owner_monthly_payroll_extras_cents","owner_monthly_payroll_extras_updated_at",
 "target_ingredient_cost_rate","target_ingredient_cost_rate_status"
]);
expectedLogical.set("opening_hours",[
 "location_id","timezone","weekday","hours_status","interval_index","open_time","close_time"
]);
expectedLogical.set("timecard_breaks",[
 "timecard_id","employee_id","clock_in","clock_out","source_type","source_provider",
 "pos_last_synced_at","recorded_break_count","break_index","break_start","break_end","paid"
]);
expectedLogical.set("current_owner_facts",[
 "fact_key","unit","period_scope","source","created_at","updated_at",
 "value_type","numeric_value","boolean_value"
]);
expectedLogical.set("processing_fee_daily_facts",[
 "business_date","amount_cents","status","source_type","provider","updated_at"
]);
expectedLogical.set("expense_categories",["code","qb_account_type","is_running_cost"]);
expectedLogical.set("toast_day_status",["business_date","import_state","recon_state","imported_at","net_sales_cents","gross_sales_cents","discounts_cents","refunds_cents","tax_cents","tip_cents","order_count","open_check_count","service_charges_cents","gratuity_cents","toast_net_sales_cents","toast_orders_count","toast_discount_cents","toast_refund_cents","delta_net_cents","delta_orders","recon_source","reconciled_at","unparsed_count","coverage_complete","analytics_state","delta_discount_cents","delta_refund_cents","delta_void_orders","void_amount_gap_cents","last_recon_attempt_at","paid_other_day","owner_confirmed_at"]);
expectedLogical.set("menu_item_cost_fallbacks",["menu_item_id","cost_cents","source_type","status","updated_at"]);
expectedLogical.set("team_rules",["meal_break_enabled","meal_break_minutes","meal_break_after_minutes","rest_break_enabled","rest_break_minutes","rest_break_every_minutes","weekly_ot_enabled","weekly_ot_after_minutes","ot_multiplier_bp","daily_ot_enabled","daily_ot_after_minutes","max_shift_enabled","max_shift_minutes","min_shift_enabled","min_shift_minutes","min_rest_enabled","min_rest_minutes","coverage_enabled","min_headcount","owner_set","updated_at","prep_minutes_before_open","prep_minutes_after_close"]);
expectedLogical.set("staff_schedules",["id","employee_id","day_of_week","start_time","end_time","unpaid_break_minutes","hourly_wage_cents","effective_from","effective_to","active"]);
expectedLogical.set("pos_scheduled_shifts",["location_id","provider","external_shift_id","external_employee_id","external_job_id","scheduled_start","scheduled_end","deleted","last_synced_at"]);
expectedLogical.set("staff_scheduling_preferences",["id","employee_id","effective_from","effective_to","min_weekly_minutes","desired_weekly_minutes","max_weekly_minutes","max_daily_minutes","source","confirmation","confirmed_at","revision","updated_at","unavailable_weekdays"]);
expectedLogical.set("staff_qualifications",["id","employee_id","location_id","qualification_code","valid_from","valid_to","source","confirmation","confirmed_at","revision","updated_at"]);
expectedLogical.set("scheduling_coverage_requirements",["id","location_id","day_of_week","local_date","effective_from","effective_to","start_local","end_local","overnight","min_headcount","qualification_code","min_overlap_minutes","priority","source","confirmation","confirmed_at","revision","updated_at"]);
expectedLogical.set("staff_custom_rules",["id","rule_text","active","created_at","updated_at"]);
expectedLogical.set("recovery_order",["bucket_code","position"]);
const observedLogical=new Map();
for(const column of logicalColumns??[]){
 const list=observedLogical.get(column.relation)??[];
 list.push(column.field);
 observedLogical.set(column.relation,list);
}
const badLogical=[...new Set([...expectedLogical.keys(),...observedLogical.keys()])]
 .filter(name=>JSON.stringify([...(expectedLogical.get(name)??[])].sort())!==
               JSON.stringify([...(observedLogical.get(name)??[])].sort()));
console.log("U3 generated logical admission parity",JSON.stringify({
 expectedSources:expectedLogical.size,migratedSources:observedLogical.size,
 mismatched:badLogical.slice(0,12)
}));
if(badLogical.length)throw Error("U3 approved logical view/field surface does not match migrated database");

if(process.argv.includes("--write")){
 const revised={...reference,
  generatedFrom:"fully migrated local Supabase pg_catalog; no business rows",
  relations:live};
 writeFileSync(snapshotPath,JSON.stringify(revised,null,1)+"\n");
 console.log("Regenerated non-authorizing physical census",stats);
}else{
 console.log("U3 full migrated physical schema census",JSON.stringify({expected,actual:stats,
  mismatched:drift.slice(0,15),documentedProductionOnlyConstraints:notedDeltas,removed:removed.slice(0,15),differences}));
 if(drift.length||removed.length||JSON.stringify(stats)!==JSON.stringify(expected))
  throw Error("U3 physical schema drift: regenerate and review field/source dispositions before admitting data");
}
