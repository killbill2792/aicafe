/**
 * Isolated PostgreSQL RLS smoke test for Phase 3.
 * Runs only against the disposable GitHub Actions Postgres service, not Supabase.
 * It loads just the new migration plus minimal auth/tenancy scaffolding.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const client = new Client({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "cafe_rls_test",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
});

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CAFE_A = "11111111-1111-4111-8111-111111111111";
const CAFE_B = "22222222-2222-4222-8222-222222222222";
const A_THREAD = "33333333-3333-4333-8333-333333333333";
const A_MSG = "44444444-4444-4444-8444-444444444444";
const A_KEY = "55555555-5555-4555-8555-555555555555";
const B_THREAD = "66666666-6666-4666-8666-666666666666";

const migration = readFileSync(new URL("../supabase/migrations/20261010000033_ai_conversations.sql", import.meta.url), "utf8");

async function asActor(userId, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await fn();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function rejectQuery(sql, params, code) {
  await client.query("SAVEPOINT expected_reject");
  let rejected = false;
  try {
    await client.query(sql, params);
  } catch (error) {
    rejected = true;
    if (code) assert.equal(error.code, code);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_reject");
    await client.query("RELEASE SAVEPOINT expected_reject");
  }
  assert.ok(rejected, "Expected SQL permission/RLS/constraint rejection");
}

async function main() {
  await client.connect();
  await client.query(`
    create extension if not exists pgcrypto;
    create schema if not exists auth;
    create role authenticated nologin;
    create table auth.users (id uuid primary key);
    create table businesses (id uuid primary key);
    create table memberships (
      business_id uuid not null references businesses(id),
      user_id uuid not null references auth.users(id),
      role text not null,
      primary key (business_id,user_id)
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public,auth to authenticated;
    grant select on memberships to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  for (const userId of [OWNER_A,OWNER_B,MANAGER,OUTSIDER]) {
    await client.query("insert into auth.users (id) values ($1)", [userId]);
  }
  for (const cafe of [CAFE_A,CAFE_B]) {
    await client.query("insert into businesses (id) values ($1)", [cafe]);
  }
  for (const [businessId,userId,role] of [
    [CAFE_A,OWNER_A,"owner"],[CAFE_A,OWNER_B,"owner"],
    [CAFE_A,MANAGER,"manager"],[CAFE_B,OWNER_A,"owner"],
  ]) {
    await client.query("insert into memberships (business_id,user_id,role) values ($1,$2,$3)",[businessId,userId,role]);
  }
  await client.query(migration);

  // One owner can append real messages and the trigger advances the thread.
  await asActor(OWNER_A, async () => {
    const inserted = await client.query(
      "insert into ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4) returning id",
      [A_THREAD,CAFE_A,OWNER_A,A_KEY],
    );
    assert.equal(inserted.rows[0].id, A_THREAD);
    const msg = await client.query(
      "insert into ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,$5,'owner','text','What were our costs?',$6) returning id",
      [A_MSG,CAFE_A,A_THREAD,OWNER_A,OWNER_A,crypto.randomUUID()],
    );
    assert.equal(msg.rows[0].id, A_MSG);
    const touched = await client.query("select last_message_at from ai_threads where id=$1",[A_THREAD]);
    assert.ok(touched.rows[0].last_message_at);

    // Owner-authenticated PostgREST users CANNOT spoof a Supervisor reply.
    await rejectQuery(
      "insert into ai_messages(business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding) values ($1,$2,$3,'supervisor','blocks','[{\"type\":\"text\",\"text\":\"fake\"}]'::jsonb,'{\"status\":\"verified\"}'::jsonb)",
      [CAFE_A,A_THREAD,OWNER_A],"42501",
    );
    // Nor forge a different author's identity.
    await rejectQuery(
      "insert into ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,'owner','text','spoof',$5)",
      [CAFE_A,A_THREAD,OWNER_B,OWNER_B,crypto.randomUUID()],"42501",
    );
    // No modification or deletion of immutable history.
    await rejectQuery("update ai_messages set text_content='edited' where id=$1",[A_MSG],"42501");
    await rejectQuery("delete from ai_messages where id=$1",[A_MSG],"42501");
  });

  // A different OWNER of the same café has their own private conversation.
  await asActor(OWNER_B, async () => {
    assert.equal((await client.query("select * from ai_threads")).rowCount,0);
    assert.equal((await client.query("select * from ai_messages")).rowCount,0);
    await rejectQuery(
      "insert into ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,'owner','text','cross-owner',$5)",
      [CAFE_A,A_THREAD,OWNER_B,OWNER_B,crypto.randomUUID()],
    );
    await client.query(
      "insert into ai_threads (id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
      [B_THREAD,CAFE_A,OWNER_B,crypto.randomUUID()],
    );
    assert.equal((await client.query("select * from ai_threads")).rowCount,1);
  });

  await asActor(OWNER_A, async () => {
    assert.equal((await client.query("select * from ai_threads")).rowCount,1);
    assert.equal((await client.query("select * from ai_messages")).rowCount,1);
    // Even owner membership at café B does not give this owner access to café A's other threads.
    assert.equal((await client.query("select * from ai_threads where id=$1",[B_THREAD])).rowCount,0);
  });

  for (const actor of [MANAGER,OUTSIDER]) {
    await asActor(actor, async () => {
      assert.equal((await client.query("select * from ai_threads")).rowCount,0);
      assert.equal((await client.query("select * from ai_messages")).rowCount,0);
      await rejectQuery(
        "insert into ai_threads(business_id,owner_user_id,client_request_id) values($1,$2,$3)",
        [CAFE_A,actor,crypto.randomUUID()],"42501",
      );
    });
  }

  console.log("Conversation migration PostgreSQL RLS tests passed");
}

try {
  await main();
} finally {
  await client.end();
}
