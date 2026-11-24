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
expectedLogical.set("employees",[...expectedLogical.get("employees"),"pos_team_member_id","min_weekly_minutes","max_weekly_minutes","available_days","pos_display_name","pos_last_role","pos_last_wage_cents","pos_last_active"]);
expectedLogical.set("scheduled_shifts",[...expectedLogical.get("scheduled_shifts"),"break_source","repeat_schedule_id","proposal_id","created_at","updated_at"]);
expectedLogical.set("toast_location_mappings",["location_id","restaurant_guid","verified_at","toast_time_zone","closeout_hour","info_refreshed_at","toast_start_date"]);
expectedLogical.set("toast_employee_directory",["restaurant_guid","employee_guid","display_name","deleted","linked_employee_id","linked_at","fetched_at"]);
expectedLogical.set("staff_preference_windows",["id","employee_id","day_of_week","start_local","end_local","overnight","preference","strength","effective_from","effective_to","source","confirmation","confirmed_at","revision","created_at","updated_at"]);
expectedLogical.set("staff_scheduling_compensation",["id","employee_id","cash_cost_state","eligibility_verified_at","revision","created_at","updated_at"]);
expectedLogical.set("menu_items",[...expectedLogical.get("menu_items"),"description","prep_seconds","pos_pricing_strategy","pos_archived_at"]);
expectedLogical.set("city_events",["id","city_key","name","kind","start_date","end_date","start_time","end_time","time_source_url","venue","venue_address","last_checked_at","duration_source_url","duration_verified_at","start_at","end_at","source_timezone","lifecycle_status","lifecycle_verified_at"]);
expectedLogical.set("city_event_sources",["city_event_id","source_url","observed_name","observed_at"]);
expectedLogical.set("city_source_coverage",["city_key","source_key","window_from","window_to","status","last_checked_at","last_completed_at","scan_from","scan_to","window_reason","search_attempted","is_scan_root","failure_category"]);
expectedLogical.set("city_places",["id","city_key","name","kind","address","source_url","calendar_url","last_checked_at","visitor_info_url","visitor_approach","visitor_approach_source_url","entrance","entrance_source_url","source_status","source_checked_at"]);
expectedLogical.set("cafe_city_event_links",["cafe_event_id","city_event_id","linked_at"]);
expectedLogical.set("cafe_neighborhood_source_coverage",["scope","status","retry_eligible","checked_at","last_completed_at","failure_category","places_found","discarded_candidates"]);
expectedLogical.set("inventory_observations",["source","source_ref","status","business_date","menu_item_ref","ingredient_id","ingredient_name","quantity_unit","quantity","stock_status","reported_stock_status","evidence_state","source_as_of","checked_at","source_status","observed_count"]);
expectedLogical.set("supplier_quotes",["id","ingredient_id","supplier_name","item_name","price_cents","package_count","package_unit","source_kind","quoted_on","evidence_status","created_at","currency_code","valid_until","available_status","available_checked_at","delivery_on"]);
expectedLogical.set("goal_metrics",["goal_id","title","status","created_at","monitoring_start_date","days","baseline_from","baseline_to","currency","metric_id","metric_role","metric_key","item_id","item_name","comparator","target_kind","target","checkin_cadence","checkin_audience"]);
expectedLogical.set("goal_observations",["goal_id","metric_id","metric_key","sample_date","observed_date","observation_kind","value_cents","value_count","coverage_ratio","evidence_source","recorded_at"]);
expectedLogical.set("goal_checkins",["goal_id","checkin_id","business_date","status","question","audience","answer","note","created_at","resolved_at"]);
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
expectedLogical.set("toast_day_status",["restaurant_guid","business_date","import_state","recon_state","imported_at","net_sales_cents","gross_sales_cents","discounts_cents","refunds_cents","tax_cents","tip_cents","order_count","open_check_count","service_charges_cents","gratuity_cents","toast_net_sales_cents","toast_orders_count","toast_discount_cents","toast_refund_cents","delta_net_cents","delta_orders","recon_source","reconciled_at","unparsed_count","coverage_complete","analytics_state","delta_discount_cents","delta_refund_cents","delta_void_orders","void_amount_gap_cents","last_recon_attempt_at","paid_other_day","owner_confirmed_at"]);
expectedLogical.set("menu_item_cost_fallbacks",["menu_item_id","cost_cents","source_type","status","updated_at"]);
expectedLogical.set("team_rules",["meal_break_enabled","meal_break_minutes","meal_break_after_minutes","rest_break_enabled","rest_break_minutes","rest_break_every_minutes","weekly_ot_enabled","weekly_ot_after_minutes","ot_multiplier_bp","daily_ot_enabled","daily_ot_after_minutes","max_shift_enabled","max_shift_minutes","min_shift_enabled","min_shift_minutes","min_rest_enabled","min_rest_minutes","coverage_enabled","min_headcount","owner_set","updated_at","prep_minutes_before_open","prep_minutes_after_close"]);
expectedLogical.set("staff_schedules",["id","employee_id","day_of_week","start_time","end_time","unpaid_break_minutes","hourly_wage_cents","effective_from","effective_to","active"]);
expectedLogical.set("pos_scheduled_shifts",["location_id","provider","external_shift_id","external_employee_id","external_job_id","scheduled_start","scheduled_end","deleted","last_synced_at"]);
expectedLogical.set("staff_scheduling_preferences",["id","employee_id","effective_from","effective_to","min_weekly_minutes","desired_weekly_minutes","max_weekly_minutes","max_daily_minutes","source","confirmation","confirmed_at","revision","updated_at","unavailable_weekdays"]);
expectedLogical.set("staff_qualifications",["id","employee_id","location_id","qualification_code","valid_from","valid_to","source","confirmation","confirmed_at","revision","updated_at"]);
expectedLogical.set("scheduling_coverage_requirements",["id","location_id","day_of_week","local_date","effective_from","effective_to","start_local","end_local","overnight","min_headcount","qualification_code","min_overlap_minutes","priority","source","confirmation","confirmed_at","revision","updated_at"]);
expectedLogical.set("staff_custom_rules",["id","rule_text","active","created_at","updated_at"]);
expectedLogical.set("recovery_order",["bucket_code","position"]);
expectedLogical.set("recorded_timecards",["timecard_id","employee_id","employee_name","timezone","clock_in","clock_out","source_type","source_provider","wage_source","hourly_wage_cents","pos_last_synced_at","provider_regular_hours","provider_overtime_hours","recorded_break_count"]);
expectedLogical.set("expenses",[...expectedLogical.get("expenses"),"custom_label","recurring_cost_id"]);
expectedLogical.set("customer_visits",["source","source_ref","status","business_date","identity_ref","identity_state","restaurant_ref","order_ref","eligible_check_count","net_sales_cents","known_money_check_count","first_observed_date","last_observed_date","previous_observed_date","next_observed_date","observed_visit_number","days_since_previous","days_since_last_observed","first_observed_visit","returning_visit","observed_return_7d","observed_return_30d","observed_return_60d","observed_return_90d","history_start_date","as_of_date","period_account_visits","period_account_net_sales_cents","period_account_revenue_share","period_account_revenue_share_squared","history_account_net_sales_cents","observed_prior_cadence_days","observed_reactivation_gap_ratio","observed_lapse_gap_ratio","order_duration_seconds","observed_lapse_flag","observed_reappearance_flag","historical_recipe_cost_cents","historical_recipe_contribution_cents"]);
expectedLogical.set("customer_products",["source","source_ref","status","business_date","restaurant_ref","identity_ref","visit_ref","order_ref","check_ref","visit_class","fact_kind","product_ref","item_group_ref","modifier_ref","option_group_ref","paired_product_ref","quantity","pair_occurrence","order_channel","local_hour","business_weekday"]);
expectedLogical.set("customer_coverage",["eligible_check_count","linked_check_count","named_check_count","known_money_check_count","linked_known_money_check_count","recorded_net_cents","linked_recorded_net_cents","expected_location_days","complete_location_days","complete"]);
expectedLogical.set("financial_statement_documents",["statement_id","account_key","currency_code","statement_from","statement_to","opening_cents","closing_cents","transaction_count"]);
expectedLogical.set("financial_statement_transactions",["statement_id","row_index","transaction_date","amount_cents","balance_cents","currency_code"]);
expectedLogical.set("financial_invoice_claims",["invoice_id","supplier_id","purchase_order_id","invoice_reference","revision","issued_on","due_on","currency_code","total_cents"]);
expectedLogical.set("financial_bill_claims",["bill_id","payee","bill_reference","revision","issued_on","due_on","amount_cents","currency_code","source_kind"]);
expectedLogical.set("financial_settlement_evidence",["event_id","invoice_id","statement_id","row_index","transaction_date","kind","allocation_cents","reverses_id","source_revision"]);
expectedLogical.set("event_readiness_plans",["plan_id","status","start_date","end_date","importance","summary","created_at"]);
expectedLogical.set("event_readiness_links",["plan_id","event_id"]);
expectedLogical.set("event_readiness_actions",["plan_id","action_index","area","action_text","reason","checklist_state","checklist_updated_at"]);
expectedLogical.set("event_readiness_observations",["plan_id","business_date","coverage","event_activity","actual_cents","typical_cents","change_percent","baseline_days","hourly_coverage","evidence_source","recorded_at"]);
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
