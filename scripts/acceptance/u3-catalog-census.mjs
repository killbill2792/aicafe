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
let live;
try{
 await client.connect();
 const {rows}=await client.query(sql);
 live=rows[0]?.catalog;
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
