/**
 * Upgrade-only acceptance for Task 9. Runs against local Supabase on 127.0.0.1:54322.
 * The workflow deliberately starts with Task 9's migration removed from its
 * disposable checkout, seeds synthetic existing conversations, and runs the
 * preserved migration only AFTER recording baseline behavior and data.
 * Never use a hosted Supabase URL or real owner/café data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const connection = {
  host: "127.0.0.1", port: 54322, database: "postgres",
  user: "postgres", password: "postgres",
};
const migrationPath = process.env.TASK9_UPGRADE_SQL;
assert.ok(migrationPath?.endsWith("20261111000207_ai_thread_memory.sql"),
  "TASK9_UPGRADE_SQL must point to the preserved Task 9 migration");
assert.ok(process.env.GITHUB_ACTIONS === "true",
  "This test may run only in a disposable GitHub Actions environment");

const db = new Client(connection);
async function scalar(sql, args = []) {
  const result = await db.query(sql, args);
  return result.rows[0];
}
async function asActor(userId, task) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await task();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
async function asServiceWriter(task) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE service_role");
    const result = await task();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
async function fingerprint(table, exclude) {
  const sql = table === "ai_threads"
    ? "select count(*)::int as n, md5(string_agg((to_jsonb(t) - 'memory_summary')::text, '|' order by t.id)) as hash from public.ai_threads t"
    : "select count(*)::int as n, md5(string_agg(to_jsonb(t)::text, '|' order by t.id)) as hash from public.ai_messages t";
  const record = await scalar(sql);
  assert.ok(record.hash);
  return record;
}
async function schemaFingerprint() {
  const x = await db.query("select tablename,policyname,cmd,roles::text,qual,with_check from pg_policies where schemaname='public' and tablename in ('ai_threads','ai_messages') order by tablename,policyname");
  const y = await db.query("select tgrelid::regclass::text as tablename,tgname,tgenabled,pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid in ('public.ai_threads'::regclass,'public.ai_messages'::regclass) and not tgisinternal order by tablename,tgname");
  const z = await db.query("select conrelid::regclass::text as tablename,conname,contype,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('public.ai_threads'::regclass,'public.ai_messages'::regclass) and conname <> 'ai_threads_memory_summary_shape' order by tablename,conname");
  const w = await db.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='ai_messages' order by ordinal_position");
  return { policies:x.rows, triggers:y.rows, oldConstraints:z.rows, messageColumns:w.rows };
}

async function main() {
  await db.connect();
  const serverVersion = (await scalar("show server_version")).server_version;
  assert.equal((await scalar("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='ai_threads' and column_name='memory_summary'")).n, 0, "Memory column must be absent before the upgrade");
  assert.equal((await scalar("select to_regprocedure('public.save_ai_thread_memory(uuid,uuid,uuid,bigint,jsonb)') is not null as present")).present, false);

  const owners = [randomUUID(), randomUUID()];
  const cafes = [randomUUID(), randomUUID()];
  for (let i = 0; i < owners.length; i++) {
    await db.query("insert into auth.users (id,email,aud,role) values($1,$2,'authenticated','authenticated')",
      [owners[i], "task9-upgrade-" + randomUUID() + "@example.invalid"]);
  }
  for (const [i, id] of cafes.entries()) {
    await db.query("insert into public.businesses(id,name,is_demo) values($1,$2,true)",
      [id,"Task9 synthetic upgrade café " + i]);
  }
  for (const [cafe,user] of [[cafes[0],owners[0]],[cafes[0],owners[1]],[cafes[1],owners[0]]]) {
    await db.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner')",[cafe,user]);
  }
  const threads = [];
  for (let i=0;i<64;i++) {
    const index = i % 3;
    const cafe = index===2 ? cafes[1] : cafes[0];
    const owner = index===1 ? owners[1] : owners[0];
    const id = randomUUID();
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id,title) values($1,$2,$3,$4,$5)",
      [id,cafe,owner,randomUUID(),"Existing thread " + i]);
    threads.push({id,cafe,owner});
  }
  let firstOwnerMessage=null;
  for (let i=0;i<529;i++) {
    const t=threads[i%threads.length];
    const id=randomUUID();
    if(i%5===4) {
      await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values($1,$2,$3,$4,'supervisor','blocks',$5::jsonb,$6::jsonb)",
        [id,t.cafe,t.id,t.owner,JSON.stringify([{type:"text",text:"Existing Supervisor response"}]),JSON.stringify({status:"verified"})]);
    } else {
      await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$4,'owner','text',$5,$6)",
        [id,t.cafe,t.id,t.owner,"We prefer oat milk at the coffee bar.",randomUUID()]);
      if(i===0) firstOwnerMessage={id,thread:t};
    }
  }
  assert.ok(firstOwnerMessage);
  const beforeThreads=await fingerprint("ai_threads");
  const beforeMessages=await fingerprint("ai_messages");
  assert.equal(beforeThreads.n,64);
  assert.equal(beforeMessages.n,529);
  const beforeSchema=await schemaFingerprint();
  const beforeOwnerMessageInsert=(await scalar("select has_table_privilege('authenticated','public.ai_messages','INSERT') as allowed")).allowed;
  const beforeServerMessageInsert=(await scalar("select has_table_privilege('service_role','public.ai_messages','INSERT') as allowed")).allowed;
  assert.equal(beforeServerMessageInsert,true,"Existing authorized server writer lacks INSERT");
  const beforeOwnerRead=await asActor(owners[0],async()=>(await db.query("select id from public.ai_threads where id=$1",[threads[0].id])).rowCount);
  const beforeOtherOwnerRead=await asActor(owners[1],async()=>(await db.query("select id from public.ai_threads where id=$1",[threads[0].id])).rowCount);
  assert.equal(beforeOwnerRead,1);
  assert.equal(beforeOtherOwnerRead,0);
  const migrationSQL=readFileSync(migrationPath,"utf8");

  // A simultaneous long-running reader must cause bounded DDL failure,
  // without partially installing the column or changing existing rows.
  const held = new Client(connection);
  const blocked = new Client(connection);
  await held.connect();
  await blocked.connect();
  await held.query("BEGIN");
  await held.query("select id from public.ai_threads limit 1");
  let lockFailure=null;
  const lockStart=Date.now();
  try {
    await blocked.query(migrationSQL);
  } catch (error) {
    lockFailure=error;
  } finally {
    await held.query("ROLLBACK");
    await held.end();
    await blocked.end();
  }
  assert.ok(lockFailure,"Concurrent reader should block the DDL until timeout");
  assert.equal(lockFailure.code,"55P03","DDL lock timeout is the required fail-safe");
  const lockDurationMs=Date.now()-lockStart;
  assert.ok(lockDurationMs < 11000,"DDL lock wait exceeded the approved 5 second budget by too much");
  assert.equal((await scalar("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='ai_threads' and column_name='memory_summary'")).n,0,"Timed-out migration left a partial column");

  // Apply the real unmodified Task 9 migration against populated schema.
  const start=Date.now();
  await db.query(migrationSQL);
  const migrationMs=Date.now()-start;
  assert.equal((await scalar("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='ai_threads' and column_name='memory_summary'")).n,1);
  assert.deepEqual(await fingerprint("ai_threads"),beforeThreads,"Existing thread columns changed during upgrade");
  assert.deepEqual(await fingerprint("ai_messages"),beforeMessages,"Existing messages changed during upgrade");
  assert.deepEqual(await schemaFingerprint(),beforeSchema,"Existing policies/triggers/constraints/message columns changed");
  assert.equal((await scalar("select has_table_privilege('authenticated','public.ai_messages','INSERT') as allowed")).allowed,beforeOwnerMessageInsert,
    "Old authenticated-message INSERT privilege unexpectedly changed");
  assert.equal((await scalar("select has_table_privilege('service_role','public.ai_messages','INSERT') as allowed")).allowed,beforeServerMessageInsert,
    "Old server-message INSERT privilege unexpectedly changed");
  const expectedDefault={
    version:1,revision:0,cursor:null,entries:[],tombstones:[],retry:null,
  };
  assert.equal((await scalar("select count(*)::int as n from public.ai_threads where memory_summary = $1::jsonb",[JSON.stringify(expectedDefault)])).n,64,
    "Preexisting threads were not all initialized with safe empty memory");
  assert.equal((await scalar("select convalidated as validated from pg_constraint where conrelid='public.ai_threads'::regclass and conname='ai_threads_memory_summary_shape'")).validated,false,
    "Migration must leave the expensive validation explicitly deferred");

  assert.equal(await asActor(owners[0],async()=>(await db.query("select id from public.ai_threads where id=$1",[threads[0].id])).rowCount),beforeOwnerRead);
  assert.equal(await asActor(owners[1],async()=>(await db.query("select id from public.ai_threads where id=$1",[threads[0].id])).rowCount),beforeOtherOwnerRead);
  // Preserve the PREEXISTING privilege model: authenticated can create/read
  // threads, but direct authenticated ai_messages INSERT is not granted here.
  // The authorized server/service-role writer still appends owner messages.
  const freshThread=randomUUID();
  const freshMessage=randomUUID();
  await asActor(owners[0],async()=>{
    await db.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
      [freshThread,cafes[0],owners[0],randomUUID()]);
    const row=await scalar("select memory_summary from public.ai_threads where id=$1",[freshThread]);
    assert.deepEqual(row.memory_summary,expectedDefault,"New threads do not have compatible memory default");
  });
  await asServiceWriter(async()=>{
    await db.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values($1,$2,$3,$4,$4,'owner','text','Authorized server message write after upgrade',$5)",
      [freshMessage,cafes[0],freshThread,owners[0],randomUUID()]);
  });
  await asActor(owners[0],async()=>{
    const row=await scalar("select memory_summary,last_message_at from public.ai_threads where id=$1",[freshThread]);
    assert.deepEqual(row.memory_summary,expectedDefault,"Appending a message changed new memory default");
    assert.ok(row.last_message_at,"Existing message-trigger behavior is broken");
    assert.equal((await db.query("select id from public.ai_messages where id=$1",[freshMessage])).rowCount,1);
  });
  const source=await scalar("select id,to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as created_at_iso from public.ai_messages where id=$1",[firstOwnerMessage.id]);
  const at=source.created_at_iso;
  const updated={
    ...expectedDefault, revision:1,cursor:{createdAt:at,id:source.id},
    entries:[{kind:"preference",key:"preference:milk_choice",text:"We prefer oat milk",
      sourceMessageId:source.id,sourceAt:at,revision:1}],
  };
  const saved=await asActor(owners[0],async()=>{
    const row=await scalar("select public.save_ai_thread_memory($1,$2,$3,0,$4::jsonb) as result",
      [cafes[0],owners[0],threads[0].id,JSON.stringify(updated)]);
    return row.result;
  });
  assert.deepEqual(saved,{ok:true,revision:1},"Existing populated thread cannot save new memory");
  const forbidden=await asActor(owners[1],async()=>{
    const row=await scalar("select public.save_ai_thread_memory($1,$2,$3,1,$4::jsonb) as result",
      [cafes[0],owners[0],threads[0].id,JSON.stringify({...updated,revision:2})]);
    return row.result;
  });
  assert.deepEqual(forbidden,{ok:false,reason:"unauthorized"},"Cross-owner memory write was allowed");
  // Validate representative old rows in rollback-only transaction to prove
  // the deferred CHECK is logically satisfiable without committing a live DDL.
  await db.query("BEGIN");
  try{
    await db.query("alter table public.ai_threads validate constraint ai_threads_memory_summary_shape");
    assert.equal((await scalar("select convalidated as v from pg_constraint where conrelid='public.ai_threads'::regclass and conname='ai_threads_memory_summary_shape'")).v,true);
  } finally {
    await db.query("ROLLBACK");
  }
  console.log(JSON.stringify({
    check:"Task9 occupied-database upgrade",result:"PASS",postgres_version:serverVersion,
    preexisting_threads:64,preexisting_messages:529,
    old_columns_and_rows:"unchanged",old_RLS_and_triggers:"unchanged",
    authenticated_thread_create:"pass",authorized_server_message_insert:"pass",
    authenticated_direct_message_insert_granted_before_and_after:beforeOwnerMessageInsert,
    memory_on_existing_thread:"pass",
    cross_owner_denial:"pass",deferred_constraint_validation:"pass_in_rollback",
    timeout_error_code:lockFailure.code,lock_wait_ms:lockDurationMs,
    successful_migration_ms:migrationMs,
    production_data_used:false,production_database_changed:false,
  }));
}
try {
  await main();
} finally {
  await db.end().catch(()=>{});
}
