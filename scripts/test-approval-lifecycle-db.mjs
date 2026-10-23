import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";

// Disposable PostgreSQL only: exercise the REAL supervisor ledger migration,
// row-lock transitions and the additional menu-only lifecycle RPCs.
const config={host:process.env.PGHOST??"127.0.0.1",port:Number(process.env.PGPORT??5432),
  user:"postgres",password:"postgres",database:"postgres"};
const db=new pg.Client(config);
const B="11111111-1111-4111-8111-111111111111";
const FOREIGN="22222222-2222-4222-8222-222222222222";
const OWNER="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD="33333333-3333-4333-8333-333333333333";
const PRODUCT="44444444-4444-4444-8444-444444444444";
const HASH="a".repeat(64);
const effect=(price)=>({productId:PRODUCT,productName:"Latte",oldPriceCents:450,
  newPriceCents:price,currency:"USD"});
const rpcEdit="select public.supervisor_replace_menu_price_draft($1,$2,$3,$4,$5,$6,$7,$8) as value";
const rpcStale="select public.supervisor_mark_stale_menu_price($1,$2,$3,$4,$5) as value";
const rpcTransition="select public.supervisor_transition_proposal($1,$2,$3,$4,$5,$6) as value";
const params=(id,rev,action)=>[B,OWNER,id,rev,action,null];
const editArgs=(id,rev,key,price)=>[B,OWNER,THREAD,id,rev,key,JSON.stringify(effect(price)),HASH];
const delay=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function withService(client,fn){
  await client.query("begin");
  try{
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
    const result=await fn(client);
    await client.query("commit");
    return result;
  }catch(err){await client.query("rollback");throw err;}
}
async function expectError(fn,code){
  let actual=null;
  try{await fn();}catch(e){actual=e.code;}
  assert.equal(actual,code,"expected SQLSTATE "+code);
}
async function draft(id,requestKey){
  await db.query(`insert into public.supervisor_proposals(
    id,business_id,owner_user_id,thread_id,request_key,
    capability_id,capability_version,canonical_effect_payload,effect_hash,
    baseline,monitor_spec,locale
  ) values ($1,$2,$3,$4,$5,'alex.menu_price_change.v1',1,
    $6::jsonb,$7,$8::jsonb,$9::jsonb,'en')`,[
    id,B,OWNER,THREAD,requestKey,JSON.stringify(effect(500)),HASH,
    JSON.stringify({source:"menu_items",status:"actual"}),
    JSON.stringify({durationDays:7,metricScope:PRODUCT}),
  ]);
}
async function row(id){
  const r=await db.query("select status,revision from supervisor_proposals where id=$1",[id]);
  return r.rows[0];
}
async function children(id){
  const r=await db.query("select count(*)::integer as total from supervisor_proposals where baseline->>'editedFrom'=$1",[id]);
  return r.rows[0].total;
}
const uuid=(last)=>"55555555-5555-4555-8555-"+last.toString().padStart(12,"0");

try{
  await db.connect();
  await db.query(`
    create extension if not exists pgcrypto;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'anon') $$;
    create table public.businesses(id uuid primary key);
    create table public.memberships(
      business_id uuid not null references businesses(id),
      user_id uuid not null references auth.users(id),
      role text not null,
      primary key(business_id,user_id)
    );
    create table public.ai_threads(
      id uuid primary key,business_id uuid not null references businesses(id),
      owner_user_id uuid not null references auth.users(id),
      unique(business_id,id,owner_user_id)
    );
    create table public.locations(
      id uuid primary key,business_id uuid not null references businesses(id)
    );
    grant usage on schema auth,public to service_role;
    grant execute on function auth.uid() to service_role;
    grant execute on function auth.role() to service_role;
    grant select on public.memberships to service_role;
  `);
  await db.query(readFileSync(new URL("../supabase/migrations/20261020000074_supervisor_execution_loop.sql",import.meta.url),"utf8"));
  await db.query(readFileSync(new URL("../supabase/migrations/20261023000083_approval_lifecycle_atomicity.sql",import.meta.url),"utf8"));
  await db.query("insert into businesses(id) values($1),($2)",[B,FOREIGN]);
  await db.query("insert into auth.users(id) values($1),($2)",[OWNER,STRANGER]);
  await db.query("insert into memberships(business_id,user_id,role) values($1,$2,'owner')",[B,OWNER]);
  await db.query("insert into ai_threads(id,business_id,owner_user_id) values($1,$2,$3)",[THREAD,B,OWNER]);

  // An edit must either complete BOTH row changes or preserve the old draft.
  const first=uuid(1);
  await draft(first,uuid(101));
  await expectError(()=>withService(db,c=>c.query(
    rpcEdit,editArgs(first,1,uuid(101),575))),"23505"); // duplicate request key
  assert.deepEqual(await row(first),{status:"draft",revision:1});
  assert.equal(await children(first),0);
  await expectError(()=>withService(db,c=>c.query(
    rpcEdit,editArgs(first,1,uuid(102),575).map((x,i)=>i===6?
      JSON.stringify({...effect(575),productId:uuid(800)}):x))),"P0001");
  assert.deepEqual(await row(first),{status:"draft",revision:1});
  const edited=await withService(db,async c=>(await c.query(
    rpcEdit,editArgs(first,1,uuid(102),575))).rows[0].value);
  assert.equal(edited.replaced.status,"rejected");
  assert.equal(edited.replaced.revision,2);
  assert.equal(edited.proposal.status,"draft");
  assert.equal(edited.proposal.baseline.editedFrom,first);
  assert.equal(edited.proposal.baseline.editedByOwner,true);
  assert.equal(edited.proposal.canonical_effect_payload.newPriceCents,575);
  assert.equal(await children(first),1);
  await expectError(()=>withService(db,c=>c.query(
    rpcEdit,editArgs(first,1,uuid(103),650))),"P0001");
  assert.equal(await children(first),1);

  // Both stale rejection and edited replacement require exact service role,
  // ownership, thread, revision and claimed approval evidence.
  const staleId=uuid(2);
  await draft(staleId,uuid(104));
  await expectError(()=>withService(db,c=>c.query(
    rpcStale,[B,OWNER,THREAD,staleId,1])),"P0001");
  await withService(db,c=>c.query(rpcTransition,params(staleId,1,"approve")));
  assert.deepEqual(await row(staleId),{status:"approved",revision:2});
  await withService(db,c=>c.query(rpcTransition,params(staleId,2,"claim_commit")));
  assert.deepEqual(await row(staleId),{status:"executing",revision:3});
  await expectError(()=>withService(db,c=>c.query(
    rpcStale,[B,OWNER,uuid(888),staleId,3])),"P0001");
  await withService(db,c=>c.query(rpcStale,[B,OWNER,THREAD,staleId,3]));
  assert.deepEqual(await row(staleId),{status:"stale",revision:4});
  await expectError(()=>withService(db,c=>c.query(
    rpcStale,[B,OWNER,THREAD,staleId,3])),"P0001");
  await expectError(()=>withService(db,c=>c.query(
    rpcTransition,params(staleId,4,"claim_commit"))),"P0001");

  // Approval wins row lock first: edit must fail without a child or rejection.
  const raceId=uuid(3);
  await draft(raceId,uuid(105));
  const other=new pg.Client(config);
  await other.connect();
  try{
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query(rpcTransition,params(raceId,1,"approve"));
    await other.query("begin");
    await other.query("set local role service_role");
    await other.query("select set_config('request.jwt.claim.role','service_role',true)");
    let settled=false;
    const waiting=other.query(rpcEdit,editArgs(raceId,1,uuid(106),575))
      .then(()=>{settled=true;return null;},e=>{settled=true;return e;});
    await delay(120);
    assert.equal(settled,false,"Edit must wait on approval row lock");
    await db.query("commit");
    const error=await Promise.race([waiting,delay(5000).then(()=>{throw Error("Edit lock timed out")})]);
    assert.equal(error?.code,"P0001");
    await other.query("rollback");
    assert.deepEqual(await row(raceId),{status:"approved",revision:2});
    assert.equal(await children(raceId),0);

    // Edit wins first: approval must fail at the old revision, and the new
    // approved price remains a separate draft (never silently applied).
    const raceEditId=uuid(4);
    await draft(raceEditId,uuid(107));
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    await db.query(rpcEdit,editArgs(raceEditId,1,uuid(108),650));
    await other.query("begin");
    await other.query("set local role service_role");
    await other.query("select set_config('request.jwt.claim.role','service_role',true)");
    settled=false;
    const waitingApprove=other.query(rpcTransition,params(raceEditId,1,"approve"))
      .then(()=>{settled=true;return null;},e=>{settled=true;return e;});
    await delay(120);
    assert.equal(settled,false,"Approve must wait on edit row lock");
    await db.query("commit");
    const approvalError=await Promise.race([waitingApprove,
      delay(5000).then(()=>{throw Error("Approve lock timed out")})]);
    assert.equal(approvalError?.code,"P0001");
    await other.query("rollback");
    assert.deepEqual(await row(raceEditId),{status:"rejected",revision:2});
    assert.equal(await children(raceEditId),1);
  }finally{
    await db.query("rollback").catch(()=>{});
    await other.query("rollback").catch(()=>{});
    await other.end();
  }
  console.log("Approval lifecycle PostgreSQL: stale terminal, failed edit rollback, scope and both approval/edit race orderings passed.");
}finally{await db.end();}
