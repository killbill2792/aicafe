// Runs the test-café copy job against a disposable database that has every migration applied
// (CI: the local Supabase in toast-db-integration.yml). Never point it at production: it creates
// both cafés' rows and deletes them at the end.
// Usage: SYNC_TEST_DB_URL=postgres://... node scripts/sync-cafe-data-db-integration.mjs
process.env.SYNC_CAFE_DATA_SKIP_MAIN = "1";
const pg = (await import("pg")).default;
const sync = await import("./sync-cafe-data.mjs");
const { SOURCE_BUSINESS_ID: S, DEST_BUSINESS_ID: D, remapId, syncAll, wrapClientForSafety } = sync;

const url = process.env.SYNC_TEST_DB_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
if (/supabase\.co|pooler\.supabase/i.test(url)) throw new Error("refusing to run against a hosted database");
const raw = new pg.Client({ connectionString: url });
const client = wrapClientForSafety(new pg.Client({ connectionString: url }));
await raw.connect();
await client.connect();
const q = (sql, params = []) => raw.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params)).rows[0];
let failures = 0;
const check = (ok, message) => { console.log(`${ok ? "ok" : "FAIL"}: ${message}`); if (!ok) failures++; };
const run = async () => { const counts = {}; await syncAll(client, counts); return counts; };
const replacedDays = (counts) => Object.fromEntries(Object.entries(counts).filter(([k, v]) => k.endsWith("_days") && v));

const G = "c0ffee00-0000-4000-8000-000000000001";
const ids = { loc: "c0ffee00-0000-4000-8000-0000000000a1", emp: "c0ffee00-0000-4000-8000-0000000000b1",
  m1: "c0ffee00-0000-4000-8000-0000000000c1", m2: "c0ffee00-0000-4000-8000-0000000000c2",
  order: "c0ffee00-0000-4000-8000-0000000000d1", line: "c0ffee00-0000-4000-8000-0000000000e1",
  card: "c0ffee00-0000-4000-8000-0000000000f1", entry: "c0ffee00-0000-4000-8000-000000000101" };
const day = "2026-10-20";

async function cleanup() {
  await q("delete from businesses where id = any($1::uuid[])", [[S, D]]);
}

try {
  await cleanup();
  await q("insert into businesses(id, name, timezone) values ($1, 'Source café', 'UTC'), ($2, 'Test café', 'UTC')", [S, D]);
  await q("insert into locations(id, business_id, name) values ($1, $2, 'Main')", [ids.loc, S]);
  await q("insert into toast_api_credentials(business_id, api_origin, client_id, client_secret_enc) values ($1, 'x', 'x', 'x')", [S]);
  await q("insert into toast_location_mappings(business_id, location_id, restaurant_guid) values ($1, $2, $3)", [S, ids.loc, G]);
  await q("insert into employees(id, business_id, display_name) values ($1, $2, 'Sam')", [ids.emp, S]);
  await q("insert into menu_items(id, business_id, name, base_name) values ($1, $3, 'Latte', 'Latte'), ($2, $3, 'Mocha', 'Mocha')", [ids.m1, ids.m2, S]);
  await q(`insert into orders(id, business_id, location_id, pos_order_id, net_sales_cents, gross_sales_cents, business_date, closed_at)
    values ($1, $2, $3, 'toast:o1', 500, 500, $4, $4::date + interval '10 hours')`, [ids.order, S, ids.loc, day]);
  await q("insert into order_lines(id, order_id, menu_item_id, name, quantity, net_sales_cents) values ($1, $2, $3, 'Latte', 1, 500)", [ids.line, ids.order, ids.m1]);
  // A finished Toast shift: its timecard and its labor summary describe the same time entry.
  await q(`insert into timecards(id, business_id, employee_id, clock_in, clock_out, pos_timecard_id, hourly_wage_cents, source_type)
    values ($1, $2, $3, $4::date + interval '8 hours', $4::date + interval '12 hours', $5, 2000, 'connected_pos')`,
    [ids.card, S, ids.emp, day, `toast:${G}:${ids.entry}`]);
  await q(`insert into toast_open_labor_summaries(business_id, restaurant_guid, external_time_entry_id, external_employee_id, clock_in, clock_out, status, wage_status)
    values ($1, $2, $3, $4, $5::date + interval '8 hours', $5::date + interval '12 hours', 'actual', 'actual')`, [S, G, ids.entry, ids.emp, day]);

  await run();
  const labor = async (b) => (await one("select count(*)::int n from cv_labor_entries where business_id = $1", [b])).n;
  check(await labor(D) === await labor(S), `a finished shift appears as often in the test café as in the real café (${await labor(D)} vs ${await labor(S)})`);
  check((await one("select menu_item_id from order_lines l join orders o on o.id = l.order_id where o.business_id = $1", [D])).menu_item_id === remapId("menu_items", ids.m1),
    "the copied order line points at the copied menu item");

  const second = await run();
  check(Object.keys(replacedDays(second)).length === 0, `an unchanged second run replaces nothing ${JSON.stringify(replacedDays(second))}`);

  await q("update order_lines set menu_item_id = $1 where id = $2", [ids.m2, ids.line]);
  const third = await run();
  check((await one("select menu_item_id from order_lines l join orders o on o.id = l.order_id where o.business_id = $1", [D])).menu_item_id === remapId("menu_items", ids.m2),
    "an order line moved to another menu item is copied again");
  check(third.orders_days === 1 && third.timecards_days === undefined, `only that order day is replaced ${JSON.stringify(replacedDays(third))}`);
} finally {
  await cleanup();
  await client.end();
  await raw.end();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("sync-cafe-data database checks passed");
