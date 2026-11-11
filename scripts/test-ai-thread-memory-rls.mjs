/**
 * Disposable PostgreSQL 16 RLS and CAS tests for Task 9 thread memory.
 * This script creates only an ephemeral local schema and must never target Supabase.
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
const THREAD_A = "33333333-3333-4333-8333-333333333333";
const THREAD_A_OTHER = "55555555-5555-4555-8555-555555555555";
const THREAD_B = "66666666-6666-4666-8666-666666666666";
const THREAD_CAFE_B = "77777777-7777-4777-8777-777777777777";
const MESSAGE_A = "44444444-4444-4444-8444-444444444444";
const MESSAGE_A_2 = "88888888-8888-4888-8888-888888888888";
const MESSAGE_A_3 = "99999999-9999-4999-8999-999999999999";
const MESSAGE_OTHER_THREAD = "aaaaaaaa-0000-4000-8000-000000000001";
const MESSAGE_CAFE_B = "cccccccc-0000-4000-8000-000000000001";
const MESSAGE_A_4 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MESSAGE_A_5 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MESSAGE_FINANCIAL = "00000000-0000-4000-8000-000000000001";
const AT_1 = "2026-11-11T12:00:00.000Z";
const AT_2 = "2026-11-11T12:01:00.000Z";
const AT_3 = "2026-11-11T12:02:00.000Z";
const AT_4 = "2026-11-11T12:03:00.000Z";
const AT_5 = "2026-11-11T12:04:00.000Z";
const AT_6 = "2026-11-11T12:05:00.000Z";

const conversationMigration = readFileSync(
  new URL("../supabase/migrations/20261010000033_ai_conversations.sql", import.meta.url), "utf8",
);
const memoryMigration = readFileSync(
  new URL("../supabase/migrations/20261111000203_ai_thread_memory.sql", import.meta.url), "utf8",
);

async function asActor(actor, fn, db = client) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [actor]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function rejectQuery(db, sql, params = [], code) {
  await db.query("SAVEPOINT expected_reject");
  let rejected = false;
  try {
    await db.query(sql, params);
  } catch (error) {
    rejected = true;
    if (code) assert.equal(error.code, code);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT expected_reject");
    await db.query("RELEASE SAVEPOINT expected_reject");
  }
  assert.ok(rejected, "Expected RLS, permission, or validation rejection");
}

function memoryDoc({ revision, cursor, entries = [], tombstones = [], retry = null }) {
  return { version: 1, revision, cursor, entries, tombstones, retry };
}

function entry(sourceId, sourceAt, text = "We prefer oat milk for staff drinks.", revision = 1) {
  return {
    kind: "preference", key: "preference:staff_drinks", text,
    sourceMessageId: sourceId, sourceAt, revision,
  };
}

function tombstone(sourceId, sourceAt, revision) {
  return { key: "preference:staff_drinks", sourceMessageId: sourceId, sourceAt, revision };
}

async function save(db, {
  business = CAFE_A, owner = OWNER_A, thread = THREAD_A,
  expected = 0, document,
}) {
  const result = await db.query(
    "select public.save_ai_thread_memory($1,$2,$3,$4,$5::jsonb) as result",
    [business, owner, thread, expected, JSON.stringify(document)],
  );
  return result.rows[0].result;
}

async function insertOwnerMessage(db, {
  id, business = CAFE_A, thread = THREAD_A, owner = OWNER_A, at, text,
}) {
  await db.query(
    "insert into ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id,created_at) values($1,$2,$3,$4,$4,'owner','text',$5,$6,$7::timestamptz)",
    [id, business, thread, owner, text, crypto.randomUUID(), at],
  );
}

async function main() {
  await client.connect();
  await client.query(`
    create extension if not exists pgcrypto;
    create schema if not exists auth;
    create role anon nologin;
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

  for (const userId of [OWNER_A, OWNER_B, MANAGER, OUTSIDER]) {
    await client.query("insert into auth.users(id) values($1)", [userId]);
  }
  for (const cafe of [CAFE_A, CAFE_B]) {
    await client.query("insert into businesses(id) values($1)", [cafe]);
  }
  for (const [businessId, userId, role] of [
    [CAFE_A, OWNER_A, "owner"], [CAFE_A, OWNER_B, "owner"],
    [CAFE_A, MANAGER, "manager"], [CAFE_B, OWNER_A, "owner"],
  ]) {
    await client.query("insert into memberships(business_id,user_id,role) values($1,$2,$3)", [
      businessId, userId, role,
    ]);
  }

  await client.query(conversationMigration);
  await client.query(memoryMigration);

  await asActor(OWNER_A, async db => {
    for (const [id, business, owner] of [
      [THREAD_A, CAFE_A, OWNER_A], [THREAD_A_OTHER, CAFE_A, OWNER_A],
      [THREAD_CAFE_B, CAFE_B, OWNER_A],
    ]) {
      await db.query(
        "insert into ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
        [id, business, owner, crypto.randomUUID()],
      );
    }
    await insertOwnerMessage(db, {
      id: MESSAGE_A, at: AT_1, text: "We prefer oat milk for staff drinks.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_A_2, at: AT_2, text: "Forget that I prefer oat milk for staff drinks.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_A_3, at: AT_3, text: "We prefer soy milk for staff drinks.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_A_4, at: AT_4, text: "We prefer quiet music during prep.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_A_5, at: AT_5, text: "We prefer paper cups for takeaway.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_FINANCIAL, at: AT_6,
      text: "We prefer oat milk at $5.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_OTHER_THREAD, thread: THREAD_A_OTHER, at: AT_5,
      text: "We prefer quiet morning music.",
    });
    await insertOwnerMessage(db, {
      id: MESSAGE_CAFE_B, business: CAFE_B, thread: THREAD_CAFE_B, at: AT_5,
      text: "We prefer quiet morning music.",
    });
    const visible = await db.query(
      "select id,memory_summary from ai_threads where id=$1", [THREAD_A],
    );
    assert.equal(visible.rowCount, 1);
    assert.deepEqual(visible.rows[0].memory_summary, {
      version: 1, revision: 0, cursor: null, entries: [], tombstones: [], retry: null,
    });

    const saved = await save(db, {
      expected: 0,
      document: memoryDoc({
        revision: 1, cursor: { createdAt: AT_1, id: MESSAGE_A },
        entries: [entry(MESSAGE_A, AT_1)],
      }),
    });
    assert.deepEqual(saved, { ok: true, revision: 1 });

    // The owner can retry at the same cursor without being rejected as a rewind.
    const retrySaved = await save(db, {
      expected: 1,
      document: memoryDoc({
        revision: 2, cursor: { createdAt: AT_1, id: MESSAGE_A },
        entries: [entry(MESSAGE_A, AT_1)], retry: { code: "provider_error", at: AT_2 },
      }),
    });
    assert.deepEqual(retrySaved, { ok: true, revision: 2 });

    // Forget is source-attributed to a later owner message; the old source cannot reappear.
    const forgotten = await save(db, {
      expected: 2,
      document: memoryDoc({
        revision: 3, cursor: { createdAt: AT_2, id: MESSAGE_A_2 },
        tombstones: [tombstone(MESSAGE_A_2, AT_2, 3)],
      }),
    });
    assert.deepEqual(forgotten, { ok: true, revision: 3 });

    // A later explicit restatement is allowed to supersede the tombstone.
    const restated = await save(db, {
      expected: 3,
      document: memoryDoc({
        revision: 4, cursor: { createdAt: AT_3, id: MESSAGE_A_3 },
        entries: [entry(MESSAGE_A_3, AT_3, "We prefer soy milk for staff drinks.", 4)],
      }),
    });
    assert.deepEqual(restated, { ok: true, revision: 4 });

    // Stale writers receive a structured CAS conflict, not a lost update.
    const stale = await save(db, {
      expected: 3,
      document: memoryDoc({
        revision: 4, cursor: { createdAt: AT_3, id: MESSAGE_A_3 },
        entries: [entry(MESSAGE_A_3, AT_3, "We prefer soy milk for staff drinks.", 4)],
      }),
    });
    assert.equal(stale.reason, "stale_revision");

    // A quote that is not present in the source owner message is rejected.
    const forged = await save(db, {
      expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 },
        entries: [entry(MESSAGE_A_3, AT_3, "We prefer almond milk for staff drinks.", 5)],
      }),
    });
    assert.equal(forged.reason, "invalid_summary");

    // A source from another thread or café cannot be attributed to this thread.
    const crossThread = await save(db, {
      expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_5, id: MESSAGE_A_5 },
        entries: [entry(MESSAGE_OTHER_THREAD, AT_5, "We prefer quiet morning music.", 5)],
      }),
    });
    assert.equal(crossThread.reason, "invalid_summary");
    const crossCafe = await save(db, {
      business: CAFE_A, expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_5, id: MESSAGE_A_5 },
        entries: [entry(MESSAGE_CAFE_B, AT_5, "We prefer quiet morning music.", 5)],
      }),
    });
    assert.equal(crossCafe.reason, "invalid_summary");

    // Financial figures and extra JSON properties are rejected in the database too.
    const money = await save(db, {
      expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_6, id: MESSAGE_FINANCIAL },
        entries: [entry(MESSAGE_FINANCIAL, AT_6, "We prefer oat milk at $5.", 5)],
      }),
    });
    assert.equal(money.reason, "invalid_summary");
    const extra = await save(db, {
      expected: 4,
      document: { ...memoryDoc({ revision: 5, cursor: { createdAt: AT_5, id: MESSAGE_A_5 } }), untrusted: true },
    });
    assert.equal(extra.reason, "invalid_summary");

    // Authenticated PostgREST cannot update the append-only thread row directly.
    await rejectQuery(db, "update ai_threads set memory_summary='{}'::jsonb where id=$1", [THREAD_A], "42501");
    // A member cannot call the CAS for another owner's private thread.
    const otherOwner = await save(db, {
      owner: OWNER_B, expected: 4,
      document: memoryDoc({ revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 } }),
    });
    assert.equal(otherOwner.reason, "unauthorized");
    // Mismatched café identity cannot resolve the same thread.
    const wrongCafe = await save(db, {
      business: CAFE_B, expected: 4,
      document: memoryDoc({ revision: 5, cursor: { createdAt: AT_5, id: MESSAGE_A_5 } }),
    });
    assert.equal(wrongCafe.reason, "unauthorized");
  });

  await asActor(OWNER_B, async db => {
    assert.equal((await db.query("select * from ai_threads")).rowCount, 0);
    const denied = await save(db, {
      expected: 4,
      document: memoryDoc({ revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 } }),
    });
    assert.equal(denied.reason, "unauthorized");
    await db.query(
      "insert into ai_threads(id,business_id,owner_user_id,client_request_id) values($1,$2,$3,$4)",
      [THREAD_B, CAFE_A, OWNER_B, crypto.randomUUID()],
    );
    assert.equal((await db.query("select * from ai_threads")).rowCount, 1);
  });

  for (const actor of [MANAGER, OUTSIDER]) {
    await asActor(actor, async db => {
      assert.equal((await db.query("select * from ai_threads")).rowCount, 0);
      const denied = await save(db, {
        expected: 4,
        document: memoryDoc({ revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 } }),
      });
      assert.equal(denied.reason, "unauthorized");
    });
  }

  // Two concurrent authenticated owner writers: the row lock serializes CAS;
  // the second writer must observe the first revision and fail as stale.
  const contender = new Client({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "cafe_rls_test",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
  });
  await contender.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
    const first = await save(client, {
      expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 },
        entries: [entry(MESSAGE_A_3, AT_3, "We prefer soy milk for staff drinks.", 4)],
      }),
    });
    assert.deepEqual(first, { ok: true, revision: 5 });

    const second = (async () => asActor(OWNER_A, db => save(db, {
      expected: 4,
      document: memoryDoc({
        revision: 5, cursor: { createdAt: AT_3, id: MESSAGE_A_3 },
        entries: [entry(MESSAGE_A_3, AT_3, "We prefer soy milk for staff drinks.", 4)],
      }),
    }), contender))();
    await new Promise(resolve => setTimeout(resolve, 100));
    await client.query("COMMIT");
    const secondResult = await second;
    assert.equal(secondResult.reason, "stale_revision");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await contender.end();
  }

  // Revoked owner membership is checked inside the SECURITY DEFINER RPC.
  await client.query("delete from memberships where business_id=$1 and user_id=$2", [CAFE_A, OWNER_A]);
  await asActor(OWNER_A, async db => {
    assert.equal((await db.query("select * from ai_threads where business_id=$1", [CAFE_A])).rowCount, 0);
    const denied = await save(db, {
      expected: 5,
      document: memoryDoc({ revision: 6, cursor: { createdAt: AT_5, id: MESSAGE_A_5 } }),
    });
    assert.equal(denied.reason, "unauthorized");
  });

  console.log("Task 9 thread-memory PostgreSQL 16 RLS, provenance, CAS and concurrency tests passed");
}

try {
  await main();
} finally {
  await client.end();
}
