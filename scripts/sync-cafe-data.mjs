#!/usr/bin/env node
// Syncs café operating data from a source café business into a destination café business
// (ids below — not named here to keep personal account info out of source control).
//
// Two sync strategies:
//  - "Insert if missing" (INSERT_IF_MISSING_TABLES): owner-entered data (recipes, ingredients,
//    costs, roster, settings). Destination ids are derived deterministically from
//    (table, source id, dest business id) via uuidv5, so re-running only inserts rows that are
//    new on the source side — it never updates or deletes a row already in the destination, so
//    test modifications there are untouched.
//  - "Refresh window" (REFRESH_WINDOW_TABLES, see runRefreshWindowSync): sales/labor/Toast-
//    derived facts (orders, order lines, rollups, timecards, card-fee facts). On the first run
//    (destination has no orders yet) these are fully copied. On every later run, inside a single
//    transaction, only the last 8 business days are deleted from the destination and re-copied
//    from the source — older destination history is left alone.
//
// Deliberately excludes: AI chat/threads, owner notifications, supervisor proposals/reports,
// scheduling AI-plan audit trail, screen view analytics, product photos (storage object isn't
// cloned), and anything credential-bearing (POS tokens, Toast API credentials, sync leases,
// webhook secrets). Includes operating_tasks / operating_task_responses so alerts on the source
// café can be exercised in the destination too.
//
// Safety: every write is scoped to DEST_BUSINESS_ID. wrapClientForSafety() additionally refuses,
// at the query layer, any insert/update/delete whose parameters include SOURCE_BUSINESS_ID — the
// source café is read-only for this script, enforced in code rather than left to review alone.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const SOURCE_BUSINESS_ID = "0200c26e-b971-4236-ac6b-56dd191ec59b";
export const DEST_BUSINESS_ID = "719af528-af8e-4203-bb25-4c118c9ff832";
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // fixed uuidv5 namespace, arbitrary but stable
const REFRESH_WINDOW_DAYS = 8;

export function uuidv5(name) {
  const namespaceBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = crypto.createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// `${table}|${sourceId}` -> destId. Populated when a row is matched to one that already exists
// in the destination (e.g. a shared starter-pack ingredient) instead of being cloned as a new
// row — every downstream FK remap into that table must resolve to the existing id, not a fresh one.
export const idOverrides = new Map();

export function remapId(targetTable, sourceId) {
  const key = `${targetTable}|${sourceId}`;
  if (idOverrides.has(key)) return idOverrides.get(key);
  return uuidv5(`${DEST_BUSINESS_ID}|${targetTable}|${sourceId}`);
}

// Columns backed by a real Postgres array type (smallint[], date[], etc.) rather than jsonb —
// these must be handed to pg as a native JS array (the driver serializes it as an array
// literal), never JSON.stringify'd, or Postgres rejects it as an invalid array literal.
const NATIVE_ARRAY_COLUMNS = new Set(["available_days", "unavailable_weekdays", "flagged_dates"]);

export function toParam(column, value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) && NATIVE_ARRAY_COLUMNS.has(column)) return value;
  if (Array.isArray(value) || (typeof value === "object" && !(value instanceof Date))) return JSON.stringify(value);
  return value;
}

// Refuses, at the query layer, any insert/update/delete whose parameters include
// SOURCE_BUSINESS_ID. The source café must only ever be read by this script.
export function wrapClientForSafety(client) {
  const originalQuery = client.query.bind(client);
  client.query = (sql, params) => {
    const text = typeof sql === "string" ? sql : sql?.text ?? "";
    const isWrite = /^\s*(insert|update|delete)\b/i.test(text);
    if (isWrite && Array.isArray(params) && params.includes(SOURCE_BUSINESS_ID)) {
      throw new Error("safety violation: refusing to write a statement whose parameters reference SOURCE_BUSINESS_ID");
    }
    return originalQuery(sql, params);
  };
  return client;
}

function t(table, opts = {}) {
  return {
    table,
    pk: opts.pk ?? ["id"],
    remapOwnId: opts.remapOwnId ?? false,
    fk: opts.fk ?? {},
    nullOut: opts.nullOut ?? [],
    joinScope: opts.joinScope ?? null, // parent table to scope by, for tables with no business_id column
    joinCol: opts.joinCol ?? null, // this table's column that references joinScope.id
    matchColumn: opts.matchColumn ?? null, // dedupe against an existing dest row sharing this column's value
  };
}

// Owner-entered / catalog / roster data: insert-if-missing, never updated or deleted here.
export const INSERT_IF_MISSING_TABLES = [
  t("locations", { remapOwnId: true }),
  t("ingredients", { remapOwnId: true, matchColumn: "starter_key" }),
  t("menu_items", { remapOwnId: true }),
  t("employees", { remapOwnId: true }),
  t("recurring_costs", { remapOwnId: true }),
  t("recovery_order", { pk: ["business_id", "bucket_code"] }),
  t("staff_schedules", { remapOwnId: true, fk: { employee_id: "employees" } }),
  t("scheduling_qualification_types", { remapOwnId: true }),
  t("ingredient_prices", {
    remapOwnId: true,
    joinScope: "ingredients",
    joinCol: "ingredient_id",
    fk: { ingredient_id: "ingredients" },
    // Both reference rows (an expense line, a pantry stock purchase) that are synced in a later
    // table and don't exist yet at this point in the run — null them rather than risk a dangling
    // or forward-ordering-dependent reference. They're provenance metadata, not load-bearing.
    nullOut: ["source_expense_line_id", "source_stock_line_id"],
  }),
  t("modifier_recipes", { remapOwnId: true, fk: { ingredient_id: "ingredients", replaces_ingredient_id: "ingredients" } }),
  t("recipe_lines", { pk: ["menu_item_id", "ingredient_id"], joinScope: "menu_items", joinCol: "menu_item_id", fk: { menu_item_id: "menu_items", ingredient_id: "ingredients" } }),
  t("menu_combo_components", { pk: ["combo_item_id", "component_item_id"], fk: { combo_item_id: "menu_items", component_item_id: "menu_items" } }),
  t("menu_item_modifier_groups", { pk: ["business_id", "menu_item_id", "pos_group_id"], fk: { menu_item_id: "menu_items" } }),
  t("menu_product_addons", { remapOwnId: true, fk: { menu_item_id: "menu_items", ingredient_id: "ingredients" } }),
  t("menu_price_history", { remapOwnId: true, fk: { menu_item_id: "menu_items" } }),
  t("menu_market_price_observations", { remapOwnId: true, fk: { menu_item_id: "menu_items" } }),
  t("menu_item_cost_fallbacks", { pk: ["business_id", "menu_item_id"], fk: { menu_item_id: "menu_items" } }),
  t("pos_catalog_matches", { remapOwnId: true, fk: { suggested_menu_item_id: "menu_items" } }),
  t("pos_item_aliases", { pk: ["business_id", "provider", "pos_item_id"], fk: { menu_item_id: "menu_items" } }),
  t("scheduled_shifts", { remapOwnId: true, fk: { employee_id: "employees", repeat_schedule_id: "staff_schedules" }, nullOut: ["proposal_id"] }),
  t("staff_qualifications", { remapOwnId: true, fk: { employee_id: "employees", location_id: "locations" } }),
  t("staff_availability_rules", { remapOwnId: true, fk: { employee_id: "employees", location_id: "locations" } }),
  t("staff_availability_exceptions", { remapOwnId: true, fk: { employee_id: "employees", location_id: "locations" } }),
  t("staff_preference_windows", { remapOwnId: true, fk: { employee_id: "employees" } }),
  t("staff_custom_rules", { remapOwnId: true }),
  t("staff_scheduling_compensation", { remapOwnId: true, fk: { employee_id: "employees" } }),
  t("staff_scheduling_preferences", { remapOwnId: true, fk: { employee_id: "employees" } }),
  t("scheduling_coverage_requirements", { remapOwnId: true, fk: { location_id: "locations" } }),
  t("employee_pay_period_facts", { remapOwnId: true, fk: { employee_id: "employees" } }),
  t("pos_scheduled_shifts", { pk: ["business_id", "provider", "external_shift_id"], fk: { location_id: "locations" } }),
  t("expenses", { remapOwnId: true, fk: { recurring_cost_id: "recurring_costs" } }),
  t("expense_lines", { remapOwnId: true, joinScope: "expenses", joinCol: "expense_id", fk: { expense_id: "expenses", ingredient_id: "ingredients" } }),
  t("vendor_rules", { pk: ["business_id", "normalized_vendor"] }),
  t("uploads", { remapOwnId: true }),
  t("processing_fee_rate_plans", { remapOwnId: true }),
  t("pantry_stock_counts", { remapOwnId: true, fk: { ingredient_id: "ingredients" } }),
  t("pantry_stock_purchases", { remapOwnId: true, fk: { ingredient_id: "ingredients", expense_line_id: "expense_lines" } }),
  t("pantry_modifier_links", { pk: ["business_id", "provider", "location_ref", "pos_modifier_id"], fk: { modifier_recipe_id: "modifier_recipes" } }),
  t("operating_tasks", { pk: ["business_id", "id"] }),
  t("operating_task_responses", { remapOwnId: true, fk: { employee_id: "employees" } }),
  // Toast integration *data* (no credentials). toast_location_mappings depends on a
  // toast_api_credentials row existing for the business (see ensureToastCredentialsPlaceholder),
  // and toast_day_status / toast_day_owner_flags depend on toast_location_mappings — keep this order.
  // restaurant_guid is remapped too (via the synthetic "toast_restaurant_guid" namespace, not a
  // real table): a global unique index (toast_one_cafe_per_restaurant_uidx) allows only one
  // business in the whole system to be linked to a given real Toast restaurant, and Test Café
  // isn't actually connected to Toast — copying the source's real restaurant_guid unchanged
  // would try to claim that same real-world POS connection for a second business.
  t("toast_location_mappings", { pk: ["business_id", "restaurant_guid"], fk: { location_id: "locations", restaurant_guid: "toast_restaurant_guid" } }),
  t("toast_day_status", { pk: ["business_id", "restaurant_guid", "business_date"], fk: { restaurant_guid: "toast_restaurant_guid" }, nullOut: ["last_import_run_id"] }),
  t("toast_day_owner_flags", { pk: ["business_id", "restaurant_guid", "business_date"], fk: { restaurant_guid: "toast_restaurant_guid" } }),
  t("toast_first_import_check", { pk: ["business_id"] }),
  t("ingredient_unit_conversions", { remapOwnId: true, joinScope: "ingredients", joinCol: "ingredient_id", fk: { ingredient_id: "ingredients" } }),
];

// Sales/labor/Toast-derived facts: fully copied on the first run, then refreshed (deleted +
// re-copied) for only the last REFRESH_WINDOW_DAYS business days on every later run. See
// runRefreshWindowSync. Order matters: children before parents on delete, parents before
// children on insert.
export const REFRESH_WINDOW_TABLES = [
  t("orders", { remapOwnId: true, fk: { location_id: "locations", employee_id: "employees" } }),
  // order_lines has no business_id/business_date of its own — scoped via its parent order.
  t("order_lines", { remapOwnId: true, joinScope: "orders", joinCol: "order_id", fk: { order_id: "orders", menu_item_id: "menu_items" } }),
  t("employee_sales_rollup", { pk: ["business_id", "business_date", "employee_id"], fk: { employee_id: "employees" } }),
  t("hourly_sales_rollup", { pk: ["business_id", "business_date", "hour_local"], fk: { location_id: "locations" } }),
  t("daily_rollups", { pk: ["business_id", "business_date"] }),
  t("timecards", { remapOwnId: true, fk: { employee_id: "employees", schedule_id: "staff_schedules" } }),
  t("processing_fee_daily_candidates", { pk: ["business_id", "business_date", "source_type", "provider"] }),
  t("processing_fee_daily_facts", { pk: ["business_id", "business_date"] }),
];

export function remapRow(table, row, cfg) {
  const out = { ...row };
  if ("business_id" in out) out.business_id = DEST_BUSINESS_ID;
  if (cfg.remapOwnId) out.id = remapId(table, row.id);
  for (const [col, targetTable] of Object.entries(cfg.fk ?? {})) {
    if (out[col] != null) out[col] = remapId(targetTable, row[col]);
  }
  for (const col of cfg.nullOut ?? []) out[col] = null;
  return out;
}

async function chunkedInsert(client, table, rows, pkColumns) {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const chunkSize = Math.max(1, Math.floor(1000 / columns.length)); // stay under postgres's 65535 bind-param limit
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = [];
    const values = [];
    let p = 1;
    for (const row of chunk) {
      placeholders.push(`(${columns.map(() => `$${p++}`).join(",")})`);
      for (const c of columns) values.push(toParam(c, row[c]));
    }
    const sql = `insert into ${table} (${columns.join(",")}) values ${placeholders.join(",")} on conflict (${pkColumns.join(",")}) do nothing`;
    const result = await client.query(sql, values);
    inserted += result.rowCount;
  }
  return inserted;
}

async function syncTable(client, cfg) {
  const { table, pk, remapOwnId, joinScope, joinCol, matchColumn } = cfg;

  let matchMap = null;
  if (matchColumn) {
    const { rows: existing } = await client.query(`select id, ${matchColumn} from ${table} where business_id = $1 and ${matchColumn} is not null`, [DEST_BUSINESS_ID]);
    matchMap = new Map(existing.map((r) => [r[matchColumn], r.id]));
  }

  const selectSql = joinScope
    ? `select t.* from ${table} t join ${joinScope} p on t.${joinCol} = p.id where p.business_id = $1`
    : `select * from ${table} where business_id = $1`;
  const { rows } = await client.query(selectSql, [SOURCE_BUSINESS_ID]);
  if (rows.length === 0) return 0;

  const rowsToInsert = [];
  for (const row of rows) {
    if (matchColumn && row[matchColumn] != null && matchMap.has(row[matchColumn])) {
      idOverrides.set(`${table}|${row.id}`, matchMap.get(row[matchColumn]));
      continue;
    }
    rowsToInsert.push(remapRow(table, row, cfg));
  }

  const pkColumns = pk.map((c) => (c === "id" && remapOwnId ? "id" : c));
  return chunkedInsert(client, table, rowsToInsert, pkColumns);
}

// Ensures a (credential-free) toast_api_credentials row exists for DEST_BUSINESS_ID, purely to
// satisfy toast_location_mappings' foreign key — no real token/secret value is ever copied or
// set; api_origin/client_id/client_secret_enc are NOT NULL with no default, so they're filled
// with inert placeholder text rather than any real credential.
async function ensureToastCredentialsPlaceholder(client) {
  await client.query(
    `insert into toast_api_credentials (business_id, api_origin, client_id, client_secret_enc, state)
     values ($1, 'not_configured', 'not_configured', 'not_configured', 'disconnected')
     on conflict (business_id) do nothing`,
    [DEST_BUSINESS_ID],
  );
}

// Keeps the destination's timezone / open hours in step with the source on every run (unlike
// the rest of INSERT_IF_MISSING_TABLES, these two fields are explicitly kept live, not just
// seeded once) — nothing else about the destination's business/location identity is touched.
async function syncTimezoneAndHours(client) {
  // Read from source first, then write only DEST-scoped statements — keeps every write's
  // parameters free of SOURCE_BUSINESS_ID, which is what wrapClientForSafety checks for.
  const { rows: sourceBusinessRows } = await client.query(`select timezone from businesses where id = $1`, [SOURCE_BUSINESS_ID]);
  const sourceTimezone = sourceBusinessRows[0]?.timezone ?? null;
  if (sourceTimezone != null) {
    await client.query(`update businesses set timezone = $1 where id = $2`, [sourceTimezone, DEST_BUSINESS_ID]);
  }

  const { rows: sourceLocations } = await client.query(`select id, timezone, open_hours from locations where business_id = $1`, [SOURCE_BUSINESS_ID]);
  for (const loc of sourceLocations) {
    const destId = remapId("locations", loc.id);
    await client.query(`update locations set timezone = $1, open_hours = $2 where id = $3 and business_id = $4`, [loc.timezone, toParam("open_hours", loc.open_hours), destId, DEST_BUSINESS_ID]);
  }
}

async function getRefreshWindowCutoff(client) {
  const { rows: destCountRows } = await client.query(`select count(*)::int as c from orders where business_id = $1`, [DEST_BUSINESS_ID]);
  const firstRun = destCountRows[0].c === 0;
  if (firstRun) return { firstRun, cutoff: null };

  const { rows: maxDateRows } = await client.query(`select max(business_date) as maxd from orders where business_id = $1`, [SOURCE_BUSINESS_ID]);
  const maxDate = maxDateRows[0].maxd;
  if (!maxDate) return { firstRun: false, cutoff: null };

  const cutoff = new Date(maxDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - (REFRESH_WINDOW_DAYS - 1));
  return { firstRun: false, cutoff };
}

async function copyRefreshTable(client, cfg, cutoff) {
  const { table, pk, joinScope, joinCol } = cfg;
  let selectSql;
  const params = [SOURCE_BUSINESS_ID];
  if (joinScope) {
    selectSql = `select t.* from ${table} t join ${joinScope} p on t.${joinCol} = p.id where p.business_id = $1`;
    if (cutoff) {
      selectSql += ` and p.business_date >= $2`;
      params.push(cutoff);
    }
  } else if (table === "timecards") {
    selectSql = `select * from ${table} where business_id = $1`;
    if (cutoff) {
      selectSql += ` and clock_in >= $2`;
      params.push(cutoff);
    }
  } else {
    selectSql = `select * from ${table} where business_id = $1`;
    if (cutoff) {
      selectSql += ` and business_date >= $2`;
      params.push(cutoff);
    }
  }

  const { rows } = await client.query(selectSql, params);
  if (rows.length === 0) return 0;
  const rowsToInsert = rows.map((row) => remapRow(table, row, cfg));
  const pkColumns = pk.map((c) => (c === "id" && cfg.remapOwnId ? "id" : c));
  return chunkedInsert(client, table, rowsToInsert, pkColumns);
}

async function deleteDestWindow(client, table, cutoff, { viaOrders = false } = {}) {
  if (!cutoff) return; // first run: destination has nothing to delete yet
  if (viaOrders) {
    await client.query(`delete from ${table} where order_id in (select id from orders where business_id = $1 and business_date >= $2)`, [DEST_BUSINESS_ID, cutoff]);
  } else if (table === "timecards") {
    await client.query(`delete from ${table} where business_id = $1 and clock_in >= $2`, [DEST_BUSINESS_ID, cutoff]);
  } else {
    await client.query(`delete from ${table} where business_id = $1 and business_date >= $2`, [DEST_BUSINESS_ID, cutoff]);
  }
}

// Runs the whole refresh-window group — deletes + re-copies — inside one transaction, so a
// failure partway through never leaves the destination with some tables refreshed and others not.
async function runRefreshWindowSync(client, counts) {
  const byTable = Object.fromEntries(REFRESH_WINDOW_TABLES.map((cfg) => [cfg.table, cfg]));
  const { cutoff } = await getRefreshWindowCutoff(client);

  await client.query("begin");
  try {
    await deleteDestWindow(client, "order_lines", cutoff, { viaOrders: true });
    await deleteDestWindow(client, "orders", cutoff);
    await deleteDestWindow(client, "employee_sales_rollup", cutoff);
    await deleteDestWindow(client, "hourly_sales_rollup", cutoff);
    await deleteDestWindow(client, "daily_rollups", cutoff);
    await deleteDestWindow(client, "timecards", cutoff);
    await deleteDestWindow(client, "processing_fee_daily_candidates", cutoff);
    await deleteDestWindow(client, "processing_fee_daily_facts", cutoff);

    for (const tableName of ["orders", "order_lines", "employee_sales_rollup", "hourly_sales_rollup", "daily_rollups", "timecards", "processing_fee_daily_candidates", "processing_fee_daily_facts"]) {
      counts[tableName] = await copyRefreshTable(client, byTable[tableName], cutoff);
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function startRun(client) {
  const { rows } = await client.query(`insert into cafe_sync_runs (started_at, status) values (now(), 'running') returning id`, []);
  return rows[0].id;
}

async function finishRun(client, runId, { status, counts, errorTable, errorCode }) {
  await client.query(`update cafe_sync_runs set finished_at = now(), status = $1, table_counts = $2, error_table = $3, error_code = $4 where id = $5`, [
    status,
    JSON.stringify(counts),
    errorTable ?? null,
    errorCode ?? null,
    runId,
  ]);
}

loadEnvLocal();

if (process.env.VITEST !== "true" && !process.env.SYNC_CAFE_DATA_SKIP_MAIN) {
  if (!process.env.SUPABASE_DB_URL) {
    console.log("sync-cafe-data needs SUPABASE_DB_URL in .env.local. Skipping — nothing was changed.");
    process.exit(0);
  }
  await main();
}

export async function main() {
  const supabaseRootCa = readFileSync(path.join(__dirname, "supabase-root-ca.pem"), "utf8");
  const client = wrapClientForSafety(new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: true, ca: supabaseRootCa } }));
  await client.connect();

  const counts = {};
  let runId;
  let currentTable = null;
  try {
    runId = await startRun(client);

    currentTable = "toast_api_credentials";
    await ensureToastCredentialsPlaceholder(client); // must exist before toast_location_mappings below

    for (const cfg of INSERT_IF_MISSING_TABLES) {
      currentTable = cfg.table;
      counts[cfg.table] = await syncTable(client, cfg);
    }

    currentTable = "refresh_window";
    await runRefreshWindowSync(client, counts);

    currentTable = "timezone_and_hours";
    await syncTimezoneAndHours(client);

    await finishRun(client, runId, { status: "success", counts });

    for (const [table, n] of Object.entries(counts)) {
      if (n > 0) console.log(`  ✓ ${table}: ${n} row(s)`);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`\n✅ sync complete. ${total} row(s) touched.`);
  } catch (err) {
    // Deliberately log only the table name and error code — never err.message/err.detail, which
    // can embed literal row values (e.g. a unique-constraint violation's "Key (id)=(...)").
    const errorCode = err.code ?? "UNKNOWN";
    console.error(`sync failed: table=${currentTable} code=${errorCode}`);
    if (runId) {
      try {
        await finishRun(client, runId, { status: "error", counts, errorTable: currentTable, errorCode });
      } catch {
        // best-effort audit write; don't mask the original failure
      }
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

function loadEnvLocal() {
  const envPath = path.join(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
