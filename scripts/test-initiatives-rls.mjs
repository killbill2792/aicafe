import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
const db=new pg.Client({host:process.env.PGHOST||"127.0.0.1",
  port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE||"postgres",
  user:process.env.PGUSER||"postgres",password:process.env.PGPASSWORD||"postgres"});
const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  MANAGER="cccccccc-cccc-4ccc-8ccc-cccccccccccc",BIZ="11111111-1111-4111-8111-111111111111",
  THREAD="22222222-2222-4222-8222-222222222222",THREAD_B="33333333-3333-4333-8333-333333333333",
  ID="44444444-4444-4444-8444-444444444444",MID="55555555-5555-4555-8555-555555555555";
async function actor(user,fn){
  await db.query("begin");
  try{
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    await fn();await db.query("commit");
  }catch(e){await db.query("rollback");throw e;}
}
async function denied(sql){
  await db.query("savepoint denied");
  let caught;
  try{await db.query(sql);}catch(error){caught=error.code;}
  await db.query("rollback to savepoint denied");
  await db.query("release savepoint denied");
  assert.equal(caught,"42501",sql);
}
try{
  await db.connect();
  await db.query([
    "create extension if not exists pgcrypto;",
    "create schema auth;create role authenticated nologin;create role anon nologin;create role service_role nologin;",
    "create table auth.users(id uuid primary key);create table businesses(id uuid primary key);",
    "create table memberships(business_id uuid,user_id uuid,role text,primary key(business_id,user_id));",
    "create table ai_threads(business_id uuid,id uuid,owner_user_id uuid,unique(business_id,id,owner_user_id));",
    "create function auth.uid() returns uuid language sql stable as $$",
    "select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;",
    "grant usage on schema public,auth to authenticated;",
    "grant select on memberships,ai_threads to authenticated;grant execute on function auth.uid() to authenticated;",
  ].join("\n"));
  for(const uid of [A,B,MANAGER])await db.query("insert into auth.users values($1)",[uid]);
  await db.query("insert into businesses values($1)",[BIZ]);
  for(const [id,role] of [[A,"owner"],[B,"owner"],[MANAGER,"manager"]])
    await db.query("insert into memberships values($1,$2,$3)",[BIZ,id,role]);
  for(const [thread,owner] of [[THREAD,A],[THREAD_B,B]])
    await db.query("insert into ai_threads values($1,$2,$3)",[BIZ,thread,owner]);
  await db.query(readFileSync(new URL("../supabase/migrations/20261022000078_owner_initiatives.sql",import.meta.url),"utf8"));
  const insert="insert into owner_initiatives(id,business_id,owner_user_id,thread_id,request_key,kind,title,change_description,starts_on,ends_on,baseline_from,checkin_cadence,locale) values($1,$2,$3,$4,$5,'goal','Daily sales','','2026-10-15','2026-10-22','2026-10-08','daily','en')";
  await db.query(insert,[ID,BIZ,A,THREAD,'fixture-request-key']);
  await assert.rejects(db.query(insert,["66666666-6666-4666-8666-666666666666",BIZ,A,THREAD_B,"wrong-thread-key"]),{code:"23503"});
  const payload={kind:"goal",title:"Atomic goal",changeDescription:"",changeSpec:{},
    adapterId:null,startsOn:"2026-10-15",endsOn:"2026-10-22",
    baselineFrom:"2026-10-08",baselineTo:"2026-10-14",
    checkinCadence:"daily",locale:"en"};
  const metric=[{role:"primary",source:"computed",metric_key:"net_sales",
    params:{},comparator:"gte",target_kind:"absolute",target:100,
    checkin_question:null,checkin_audience:null,data_gap:null}];
  const args=[BIZ,A,THREAD,"idempotent-key-123456",JSON.stringify(payload),JSON.stringify(metric)];
  const rpc="select create_owner_initiative_atomic($1,$2,$3,$4,$5,$6) as id";
  const created=(await db.query(rpc,args)).rows[0].id;
  const retried=(await db.query(rpc,args)).rows[0].id;
  assert.equal(created,retried,"logical proposal retry must return the original initiative");
  assert.equal((await db.query("select id from initiative_metrics where initiative_id=$1",[created])).rowCount,1);
  await assert.rejects(db.query(rpc,[BIZ,A,THREAD,"bad-metric-request-123456",JSON.stringify(payload),
    JSON.stringify([{...metric[0],role:"invented"}])]),{code:"23514"});
  assert.equal((await db.query("select id from owner_initiatives where request_key='bad-metric-request-123456'")).rowCount,0,
    "a rejected child metric must roll back its parent in the same transaction");
  await db.query("insert into initiative_metrics(id,initiative_id,role,source,metric_key,comparator,target_kind,target) values($1,$2,'primary','computed','net_sales','gte','absolute',100)",[MID,ID]);
  await db.query("insert into initiative_observations(metric_id,business_date,value,coverage,source) values($1,'2026-10-15',100,1,'computed')",[MID]);
  await db.query("insert into initiative_evaluations(initiative_id,as_of,status,recommendation,digest,transition_key) values($1,'2026-10-15','on_track','keep','on_track:keep','initial-transition')",[ID]);
  const checkinId="77777777-7777-4777-8777-777777777777";
  await db.query("insert into initiative_metrics(id,initiative_id,role,source,metric_key,comparator,target_kind,target,checkin_question,checkin_audience,data_gap) values($1,$2,'guardrail','checkin',null,'gte','absolute',1,'Did it arrive?','owner','owner response')",[checkinId,ID]);
  await db.query("update owner_initiatives set status='active' where id=$1",[ID]);
  const checkinSql="select record_owner_initiative_checkin_atomic($1,$2,$3,$4,$5,$6,$7,$8) as result";
  const firstArgs=[BIZ,A,checkinId,"2026-10-15",null,"first note",null,"first-operation-key"];
  const first=(await db.query(checkinSql,firstArgs)).rows[0].result;
  assert.deepEqual(first,{created:true,corrected:false,revision:1});
  const correction=[BIZ,A,checkinId,"2026-10-15",1,"corrected",1,"second-operation-key"];
  assert.deepEqual((await db.query(checkinSql,correction)).rows[0].result,
    {created:false,corrected:true,revision:2});
  assert.deepEqual((await db.query(checkinSql,firstArgs)).rows[0].result,first,
    "a delayed duplicate operation must not overwrite the correction");
  const saved=(await db.query("select value,revision,coverage from initiative_observations where metric_id=$1",[checkinId])).rows[0];
  assert.equal(Number(saved.value),1);
  assert.equal(saved.revision,2);
  assert.equal(Number(saved.coverage),1);
  await assert.rejects(db.query(checkinSql,[BIZ,A,checkinId,"2026-10-15",0,"stale",1,"third-operation-key"]),{code:"40001"});
  await assert.rejects(db.query(checkinSql,[BIZ,B,checkinId,"2026-10-15",1,"forged",null,"foreign-operation-key"]),{code:"42501"});
  const t1="88888888-8888-4888-8888-888888888888";
  const t2="99999999-9999-4999-8999-999999999999";
  const revision=(await db.query("select revision from owner_initiatives where id=$1",[ID])).rows[0].revision;
  const leaseSql="select claim_owner_initiative_monitor($1,$2,$3) as revision";
  const leased=(await db.query(leaseSql,[ID,revision,t1])).rows[0].revision;
  assert.equal(leased,revision+1,"first worker acquires lease");
  assert.equal((await db.query(leaseSql,[ID,leased,t2])).rows[0].revision,null,
    "overlapping worker cannot acquire another lease");
  const observationSql="select write_owner_initiative_monitor_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as wrote";
  const leaseObsArgs=[BIZ,A,ID,t1,MID,"2026-10-16",125,1,null,false];
  assert.equal((await db.query(observationSql,leaseObsArgs)).rows[0].wrote,true);
  assert.equal((await db.query(observationSql,[...leaseObsArgs.slice(0,3),t2,...leaseObsArgs.slice(4)])).rows[0].wrote,false);
  const resultSql="select write_owner_initiative_monitor_evaluation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as wrote";
  const evalArgs=[BIZ,A,ID,t1,"2026-10-16","on_track","keep",
    JSON.stringify({count:1}),JSON.stringify({baseline:[100],test:[125]}),
    "transition-unique-1","digest-unique-1"];
  assert.equal((await db.query(resultSql,evalArgs)).rows[0].wrote,true);
  // An explicit new source contradiction (e.g. unknown modifier cost) must
  // invalidate yesterday's verified economics. A transient missing fetch cannot.
  const invalidation=[...leaseObsArgs.slice(0,6),null,0,"modifierCostUnverified",true];
  const noProof=[...leaseObsArgs.slice(0,6),null,0,"temporarilyUnavailable",false];
  assert.equal((await db.query(observationSql,noProof)).rows[0].wrote,false);
  assert.equal((await db.query(observationSql,invalidation)).rows[0].wrote,true);
  const invalidated=(await db.query("select value,coverage from initiative_observations where metric_id=$1 and business_date='2026-10-16'",[MID])).rows[0];
  assert.equal(invalidated.value,null);
  assert.equal(Number(invalidated.coverage),0);
  const released=(await db.query("select release_owner_initiative_monitor($1,$2,$3,$4) as released",
    [ID,t1,false,0])).rows[0].released;
  assert.equal(released,true);
  assert.equal((await db.query(observationSql,[...leaseObsArgs.slice(0,6),200,1,null,false])).rows[0].wrote,false,
    "late worker must not write after releasing its lease");
  assert.equal((await db.query(resultSql,evalArgs)).rows[0].wrote,false,
    "late worker cannot write evaluations");
  assert.equal((await db.query(leaseSql,[ID,leased,t2])).rows[0].revision,leased+1,
    "a released job can be claimed by next worker");
  await db.query("select release_owner_initiative_monitor($1,$2,$3)",[ID,t2,false,0]);
  await actor(A,async()=>{
    for(const table of ["owner_initiatives","initiative_metrics","initiative_observations","initiative_evaluations"])
      assert.equal((await db.query("select * from "+table)).rowCount,
        table==="owner_initiatives"?2:table==="initiative_metrics"?3:
          table==="initiative_observations"?3:table==="initiative_evaluations"?2:1,table);
    await denied("update owner_initiatives set status='active'");
    await denied("delete from initiative_metrics");
    await denied("insert into initiative_evaluations(initiative_id,as_of,status,recommendation,digest) values ('44444444-4444-4444-8444-444444444444','2026-10-15','met','keep','forged')");
  });
  for(const user of [B,MANAGER])await actor(user,async()=>{
    for(const table of ["owner_initiatives","initiative_metrics","initiative_observations","initiative_evaluations"])
      assert.equal((await db.query("select * from "+table)).rowCount,0,table);
  });
  console.log("M1 PostgreSQL owner-only RLS, cross-owner FK, and immutable writes passed");
}finally{await db.end();}
