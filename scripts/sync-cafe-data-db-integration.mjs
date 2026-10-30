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
  // Import runs and day statuses do not cascade from the café; remove them first.
  await q("delete from toast_day_status where business_id = any($1::uuid[])", [[S, D]]);
  await q("delete from toast_sync_runs where business_id = any($1::uuid[])", [[S, D]]);
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

  // Oct 12/14 financial parity fixture. The seventh Oct 14 shift begins on Oct 15
  // UTC but is still Oct 14 at the café (PDT). Two complete shifts have a real
  // canonical Toast wage of zero; null wages would wrongly mark days missing.
  await q("update businesses set timezone = 'America/Los_Angeles' where id = $1", [S]);
  const financialDays = [{ date: "2026-10-12", shifts: 6, wage: 90136, tax: 10203, fee: 5357 },
    { date: "2026-10-14", shifts: 7, wage: 110201, tax: 13222, fee: 5464 }];
  for (const fact of financialDays) {
    for (let i = 0; i < fact.shifts; i++) {
      const entry = sync.uuidv5(`fixture-entry-${fact.date}-${i}`);
      const card = sync.uuidv5(`fixture-card-${fact.date}-${i}`);
      const isLateUtcShift = fact.date === "2026-10-14" && i === 6;
      const clockIn = isLateUtcShift ? "2026-10-15T02:00:00+00:00" : `${fact.date}T18:00:00+00:00`;
      await q(`insert into timecards(id,business_id,employee_id,clock_in,clock_out,
        pos_timecard_id,hourly_wage_cents,source_type)
        values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '1 hour',$5,$6,'connected_pos')`,
      [card,S,ids.emp,clockIn,`toast:${G}:${entry}`,i === fact.shifts - 1 ? 0 : 1500]);
    }
    await q(`insert into daily_rollups(business_id,business_date,net_sales_cents,orders_count,drinks_count,
      ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,voids_cents,
      labor_wage_status,staff_tax_status,card_fees_status)
      values ($1,$2,50000,50,50,2000,$3,$4,$5,0,'actual','actual','actual')`,
      [S,fact.date,fact.wage,fact.tax,fact.fee]);
    await q(`insert into toast_payment_facts(business_id,restaurant_guid,business_date,payment_ref,
      original_processing_fee_cents,processing_fee_cents,fee_status,fee_basis)
      values ($1,$2,$3,$4,$5,$5,'actual','toast')`,
      [S,G,fact.date,`payment-${fact.date}`,fact.fee]);
  }
  const parity = async (b, date) => ({
    shifts: Number((await one(`select count(*)::int n from timecards where business_id=$1
      and (clock_in at time zone (select timezone from businesses where id=$1))::date=$2::date
      and source_type='connected_pos'`,[b,date])).n),
    zero: Number((await one(`select count(*)::int n from timecards where business_id=$1
      and (clock_in at time zone (select timezone from businesses where id=$1))::date=$2::date
      and hourly_wage_cents=0`,[b,date])).n),
    rollup: await one(`select staff_wages_cents::text,staff_tax_cents::text,card_fees_cents::text,
      labor_wage_status,staff_tax_status,card_fees_status from daily_rollups where business_id=$1
      and business_date=$2`,[b,date]),
    payment: await one(`select processing_fee_cents::text,fee_status,fee_basis from toast_payment_facts
      where business_id=$1 and business_date=$2`,[b,date]),
  });

  await run();
  for (const fact of financialDays) {
    const src = await parity(S,fact.date), dst = await parity(D,fact.date);
    check(JSON.stringify(dst) === JSON.stringify(src), `financial parity ${fact.date}: ${JSON.stringify(dst)}`);
    check(dst.shifts === fact.shifts && dst.zero === 1,
      `${fact.date} retains ${fact.shifts} shifts and one real zero-wage shift`);
    check(dst.payment.processing_fee_cents === String(fact.fee) &&
      dst.payment.fee_status === "actual" && dst.rollup.card_fees_status === "actual",
      `${fact.date} preserves Toast's ${fact.fee}-cent actual fee, never an estimate`);
  }
  const srcProviderIds = (await q(`select regexp_replace(pos_timecard_id,'^toast:[^:]+:','') as provider
    from timecards where business_id=$1 and source_type='connected_pos' order by provider`,[S])).rows.map(x=>x.provider);
  const destProviderIds = (await q(`select regexp_replace(pos_timecard_id,'^toast:[^:]+:','') as provider
    from timecards where business_id=$1 and source_type='connected_pos' order by provider`,[D])).rows.map(x=>x.provider);
  check(JSON.stringify(destProviderIds) === JSON.stringify(srcProviderIds),
    "all 13 financial-fixture provider shifts match after restaurant GUID remapping");

  const labor = async (b) => (await one("select count(*)::int n from cv_labor_entries where business_id = $1", [b])).n;
  check(await labor(D) === await labor(S), `a finished shift appears as often in the test café as in the real café (${await labor(D)} vs ${await labor(S)})`);
  check((await one("select menu_item_id from order_lines l join orders o on o.id = l.order_id where o.business_id = $1", [D])).menu_item_id === remapId("menu_items", ids.m1),
    "the copied order line points at the copied menu item");

  const second = await run();
  check(Object.keys(replacedDays(second)).length === 0, `an unchanged second run replaces nothing ${JSON.stringify(replacedDays(second))}`);

  // Insert-if-missing economic facts must refresh when SOURCE changes, without
  // copying credentials or replacing the intentionally separate test identity.
  await q("update employees set default_hourly_wage_cents = 2100 where id=$1", [ids.emp]);
  await run();
  check((await one("select default_hourly_wage_cents as n from employees where id=$1",
    [remapId("employees", ids.emp)])).n === "2100" ||
    Number((await one("select default_hourly_wage_cents as n from employees where id=$1",
      [remapId("employees", ids.emp)])).n) === 2100,
    "changed source employee default rate updates an existing copied employee");
  check((await one("select api_origin from toast_api_credentials where business_id=$1",[D])).api_origin === "not_configured",
    "test café retains only an inert Toast credential placeholder");

  // A failure after some writes must roll back all tables, including master
  // updates and already deleted mirror days. No production database is used.
  await q("update employees set default_hourly_wage_cents = 2300 where id=$1",[ids.emp]);
  await q("update daily_rollups set staff_wages_cents=staff_wages_cents+136 where business_id=$1 and business_date='2026-10-12'",[S]);
  const beforeFailure = await parity(D,"2026-10-12");
  const failingClient = { query: async (sql, params) => {
    if (/^\\s*delete from timecards /i.test(sql)) throw Object.assign(new Error("injected mirror failure"),{ code:"23503" });
    return client.query(sql,params);
  } };
  let failed = false;
  try { await syncAll(failingClient, {}); } catch (e) { failed = e.code === "23503"; }
  check(failed, "injected FK-like failure aborts the copy transaction");
  check(JSON.stringify(await parity(D,"2026-10-12")) === JSON.stringify(beforeFailure),
    "rollback leaves test wages, fees and statuses untouched");
  check(Number((await one("select default_hourly_wage_cents as n from employees where id=$1",
    [remapId("employees",ids.emp)])).n) === 2100,
    "rollback restores existing copied master economic values");
  await run();
  check((await parity(D,"2026-10-12")).rollup.staff_wages_cents ===
    (await parity(S,"2026-10-12")).rollup.staff_wages_cents,
    "incremental recovery reconciles a previously stale 136-cent wage difference");

  await q("update order_lines set menu_item_id = $1 where id = $2", [ids.m2, ids.line]);
  const third = await run();
  check((await one("select menu_item_id from order_lines l join orders o on o.id = l.order_id where o.business_id = $1", [D])).menu_item_id === remapId("menu_items", ids.m2),
    "an order line moved to another menu item is copied again");
  check(third.orders_days === 1 && third.timecards_days === undefined, `only that order day is replaced ${JSON.stringify(replacedDays(third))}`);

  // The Toast archive and daily captures (stack PR 6): only each day's latest import is copied.
  const archiveDay = "2026-10-21";
  const runIds = { old: "c0ffee00-0000-4000-8000-000000000201", cur: "c0ffee00-0000-4000-8000-000000000202", next: "c0ffee00-0000-4000-8000-000000000203" };
  const orderGuid = "c0ffee00-0000-4000-8000-000000000301";
  const orderPayload = (tip) => ({ guid: orderGuid, checks: [{ guid: "c0ffee00-0000-4000-8000-000000000302", amount: 5,
    selections: [{ guid: "c0ffee00-0000-4000-8000-000000000303", displayName: "Latte", price: 5, quantity: 1 }],
    payments: [{ guid: "c0ffee00-0000-4000-8000-000000000304", type: "CREDIT", amount: 5, tipAmount: tip, paymentStatus: "CAPTURED" }] }] });
  await q("insert into toast_sync_runs(id, business_id, restaurant_guid, kind, state) values ($1, $3, $4, 'daily', 'completed'), ($2, $3, $4, 'daily', 'running')", [runIds.old, runIds.cur, S, G]);
  await q("insert into toast_day_status(business_id, restaurant_guid, business_date, import_state, last_import_run_id, imported_at) values ($1, $2, $3, 'imported', $4, now())", [S, G, archiveDay, runIds.cur]);
  await q("update toast_sync_runs set state = 'completed' where id = $1", [runIds.cur]);
  const archive = (run, tip, key) => q(`insert into toast_raw_records(business_id, restaurant_guid, entity, entity_guid, business_date, payload, payload_sha256, run_id, capture_key, source_page, source_index)
    values ($1, $2, 'order', $3, $4, $5::jsonb, md5($5::text) || md5($5::text), $6, $7, 1, 1)`, [S, G, orderGuid, archiveDay, JSON.stringify(orderPayload(tip)), run, key]);
  await archive(runIds.old, 1, "old-version");
  await archive(runIds.cur, 2, "current-version");
  await q(`insert into toast_raw_records(business_id, restaurant_guid, entity, business_date, payload, payload_sha256, run_id, capture_key)
    values ($1, $2, 'check', $3, '{}', repeat('a', 64), $4, 'legacy-check-row')`, [S, G, archiveDay, runIds.cur]);
  const capture = (endpoint, date, hoursAgo, items, extra = {}) => q(`insert into toast_raw_samples(business_id, restaurant_guid, endpoint, business_date, fetched_at, http_status, item_count, sample, field_paths, capture_id, error_code)
    values ($1, $2, $3, $4, now() - $5 * interval '1 hour', $6, 1, $7, '{guid}', gen_random_uuid(), $8)`,
    [S, G, endpoint, date, hoursAgo, extra.status ?? 200, JSON.stringify(items), extra.error ?? null]);
  await capture("labor/v1/timeEntries", archiveDay, 5, [{ guid: "old-entry" }]);
  await capture("labor/v1/timeEntries", archiveDay, 1, [{ guid: "entry-1", regularHours: 4 }]);
  await capture("labor/v1/timeEntries", archiveDay, 0, [], { status: 500, error: "http_error" });
  await capture("config/v2/tables", "2026-10-19", 48, [{ guid: "old-table" }]);
  await capture("config/v2/tables", "2026-10-20", 24, [{ guid: "t-1" }, { guid: "t-2" }]);
  await capture("orders/v2/ordersBulk", archiveDay, 1, [{ guid: orderGuid }]);

  await run();
  const viewCounts = async (b) => Object.fromEntries((await q(
    "select record_type, count(*)::int n, count(*) filter (where counts_in_sales)::int counted from cv_toast_records where business_id = $1 group by 1 order by 1", [b])).rows
    .map((r) => [r.record_type, `${r.n}/${r.counted}`]));
  const [sourceView, destView] = [await viewCounts(S), await viewCounts(D)];
  check(JSON.stringify(destView) === JSON.stringify(sourceView), `the AI's Toast records read the same in both cafés ${JSON.stringify(destView)}`);
  check(destView.order === "1/1" && destView["config/v2/tables"] === "2/0" && destView["labor/v1/timeEntries"] === "1/0" && !destView["orders/v2/ordersBulk"],
    "latest order version only, newest captures only, no second copy of orders");
  check((await one("select count(*)::int n from toast_raw_records where business_id = $1", [D])).n === 1, "the test café archive holds one row: the latest order");
  check((await one("select (payload->'checks'->0->'payments'->0->>'tipAmount')::int tip from toast_raw_records where business_id = $1", [D])).tip === 2, "the copied order is the latest version");
  check((await one("select count(*)::int n from toast_order_typed_facts where business_id = $1", [D])).n === 1, "typed order details are rebuilt in the test café");
  check((await one(`select count(*)::int n from toast_raw_records r join toast_day_status d on d.business_id = r.business_id and d.restaurant_guid = r.restaurant_guid
    and d.business_date = r.business_date and d.last_import_run_id = r.run_id where r.business_id = $1`, [D])).n === 1, "the copied order names its day's copied run");

  const unchanged = await run();
  check(Object.keys(replacedDays(unchanged)).length === 0, `an unchanged run replaces nothing ${JSON.stringify(replacedDays(unchanged))}`);

  // Toast sends the same day again, unchanged: a new run, the same order.
  await q("insert into toast_sync_runs(id, business_id, restaurant_guid, kind, state) values ($1, $2, $3, 'daily', 'running')", [runIds.next, S, G]);
  await q("update toast_day_status set last_import_run_id = $1, imported_at = now() + interval '1 minute' where business_id = $2 and business_date = $3", [runIds.next, S, archiveDay]);
  await q("update toast_sync_runs set state = 'completed' where id = $1", [runIds.next]);
  await q("update toast_raw_records set run_id = $1, last_seen = now() + interval '1 minute' where business_id = $2 and run_id = $3", [runIds.next, S, runIds.cur]);
  const reimport = await run();
  check(reimport.toast_raw_records_days === 1, `a re-imported day is copied again ${JSON.stringify(replacedDays(reimport))}`);
  check(JSON.stringify(await viewCounts(D)) === JSON.stringify(await viewCounts(S)), "after the re-import both cafés still read the same");
} finally {
  await cleanup();
  await client.end();
  await raw.end();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("sync-cafe-data database checks passed");
