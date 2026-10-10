/**
 * Run Migration #36 in a throwaway PostgreSQL database as part of CI.
 * Never point this script at live Supabase: it creates isolated auth mocks.
 */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";

const {Client}=pg;
const client=new Client({
  host:process.env.PGHOST??"127.0.0.1",
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??"postgres",
  password:process.env.PGPASSWORD??"postgres",
  database:process.env.PGDATABASE??"cafe_rls_test",
});
const CAFE="11111111-1111-4111-8111-111111111111";
const OTHER_CAFE="22222222-2222-4222-8222-222222222222";
const OWNER_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTSIDER="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PHONE_A="+15555550101";
const PHONE_B="+15555550102";

async function asActor(userId,run){
  await client.query("BEGIN");
  try{
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[userId]);
    await run();
    await client.query("COMMIT");
  }catch(err){await client.query("ROLLBACK");throw err;}
}
async function mustReject(sql,params,code){
  await client.query("SAVEPOINT expected_reject");
  let actual=null;
  try{await client.query(sql,params);}
  catch(err){actual=err.code;}
  finally{
    await client.query("ROLLBACK TO SAVEPOINT expected_reject");
    await client.query("RELEASE SAVEPOINT expected_reject");
  }
  assert.ok(actual,"Expected SQL query to reject, but it succeeded");
  if(code)assert.equal(actual,code);
}

await client.connect();
try{
  await client.query(`
    create schema auth;
    create role authenticated nologin;
    create table auth.users(
      id uuid primary key,
      phone text,
      phone_confirmed_at timestamptz
    );
    create table businesses(id uuid primary key);
    create table memberships(
      business_id uuid not null references businesses(id),
      user_id uuid not null references auth.users(id),
      role text not null,
      primary key(business_id,user_id)
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema public,auth to authenticated;
    grant select on memberships to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  for(const [id,phone,confirmed] of [
    [OWNER_A,PHONE_A,true],[OWNER_B,PHONE_B,true],
    [MANAGER,"+15555550103",true],[OUTSIDER,null,false],
  ]){
    await client.query("insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,$3)",
      [id,phone,confirmed?new Date().toISOString():null]);
  }
  for(const id of [CAFE,OTHER_CAFE])
    await client.query("insert into businesses(id) values($1)",[id]);
  for(const [business,user,role] of [
    [CAFE,OWNER_A,"owner"],[CAFE,OWNER_B,"owner"],
    [CAFE,MANAGER,"manager"],[OTHER_CAFE,OWNER_A,"owner"],
  ])await client.query(
    "insert into memberships(business_id,user_id,role) values($1,$2,$3)",[business,user,role]);

  const migration=readFileSync(new URL(
    "../supabase/migrations/20261010000036_ai_owner_notifications.sql",import.meta.url),"utf8");
  assert.equal(migration.match(/create table if not exists ai_owner_notifications/gi)?.length,1);
  assert.equal(migration.match(/create table if not exists ai_delivery_attempts/gi)?.length,1);
  assert.equal(migration.match(/create or replace function guard_ai_notification_consent/gi)?.length,1);
  assert.equal(migration.match(/create trigger ai_notification_consent_guard/gi)?.length,1);

  // Explicit transaction: syntax/DDL failures leave no partially applied migration.
  await client.query("BEGIN");
  try{await client.query(migration);await client.query("COMMIT");}
  catch(err){await client.query("ROLLBACK");throw err;}

  const tables=await client.query(
    "select to_regclass('public.ai_owner_notifications') as prefs, to_regclass('public.ai_delivery_attempts') as attempts");
  assert.equal(tables.rows[0].prefs,"ai_owner_notifications");
  assert.equal(tables.rows[0].attempts,"ai_delivery_attempts");
  const rls=await client.query(
    "select relname,relrowsecurity from pg_class where relname in ('ai_owner_notifications','ai_delivery_attempts') order by relname");
  assert.equal(rls.rows.length,2);
  assert.ok(rls.rows.every(row=>row.relrowsecurity));

  await asActor(OWNER_A,async()=>{
    const result=await client.query(
      "insert into ai_owner_notifications (business_id,owner_user_id,phone_e164,opted_in,consent_at) values($1,$2,$3,true,now()) returning opted_in",
      [CAFE,OWNER_A,PHONE_A]);
    assert.equal(result.rows[0].opted_in,true);
    assert.equal((await client.query("select * from ai_owner_notifications")).rowCount,1);

    // Direct PostgREST requests cannot add a different number, even if E.164.
    await mustReject(
      "update ai_owner_notifications set phone_e164=$1 where business_id=$2 and owner_user_id=$3",
      ["+15555550999",CAFE,OWNER_A],"42501");
    await mustReject(
      "insert into ai_owner_notifications(business_id,owner_user_id,phone_e164,opted_in,consent_at) values($1,$2,$3,true,now())",
      [OTHER_CAFE,OWNER_A,"+15555550999"],"42501");
    await mustReject(
      "update ai_owner_notifications set owner_user_id=$1 where business_id=$2 and owner_user_id=$3",
      [OWNER_B,CAFE,OWNER_A],"42501");
    await mustReject(
      "delete from ai_owner_notifications where owner_user_id=$1",[OWNER_A],"42501");

    const optedOut=await client.query(
      "update ai_owner_notifications set opted_in=false where business_id=$1 and owner_user_id=$2 returning opted_in",
      [CAFE,OWNER_A]);
    assert.equal(optedOut.rows[0].opted_in,false);
    const optedBackIn=await client.query(
      "update ai_owner_notifications set opted_in=true,consent_at=now() where business_id=$1 and owner_user_id=$2 returning opted_in",
      [CAFE,OWNER_A]);
    assert.equal(optedBackIn.rows[0].opted_in,true);

    await mustReject("select * from ai_delivery_attempts",[],"42501");
    await mustReject(
      "insert into ai_delivery_attempts(business_id,owner_user_id,task_id,task_status,business_date) values($1,$2,'task-a','needs_owner',current_date)",
      [CAFE,OWNER_A],"42501");
  });

  await asActor(OWNER_B,async()=>{
    assert.equal((await client.query("select * from ai_owner_notifications")).rowCount,0);
    await client.query(
      "insert into ai_owner_notifications(business_id,owner_user_id,phone_e164,opted_in,consent_at) values($1,$2,$3,true,now())",
      [CAFE,OWNER_B,PHONE_B]);
    assert.equal((await client.query("select * from ai_owner_notifications")).rowCount,1);
  });
  for(const userId of [MANAGER,OUTSIDER]){
    await asActor(userId,async()=>{
      assert.equal((await client.query("select * from ai_owner_notifications")).rowCount,0);
      await mustReject(
        "insert into ai_owner_notifications(business_id,owner_user_id,phone_e164,opted_in,consent_at) values($1,$2,$3,true,now())",
        [CAFE,userId,"+15555550103"],"42501");
    });
  }

  // Service-role equivalent is the database owner in this isolated smoke test.
  await client.query(
    "insert into ai_delivery_attempts(business_id,owner_user_id,task_id,task_status,business_date) values($1,$2,'task-a','needs_owner',current_date)",
    [CAFE,OWNER_A]);
  try{
    await client.query(
      "insert into ai_delivery_attempts(business_id,owner_user_id,task_id,task_status,business_date) values($1,$2,'task-b','needs_owner',current_date)",
      [CAFE,OWNER_A]);
    assert.fail("A second delivery must not be reservable for the same owner/date");
  }catch(err){assert.equal(err.code,"23505");}
  const existing=await client.query(
    "select count(*)::int as n from ai_delivery_attempts where business_id=$1 and owner_user_id=$2",
    [CAFE,OWNER_A]);
  assert.equal(existing.rows[0].n,1);

  console.log("Migration 36 SQL parsing, owner RLS, verified-phone consent and delivery idempotency: PASS");
}finally{await client.end();}
