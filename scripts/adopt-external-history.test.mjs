// Run on disposable migrated Supabase with:
// SUPABASE_DB_URL=postgresql://... node --test scripts/adopt-external-history.test.mjs
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import pg from "pg";
import {adoptExternalHistory} from "./adopt-external-history.mjs";

test("historical attribution preserves original JSON and proves access through Luna's SQL", async () => {
  const url = new URL(process.env.SUPABASE_DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "A disposable local database is required");
  const db = new pg.Client({connectionString: url.toString()});
  const cafe = randomUUID();
  const otherCafe = randomUUID();
  const owner = randomUUID();
  const otherOwner = randomUUID();
  const restaurant = randomUUID();
  const unverified = randomUUID();
  const recentOrder = randomUUID();
  const stockGuid = randomUUID();
  const projectedEntry = randomUUID();
  const selection = randomUUID();
  const unmatchedSelection = randomUUID();
  const ambiguousEntry = randomUUID();
  const blockedOrder = randomUUID();
  const cleanOld = JSON.stringify([{path: ".checks[0].payments[0].amount", before: null, after: 30}]);
  const cleanExact = JSON.stringify([{path: ".option.with.dot", segments: ["option.with.dot"], before_present: true,
    before: null, after_present: false, after: null}]);
  const sensitive = JSON.stringify([{path: ".checks[0].payments[0].card.number", before: "private", after: "new"}]);
  await db.connect();

  async function addRecord({entity = "order", key, captureKey = key, account = restaurant, body, existing = false}) {
    const {rows: [record]} = await db.query(`
      insert into public.external_records (business_id, provider, restaurant_guid, entity, entity_guid, business_date,
        payload, payload_sha256, capture_key, source_account, source_key)
      values ($1, 'toast', $2, $3, $4, current_date, $5::jsonb, encode(sha256(convert_to($5::text, 'UTF8')), 'hex'),
        $6, case when $7 then $2::uuid::text end, case when $7 then $4::uuid::text end) returning id`,
    [cafe, account, entity, key, body, captureKey, existing]);
    return record.id;
  }

  async function addChange({entity = "order", key, recordId, body, account = restaurant, daysAgo = 0}) {
    await db.query(`
      insert into public.external_record_changes (business_id, provider, restaurant_guid, entity, entity_guid,
        business_date, record_id, changes)
      values ($1, 'toast', $2, $3, $4, current_date - $7::integer, $5, $6::jsonb)`,
    [cafe, account, entity, key, recordId, body, daysAgo]);
  }

  const fingerprint = async () => (await db.query(`
    select array_agg(payload::text order by id) as records,
      (select array_agg(changes::text order by id) from public.external_record_changes where business_id = $1) as deltas
    from public.external_records where business_id = $1`, [cafe])).rows[0];

  try {
    await db.query("insert into auth.users (id) values ($1), ($2)", [owner, otherOwner]);
    await db.query("insert into public.businesses (id, name) values ($1, 'History fixture'), ($2, 'Foreign fixture')", [cafe, otherCafe]);
    await db.query("insert into public.memberships (business_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')",
      [cafe, owner, otherCafe, otherOwner]);
    const {rows: [location]} = await db.query("insert into public.locations (business_id, name) values ($1, 'Test location') returning id", [cafe]);
    await db.query(`insert into public.toast_api_credentials (business_id, api_origin, client_id, client_secret_enc)
      values ($1, 'https://example.invalid', 'fixture', 'fixture')`, [cafe]);
    await db.query(`insert into public.toast_location_mappings (business_id, location_id, restaurant_guid, verified_at)
      values ($1, $2, $3, now())`, [cafe, location.id, restaurant]);

    await addRecord({key: recentOrder, body: `{"guid":"${recentOrder}","amount":0.123456789012345678901,"optional":null}`});
    await addRecord({key: blockedOrder, body: JSON.stringify({guid: blockedOrder, accessToken: "fake-token"})});
    await addRecord({key: blockedOrder, account: unverified, captureKey: randomUUID(), body: JSON.stringify({guid: blockedOrder})});
    await addRecord({entity: "time_entry", key: projectedEntry, captureKey: "stage:toast_labor_entries:" + projectedEntry,
      body: '{"clock_in":null,"legacy_rate":0}'});
    for (const type of ["baseline", "revision"]) {
      await addRecord({entity: "employee", key: ambiguousEntry, captureKey: "stage:" + type + ":" + ambiguousEntry,
        body: '{"retained":true}'});
    }
    const otherRecord = await addRecord({key: randomUUID(), account: unverified, body: "{}", existing: true});
    const voidOrder = randomUUID();
    await addRecord({key: voidOrder, existing: true,
      body: JSON.stringify({guid: voidOrder, checks: [{selections: [{guid: selection}]}]})});
    for (const key of [selection, unmatchedSelection]) {
      await addRecord({entity: "void", key, account: null, captureKey: "stage:toast_void_facts:key:" + key,
        body: JSON.stringify({order_guid: voidOrder, selection_guid: key, location_id: location.id})});
    }

    await addRecord({entity: "stock/v1/inventory", key: stockGuid, existing: true, body: '{"quantity":0}'});
    await addChange({entity: "stock/v1/inventory", key: stockGuid, body: cleanOld, daysAgo: 1});
    await addChange({key: recentOrder, body: cleanOld});
    await addChange({key: recentOrder, body: cleanExact});
    await addChange({key: recentOrder, body: sensitive});
    await addChange({key: recentOrder, body: JSON.stringify([
      {path: ".checks[0].payment.method.account.number", before: "private", after: "revised"},
    ])});
    await addChange({key: recentOrder, recordId: otherRecord, body: cleanOld});
    await addChange({entity: "employee", key: ambiguousEntry, body: cleanOld});
    await addChange({entity: "time_entry", key: projectedEntry, body: cleanOld});
    await addChange({key: blockedOrder, account: unverified, body: cleanOld});
    const before = await fingerprint();

    const forecast = await adoptExternalHistory(db, {batchSize: 2});
    assert.equal(forecast.records.eligible, 5);
    assert.equal(forecast.records.retention, 1);
    assert.equal(forecast.records.unverified, 2);
    assert.equal(forecast.changes.eligible, 4);
    assert.equal(forecast.changes.unresolved, 2);
    assert.equal(forecast.changes.retention, 2);
    assert.equal(forecast.changes.unverified, 1);
    assert.deepEqual(await fingerprint(), before);

    const actual = await adoptExternalHistory(db, {apply: true, batchSize: 2});
    assert.equal(actual.records.adopted, 5);
    assert.equal(actual.changes.adopted, 4);
    assert.deepEqual(await fingerprint(), before);
    const {rows: voids} = await db.query(`select entity_guid, restaurant_guid, source_account, payload_origin
      from public.external_records where business_id = $1 and entity = 'void' and source_account is not null`, [cafe]);
    assert.deepEqual(voids, [{entity_guid: selection, restaurant_guid: null, source_account: restaurant,
      payload_origin: "historical_projection"}]);
    const retry = await adoptExternalHistory(db, {apply: true, batchSize: 2});
    assert.equal(retry.records.adopted, 0);
    assert.equal(retry.changes.adopted, 0);

    const sql = `select r.payload_origin, c.delta_origin, count(*)::int as n
      from external_records r join external_record_changes c on
        (r.business_id, r.provider, r.id) = (c.business_id, c.provider, c.record_id)
      where c.source_account = r.source_account and c.source_key = r.source_key
      group by 1, 2 order by 1, 2`;
    const forOwner = async (business, user) =>
      (await db.query("select public.supervisor_research_sql($1, $2, $3) as result", [business, user, sql])).rows[0].result;
    assert.deepEqual((await forOwner(cafe, owner)).rows, [
      {payload_origin: "historical_projection", delta_origin: "historical_projection", n: 1},
      {payload_origin: "historical_provider", delta_origin: "historical_provider", n: 2},
      {payload_origin: "provider", delta_origin: "historical_provider", n: 1},
    ]);
    const foreign = await forOwner(otherCafe, otherOwner);
    assert.equal(foreign.ok, true);
    assert.deepEqual(foreign.rows, []);
  } finally {
    await db.query("delete from public.businesses where id in ($1, $2)", [cafe, otherCafe]);
    await db.query("delete from auth.users where id in ($1, $2)", [owner, otherOwner]);
    await db.end();
  }
});
