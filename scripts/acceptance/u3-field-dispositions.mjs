#!/usr/bin/env node
/** U3 physical-field disposition audit, not an authorization registry.
 * All source permission is still granted only by the reviewed U3 migration.
 * Run after the migrated-catalog parity gate; no business rows are read. */
import {readFileSync,writeFileSync} from "node:fs";
const census=JSON.parse(readFileSync("docs/plans/u3-physical-schema-census.generated.json","utf8"));
const migration=readFileSync("supabase/migrations/20261120210000_u3_canonical_research.sql","utf8");
const tag="$u3_sources$",start=migration.indexOf(tag),end=migration.indexOf(tag,start+tag.length);
if(start<0||end<0)throw Error("U3 reviewed source manifest unavailable");
const admitted=JSON.parse(migration.slice(start+tag.length,end));
const byTable=new Map(admitted.map(s=>[s.table,s]));
if(byTable.size!==admitted.length)throw Error("Duplicate approved relation in manifest");
const archiveName=/^(toast_raw_|toast_day_pages$|toast_modified_orders_staging$)/;
const secretName=/(credential|oauth|token|password|access_code|secret|webhook_subscription|api_key|private_key)/i;
const platformName=/^(ai_|agent_|supervisor_|connector_|toast_|whatsapp_|csv_|scheduling_|staff_communication_|maintenance_case_|processing_fee_|purchase_order_dispatch|cafe_sync_|square_sync_|data_health_)/;
const specialistName=/^(owner_facts|operating_tasks|operating_task_responses|alerts|staff_|scheduling_|city_|cafe_city_|cafe_event_|goals|decision_|supplier_|purchase_|product_|menu_|expense_|team_|uploads|vendor_|p1_)/;
function steward(table){
 if(/^(toast_|pos_|orders|order_lines|menu_|recipe_|ingredient_|catalog_)/.test(table))return "POS and menu domain";
 if(/^(employee_|staff_|scheduling_|timecards|scheduled_)/.test(table))return "Staff and scheduling domain";
 if(/^(purchase_|supplier_|expenses|expense_|recurring_|pantry_|processing_fee_)/.test(table))return "Finance and purchasing domain";
 if(/^(city_|cafe_city_|cafe_event_|cafe_neighborhood_)/.test(table))return "External market evidence domain";
 return "Supervisor/data-platform source owner";
}
function disposition(table,column){
 const reviewed=byTable.get(table);
 if(reviewed?.fields?.includes(column))return [
  reviewed.sensitive?.includes(column)?"admitted_masked_personal_field":"admitted_research_field",
  reviewed.sensitive?.includes(column)?
   "Reviewed model-visible field with authenticated owner-only data; masked in unattended work":
   "Reviewed model-visible field; access still requires signed scope, RLS and query admission"
 ];
 if(reviewed&&column==="business_id")return ["scope_only",
  "Verified café isolation field, intentionally not projected as a model-selected business value"];
 if(secretName.test(table)||secretName.test(column))return ["restricted_secret_or_auth",
  "Credential, authorization or sensitive internal identifier; no universal research permission"];
 if(archiveName.test(table))return ["protected_operational_archive",
  "Raw current/delta/staging store; only approved scoped logical projections may read it"];
 if(reviewed)return ["not_admitted_from_source",
  "Existing physical source column requires separate field semantics/privacy review"];
 if(platformName.test(table))return ["internal_or_specialized_service",
  "Operational workflow/audit/state; source-family tool or owner-specific review required"];
 if(specialistName.test(table))return ["specialist_or_review_pending",
  "Potential business fact; use existing authorized specialist or review before new SQL admission"];
 return ["unreviewed_not_admitted",
  "Physical object alone cannot prove safe business meaning, source authority or tenant permission"];
}
const physical=census.relations.filter(r=>r.kind==="table").sort((a,b)=>a.relation.localeCompare(b.relation));
const records=physical.map(t=>({
 relation:t.relation,sourceOwner:steward(t.relation),
 fields:t.columns.map(([field,type,notNull])=>{
  const [status,reason]=disposition(t.relation,field);
  return {field,type,notNull,status,reason};
 }).sort((a,b)=>a.field.localeCompare(b.field))
}));
for(const s of admitted){
 const actual=records.find(t=>t.relation===s.table);
 if(!actual)throw Error("Approved source not in migrated physical inventory: "+s.table);
 for(const field of s.fields){
  const x=actual.fields.find(c=>c.field===field);
  if(!x||!x.status.startsWith("admitted_"))
   throw Error("Approved field not classified for SQL research: "+s.table+"."+field);
 }
}
const counts={};
for(const relation of records)for(const field of relation.fields)
 counts[field.status]=(counts[field.status]??0)+1;
const result={
 schemaVersion:1,generatedFrom:"migrated pg_catalog physical schema + reviewed U3 SQL manifest",
 modelAuthorization:false,productionRowsIncluded:false,
 physicalTables:records.length,
 physicalFields:records.reduce((n,r)=>n+r.fields.length,0),
 approvedSqlRelations:admitted.length,
 reviewedFields:admitted.reduce((n,r)=>n+r.fields.length,0),
 additionalLogicalViews:["toast_records","toast_changes"],
 legend:"Non-admitted fields require authorized specialist or explicit source/field review, not automatic exposure.",
 dispositionCounts:Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b))),
 relations:records
};
const file="docs/plans/u3-field-dispositions.generated.json";
const json=JSON.stringify(result,null,2)+"\n";
if(process.argv.includes("--write")){
 writeFileSync(file,json);
 console.log("Generated non-authorizing U3 field dispositions",JSON.stringify({
  physicalTables:result.physicalTables,physicalFields:result.physicalFields,
  approvedSqlRelations:result.approvedSqlRelations,reviewedFields:result.reviewedFields
 }));
}else{
 if(readFileSync(file,"utf8")!==json)
  throw Error("U3 physical field dispositions drifted; regenerate after reviewing source/field policy");
 console.log("U3 physical field disposition audit passed",JSON.stringify({
  physicalTables:result.physicalTables,physicalFields:result.physicalFields,
  approvedSqlRelations:result.approvedSqlRelations,reviewedFields:result.reviewedFields,
  dispositions:result.dispositionCounts
 }));
}
