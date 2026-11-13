/**
 * Task 14a migrated, disposable Postgres acceptance. NEVER point at live DB.
 * TASK14A_DISPOSABLE_DB=1 node scripts/task14a-inventory-evidence-db.mjs
 * Uses the existing Supabase local migrations and rolls back all fixtures.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";

if(process.env.TASK14A_DISPOSABLE_DB!=="1")throw Error("Disposable DB opt-in required");
const cfg={host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",
 password:"postgres",connectionTimeoutMillis:5000};
const db=new pg.Client(cfg);
const ids={cafe:randomUUID(),otherCafe:randomUUID(),owner:randomUUID(),
 otherOwner:randomUUID(),location:randomUUID(),otherLocation:randomUUID(),
 restaurant:randomUUID(),otherRestaurant:randomUUID(),stock:randomUUID(),
 ingredient:randomUUID()};
const date=new Date().toISOString().slice(0,10);
const stamped=(n)=>new Date(Date.now()+n*60000).toISOString();
let assertions=0;
const check=(value,description)=>{assert.ok(value,description);assertions++;};
const one=async(sql,params=[])=>((await db.query(sql,params)).rows[0]??null);
const fail=async(fn,code)=>{let actual=null;try{await fn();}catch(e){actual=e.code;}
 assert.equal(actual,code);assertions++;};
const stock=(quantity,asOf)=>({
 business_id:ids.cafe,restaurant_guid:ids.restaurant,
 endpoint:"stock/v1/inventory",provider_key:ids.stock,
 source_key_kind:"provider_guid",source_business_date_kind:"observed_cafe_day",
 guid:ids.stock,status:"QUANTITY",quantity,business_date:date,lastSuccessAt:asOf
});
const receipt=async(time,successful,status,count)=>{
 await db.query(`insert into public.toast_optional_sync_state
 (business_id,restaurant_guid,operational_sources) values ($1,$2,$3::jsonb)
 on conflict (business_id,restaurant_guid) do update
 set operational_sources=excluded.operational_sources`,[
 ids.cafe,ids.restaurant,JSON.stringify({stock_inventory:{
 last_checked_at:time,last_success_at:successful,status,count}})]);
};
const stage=async(payload)=>db.query(
 "select public.toast_stage_operational_batch($1,$2,'stock/v1/inventory',$3,$4::jsonb)",
 [ids.cafe,ids.restaurant,date,JSON.stringify([payload])]);
const view=async()=>one(`select source,source_ref,stock_status,quantity,
  data->>'evidence_state' as evidence_state,data->>'source_as_of' as as_of,
  data->>'reported_stock_status' as reported
 from public.cv_inventory where business_id=$1 and menu_item_ref=$2`,
 [ids.cafe,ids.stock]);
async function asRole(role,user,fn){
 await db.query("SAVEPOINT task14a_role");
 try{
  await db.query("SET LOCAL ROLE "+role);
  await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user??""]);
  const result=await fn();
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14a_role");
  return result;
 }catch(e){
  await db.query("ROLLBACK TO SAVEPOINT task14a_role");
  await db.query("SET LOCAL ROLE NONE");
  await db.query("RELEASE SAVEPOINT task14a_role");
  throw e;
 }
}
try{
 await db.connect();
 await db.query("BEGIN");
 check((await one("select to_regprocedure('public.toast_stock_source_receipts(uuid)') is not null as ok")).ok,
  "migration installed");
 await db.query(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14a-a@example.invalid','',now(),now()),
 ($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','task14a-b@example.invalid','',now(),now())`,[ids.owner,ids.otherOwner]);
 await db.query("insert into public.businesses(id,name,is_demo,timezone) values($1,'Task14a sandbox A',false,'UTC'),($2,'Task14a sandbox B',false,'UTC')",
  [ids.cafe,ids.otherCafe]);
 await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
  [ids.cafe,ids.owner,ids.otherCafe,ids.otherOwner]);
 await db.query("insert into public.locations(id,business_id,name) values($1,$2,'A'),($3,$4,'B')",
  [ids.location,ids.cafe,ids.otherLocation,ids.otherCafe]);
 await db.query(`insert into public.toast_api_credentials(business_id,api_origin,client_id,client_secret_enc)
 values ($1,'https://synthetic.example','task14a-inert-a','not-a-token'),
 ($2,'https://synthetic.example','task14a-inert-b','not-a-token')`,[ids.cafe,ids.otherCafe]);
 await db.query(`insert into public.toast_location_mappings
 (business_id,location_id,restaurant_guid,verified_at,toast_time_zone,closeout_hour,toast_start_date)
 values($1,$2,$3,now(),'UTC',4,$7::date),($4,$5,$6,now(),'UTC',4,$7::date)`,
 [ids.cafe,ids.location,ids.restaurant,ids.otherCafe,ids.otherLocation,ids.otherRestaurant,date]);
 await db.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Milk','ml')",
  [ids.ingredient,ids.cafe]);
 await db.query(`insert into public.pantry_stock_counts
 (business_id,ingredient_id,count_date,quantity_base,entered_quantity,entered_unit)
 values($1,$2,$3,0,0,'ml')`,[ids.cafe,ids.ingredient,date]);
 const zero=await one("select quantity from public.cv_inventory where business_id=$1 and source='app' and business_date=$2",
  [ids.cafe,date]);
 check(Number(zero?.quantity)===0,"explicit owner-count zero is a known zero");
 const first=stamped(-10),second=stamped(-5),third=stamped(-1),fourth=stamped(0);
 await stage(stock(7,first));await receipt(first,first,"current",1);
 let row=await view();
 check(Number(row?.quantity)===7&&row?.evidence_state==="observed_current",
  "latest successful row has reported quantity");
 // Replaying the same object preserves its unique operational identity.
 await stage(stock(7,first));
 check(Number((await one(`select count(*)::int as n from public.toast_raw_records
 where business_id=$1 and entity='stock/v1/inventory'`,[ids.cafe])).n)===1,
 "replay does not create a second source object");
 await stage(stock(4,second));await receipt(second,second,"current",1);
 row=await view();
 check(Number(row?.quantity)===4&&row?.evidence_state==="observed_current",
  "corrected version replaces current quantity, does not add 7 and 4");
 check(Number((await one(`select count(*)::int as n from public.toast_raw_records
 where business_id=$1 and entity='stock/v1/inventory'`,[ids.cafe])).n)===1,
 "one latest object after changed version");
 await receipt(third,third,"empty",0);
 row=await view();
 check(row?.quantity===null&&row?.stock_status===null&&row?.evidence_state==="not_observed",
  "new successful empty family retains old row only as history");
 check(row?.reported==="QUANTITY"&&row?.as_of===second,
  "historical source status and timestamp are preserved");
 await receipt(fourth,third,"unavailable",0);
 row=await view();
 check(row?.quantity===null&&row?.evidence_state==="source_failed",
  "failed fetch cannot refresh last-good stock as current");
 const ownerReceipt=await asRole("authenticated",ids.owner,()=>one(
 "select source_status from public.toast_stock_source_receipts($1)",[ids.cafe]));
 check(ownerReceipt?.source_status==="failed","owner gets only allowlisted receipt");
 await fail(()=>asRole("authenticated",ids.otherOwner,()=>
  db.query("select * from public.toast_stock_source_receipts($1)",[ids.cafe])),"42501");
 const otherRows=await asRole("authenticated",ids.otherOwner,()=>
  db.query("select * from public.cv_inventory where business_id=$1",[ids.cafe]));
 check(otherRows.rows.length===0,"foreign café cannot read inventory");
 const ownerRows=await asRole("authenticated",ids.owner,()=>
  db.query("select * from public.cv_inventory where business_id=$1",[ids.cafe]));
 check(ownerRows.rows.some(r=>r.source==="app"&&Number(r.quantity)===0)&&
  ownerRows.rows.some(r=>r.source==="toast"&&r.quantity===null),
  "Pantry and registered canonical query read identical bounded state");
 const def=(await one("select pg_get_viewdef('public.cv_inventory'::regclass) as definition")).definition;
 check(!def.includes("toast_raw_samples"),"diagnostic captures never feed stock view");
 check((await one(`select reloptions @> array['security_invoker=true'] as ok
 from pg_class where oid='public.cv_inventory'::regclass`)).ok,
 "view remains RLS invoker");
 console.log("Task 14a inventory DB acceptance: "+assertions+" assertions passed");
}finally{
 try{await db.query("ROLLBACK");}catch{}
 await db.end().catch(()=>{});
}
