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
//  - "Day mirror" (REFRESH_WINDOW_TABLES, see runDayMirrorSync): sales/labor/Toast-derived facts
//    (orders, order lines, rollups, timecards, card-fee and payment facts, voids, refunds). Each
//    run compares a fingerprint of every business day in the source and the destination, across
//    all history, and replaces only the days that differ, inside one transaction. A day that
//    arrives or changes late on the source (a re-pull, a late timecard) is copied too, and
//    unchanged days are never rewritten.
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
import pg, { Client } from "pg";

// Read dates and timestamps as Postgres's own text. JavaScript dates keep milliseconds only, so a
// copied timestamp lost its microseconds and every day holding one looked changed on every run.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (value) => value);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const SOURCE_BUSINESS_ID = "0200c26e-b971-4236-ac6b-56dd191ec59b";
export const DEST_BUSINESS_ID = "719af528-af8e-4203-bb25-4c118c9ff832";
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // fixed uuidv5 namespace, arbitrary but stable

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
const NATIVE_ARRAY_COLUMNS = new Set(["available_days", "unavailable_weekdays", "flagged_dates", "field_paths"]);

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

// Rows of each day's latest Toast import (what toast_day_status.last_import_run_id points at).
export const LATEST_ORDERS_FILTER = `t.entity = 'order' and exists (select 1 from toast_day_status d where d.business_id = t.business_id and d.restaurant_guid = t.restaurant_guid and d.business_date = t.business_date and d.import_state = 'imported' and d.last_import_run_id = t.run_id)`;
// Toast endpoints captured per business day; every other endpoint is a setup list, kept newest only.
const DATED_CAPTURES = `('labor/v1/shifts','labor/v1/timeEntries','cashmgmt/v1/deposits','cashmgmt/v1/entries','kitchen/v1/export/itemFulfillments')`;
// The newest successful capture of each dated endpoint per day, and of each setup list overall.
export const LATEST_CAPTURE_FILTER = `t.http_status between 200 and 299 and t.error_code is null and t.endpoint not like 'orders/%' and t.endpoint not like '%{%' and coalesce(t.capture_id::text, 'row:' || t.id::text) = (select coalesce(x.capture_id::text, 'row:' || x.id::text) from toast_raw_samples x where x.business_id = t.business_id and x.restaurant_guid = t.restaurant_guid and x.endpoint = t.endpoint and x.http_status between 200 and 299 and x.error_code is null and (x.business_date is not distinct from t.business_date or not (t.endpoint in ${DATED_CAPTURES} or t.endpoint like 'era/%')) order by x.fetched_at desc, x.id desc limit 1)`;

function t(table, opts = {}) {
  return {
    table,
    pk: opts.pk ?? ["id"],
    remapOwnId: opts.remapOwnId ?? false,
    fk: opts.fk ?? {},
    nullOut: opts.nullOut ?? [],
    setValues: opts.setValues ?? {}, // literal values forced after remap, e.g. resetting a NOT NULL scheduler counter
    joinScope: opts.joinScope ?? null, // parent table to scope by, for tables with no business_id column
    joinCol: opts.joinCol ?? null, // this table's column that references joinScope.id
    matchColumn: opts.matchColumn ?? null, // dedupe against an existing dest row sharing this column's value
    dateColumn: opts.dateColumn ?? "business_date", // day-mirror tables only: the column whose date groups a row into a day
    dropColumns: opts.dropColumns ?? [], // never copied (e.g. an identity id the destination generates itself)
    // Day-mirror tables only: SQL condition on alias "t" choosing which rows of a day are mirrored
    // (the same condition is used for both cafés, so their fingerprints compare like for like).
    sourceFilter: opts.sourceFilter ?? null,
    fingerprintIgnore: opts.fingerprintIgnore ?? [], // copied, but bookkeeping that changes without the data changing
    // Text ids of the form "toast:<restaurant guid>:<id>": the guid is remapped like restaurant_guid,
    // so views joining them to remapped restaurant_guid columns still match in the destination.
    toastGuidIn: opts.toastGuidIn ?? [],
    // "target": on conflict (pk) do nothing — pk must match a real constraint (see migrationConstraints.mjs test).
    // "none": on conflict do nothing, no target — use when the exact constraint shape shouldn't be hard-coded.
    // "plain": no on-conflict clause at all — only safe when the row range was already deleted in this transaction.
    // "updateSafetyColumns": on conflict (pk) do update set <updateColumnsOnConflict> — for an
    // insert-if-missing table where a handful of columns are a safety reset (e.g. keeping a
    // background scheduler from ever touching the destination), not owner data, so they must be
    // re-applied even to a row that already existed before this safety rule was added.
    conflictMode: opts.conflictMode ?? "target",
    updateColumnsOnConflict: opts.updateColumnsOnConflict ?? null,
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
  // toast_api_credentials row existing for the business (see ensureToastCredentialsPlaceholder).
  // toast_day_status / toast_day_owner_flags also depend on it (FK on business_id+restaurant_guid)
  // but are synced later, in the day-mirror group — this insert-if-missing pass still has to
  // run first so that FK target exists by then.
  // restaurant_guid is remapped too (via the synthetic "toast_restaurant_guid" namespace, not a
  // real table): a global unique index (toast_one_cafe_per_restaurant_uidx) allows only one
  // business in the whole system to be linked to a given real Toast restaurant, and Test Café
  // isn't actually connected to Toast — copying the source's real restaurant_guid unchanged
  // would try to claim that same real-world POS connection for a second business.
  // verified_at and the scheduler tick/lease columns (info_refreshed_at, last_tick_started_at,
  // recheck_total) are reset so Toast's background scheduler has no reason to ever pick up and
  // poll the test café — it was never actually verified or ticked here.
  t("toast_location_mappings", {
    pk: ["business_id", "restaurant_guid"],
    fk: { location_id: "locations", restaurant_guid: "toast_restaurant_guid" },
    nullOut: ["verified_at", "info_refreshed_at", "last_tick_started_at"],
    setValues: { recheck_total: 0 }, // NOT NULL with a default of 0 — null would violate the column, reset instead
    // These 4 columns are a safety reset, not owner data — re-apply them even to a row that
    // already existed before this rule was added, rather than silently leaving stale values in
    // place the way plain "insert if missing" would.
    conflictMode: "updateSafetyColumns",
    updateColumnsOnConflict: ["verified_at", "info_refreshed_at", "last_tick_started_at", "recheck_total"],
  }),
  t("toast_first_import_check", { pk: ["business_id"] }),
  // No real unique/PK target to name here (see migrationConstraints test) — a plain conflict
  // target would need to assume a specific index shape; skip naming one instead.
  t("ingredient_unit_conversions", { remapOwnId: true, joinScope: "ingredients", joinCol: "ingredient_id", fk: { ingredient_id: "ingredients" }, conflictMode: "none" }),
];

// Sales/labor/Toast-derived facts, mirrored day by day: only days that differ between the two
// cafés are deleted and re-copied. See runDayMirrorSync. Order matters: children before parents on delete, parents before
// children on insert.
export const REFRESH_WINDOW_TABLES = [
  t("orders", { remapOwnId: true, fk: { location_id: "locations", employee_id: "employees" } }),
  // order_lines has no business_id/business_date of its own — scoped via its parent order, and
  // its days always mirror orders' days (see runDayMirrorSync), never its own.
  t("order_lines", { remapOwnId: true, joinScope: "orders", joinCol: "order_id", fk: { order_id: "orders", menu_item_id: "menu_items" } }),
  // Neither table has a primary key or unique constraint in the migrations that create them
  // (confirmed against supabase/migrations, not just the live database — see
  // sync-cafe-data.test.ts). A named ON CONFLICT target would error outright on a database built
  // fresh from migrations. Plain insert is safe here because every day being copied is deleted from
  // the destination earlier in the same transaction.
  t("employee_sales_rollup", { pk: ["business_id", "business_date", "employee_id"], fk: { employee_id: "employees" }, conflictMode: "plain" }),
  t("hourly_sales_rollup", { pk: ["business_id", "business_date", "hour_local"], fk: { location_id: "locations" }, conflictMode: "plain" }),
  t("daily_rollups", { pk: ["business_id", "business_date"] }),
  t("timecards", { remapOwnId: true, fk: { employee_id: "employees", schedule_id: "staff_schedules" }, dateColumn: "clock_in", toastGuidIn: ["pos_timecard_id"] }),
  t("processing_fee_daily_candidates", { pk: ["business_id", "business_date", "source_type", "provider"] }),
  t("processing_fee_daily_facts", { pk: ["business_id", "business_date"] }),
  // Moved here from insert-if-missing: these are Toast-derived day-level facts that should track
  // the same days as the rest of the day's sales data, not be seeded once and left stale.
  t("toast_day_status", { pk: ["business_id", "restaurant_guid", "business_date"], fk: { restaurant_guid: "toast_restaurant_guid" }, nullOut: ["last_import_run_id"] }),
  t("toast_day_owner_flags", { pk: ["business_id", "restaurant_guid", "business_date"], fk: { restaurant_guid: "toast_restaurant_guid" } }),
  t("pos_scheduled_shifts", { pk: ["business_id", "provider", "external_shift_id"], fk: { location_id: "locations" }, dateColumn: "scheduled_start" }),
  // Per-payment card fees and payment details, open Toast timecards, voids and refunds: the
  // rows the app's payment, labor and voids/refunds readers use.
  t("toast_payment_facts", { pk: ["business_id", "restaurant_guid", "business_date", "payment_ref"], fk: { restaurant_guid: "toast_restaurant_guid" } }),
  t("toast_payment_summaries", { pk: ["business_id", "restaurant_guid", "business_date", "payment_ref"], fk: { restaurant_guid: "toast_restaurant_guid" } }),
  t("toast_open_labor_summaries", { pk: ["business_id", "restaurant_guid", "external_time_entry_id"], fk: { restaurant_guid: "toast_restaurant_guid" }, dateColumn: "clock_in" }),
  t("toast_void_facts", { pk: ["business_id", "selection_guid"], fk: { location_id: "locations" }, dateColumn: "order_business_date" }),
  // id is an identity column the destination generates; the whole day is deleted first.
  t("toast_refund_facts", { pk: ["id"], fk: { restaurant_guid: "toast_restaurant_guid" }, dateColumn: "order_business_date", dropColumns: ["id"], conflictMode: "plain" }),
  // The Toast archive: only each day's latest imported orders (the version the app and the AI read).
  // Its run is the destination's copy of that import run (see syncImportRuns), so the AI's Toast
  // records view and typed order details (discounts, modifier prices, order times) work the same.
  // Typed details are rebuilt in the destination by the archive's own insert trigger.
  t("toast_raw_records", {
    fk: { restaurant_guid: "toast_restaurant_guid", run_id: "toast_sync_runs" },
    remapOwnId: true,
    nullOut: ["seen_run_id", "superseded_by"],
    fingerprintIgnore: ["first_seen", "last_seen", "source_page", "source_index", "capture_key"],
    sourceFilter: LATEST_ORDERS_FILTER,
  }),
  // Daily Toast captures (labor, cash, kitchen, menus, setup): the newest successful capture only.
  // Orders are left out: the archive above already holds them.
  t("toast_raw_samples", { remapOwnId: true, fk: { restaurant_guid: "toast_restaurant_guid" }, sourceFilter: LATEST_CAPTURE_FILTER }),
];

// Copy order: parents before children. Delete order is the reverse.
export const DAY_MIRROR_ORDER = ["orders", "order_lines", "employee_sales_rollup", "hourly_sales_rollup", "daily_rollups", "timecards", "processing_fee_daily_candidates", "processing_fee_daily_facts", "toast_day_status", "toast_day_owner_flags", "pos_scheduled_shifts", "toast_payment_facts", "toast_payment_summaries", "toast_open_labor_summaries", "toast_void_facts", "toast_refund_facts", "toast_raw_records", "toast_raw_samples"];

const TOAST_GUID_PREFIX = /^toast:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;
export function remapToastGuidPrefix(value) {
  if (typeof value !== "string") return value;
  return value.replace(TOAST_GUID_PREFIX, (_, guid) => `toast:${remapId("toast_restaurant_guid", guid)}:`);
}

export function remapRow(table, row, cfg) {
  const out = { ...row };
  if ("business_id" in out) out.business_id = DEST_BUSINESS_ID;
  if (cfg.remapOwnId) out.id = remapId(table, row.id);
  for (const [col, targetTable] of Object.entries(cfg.fk ?? {})) {
    if (out[col] != null) out[col] = remapId(targetTable, row[col]);
  }
  for (const col of cfg.toastGuidIn ?? []) out[col] = remapToastGuidPrefix(out[col]);
  for (const col of cfg.nullOut ?? []) out[col] = null;
  for (const [col, value] of Object.entries(cfg.setValues ?? {})) out[col] = value;
  for (const col of cfg.dropColumns ?? []) delete out[col];
  return out;
}

function conflictClause(conflictMode, pkColumns, updateColumnsOnConflict) {
  if (conflictMode === "plain") return "";
  if (conflictMode === "none") return "on conflict do nothing";
  if (conflictMode === "updateSafetyColumns") {
    const sets = updateColumnsOnConflict.map((c) => `${c} = excluded.${c}`).join(",");
    return `on conflict (${pkColumns.join(",")}) do update set ${sets}`;
  }
  return `on conflict (${pkColumns.join(",")}) do nothing`;
}

async function chunkedInsert(client, table, rows, pkColumns, conflictMode = "target", updateColumnsOnConflict = null) {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const chunkSize = Math.max(1, Math.floor(1000 / columns.length)); // stay under postgres's 65535 bind-param limit
  const onConflict = conflictClause(conflictMode, pkColumns, updateColumnsOnConflict);
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
    const sql = `insert into ${table} (${columns.join(",")}) values ${placeholders.join(",")} ${onConflict}`;
    const result = await client.query(sql, values);
    inserted += result.rowCount;
  }
  return inserted;
}

async function syncTable(client, cfg) {
  const { table, pk, joinScope, joinCol, matchColumn, conflictMode, updateColumnsOnConflict } = cfg;

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

  return chunkedInsert(client, table, rowsToInsert, pk, conflictMode, updateColumnsOnConflict);
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

// Copies the source café's latest live "today so far" Toast reading (one row, refreshed every
// 15 minutes on the source) so the destination's Home and chat show today's sales without its
// own Toast connection. Skipped quietly until migration 124 (toast_today_live) is applied.
export async function syncTodayLive(client) {
  let rows;
  try {
    ({ rows } = await client.query(
      `select business_date, read_at, net_sales_cents, orders, reading from toast_today_live where business_id = $1`,
      [SOURCE_BUSINESS_ID]));
  } catch (err) {
    if (err?.code === "42P01") return 0;
    throw err;
  }
  const row = rows[0];
  if (!row) return 0;
  await client.query(
    `insert into toast_today_live (business_id, business_date, read_at, net_sales_cents, orders, reading, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (business_id) do update set business_date = excluded.business_date, read_at = excluded.read_at,
       net_sales_cents = excluded.net_sales_cents, orders = excluded.orders, reading = excluded.reading, updated_at = now()`,
    [DEST_BUSINESS_ID, toParam("business_date", row.business_date), toParam("read_at", row.read_at),
      row.net_sales_cents, row.orders, toParam("reading", row.reading)]);
  return 1;
}

// GitHub Actions' workflow_dispatch "full_copy" input replaces every day of every mirrored table.
const FORCE_FULL_COPY = process.env.FULL_COPY === "true";

// Columns that legitimately differ between the two cafés (the business, remapped own ids, columns
// reset on copy) are left out of a day's fingerprint, so equal days compare equal. Links to other
// rows (foreign keys) are compared, translated into the destination's ids (see sourceIdOverrides).
export function fingerprintIgnoredColumns(cfg) {
  return [...new Set(["business_id", ...(cfg.remapOwnId ? ["id"] : []), ...(cfg.joinCol ? [cfg.joinCol] : []), ...(cfg.nullOut ?? []), ...Object.keys(cfg.setValues ?? {}), ...(cfg.dropColumns ?? []), ...(cfg.fingerprintIgnore ?? [])])];
}

// SQL that rewrites a source row's links into the ids the destination copy has (remapId, computed
// in the database by pg_temp.sync_v5), so a changed link (an order line moved to another menu item)
// changes the fingerprint, and an unchanged one compares equal.
export function sourceIdOverrides(cfg) {
  const ignored = new Set(fingerprintIgnoredColumns(cfg));
  const v5 = (target, expr) => `pg_temp.sync_v5('${DEST_BUSINESS_ID}|${target}|' || ${expr})`;
  const pairs = Object.entries(cfg.fk ?? {}).filter(([col]) => !ignored.has(col))
    .map(([col, target]) => `'${col}', case when t.${col} is null then null else ${v5(target, `t.${col}::text`)} end`);
  for (const col of cfg.toastGuidIn ?? []) {
    pairs.push(`'${col}', case when t.${col} ~* '^toast:[0-9a-f-]{36}:' then 'toast:' || ${v5("toast_restaurant_guid", `lower(substr(t.${col}, 7, 36))`)} || substr(t.${col}, 43) else t.${col} end`);
  }
  return pairs.length ? ` || jsonb_build_object(${pairs.join(", ")})` : "";
}

// One row per business day: md5 over every row of that day (minus ignored columns), in a fixed order.
// Order lines have no business or date of their own: they belong to their order's day and are
// keyed by the order's POS id, which is the same in both cafés. The source side translates links.
export function dayFingerprintSql(cfg, side = "dest") {
  const links = side === "source" ? sourceIdOverrides(cfg) : "";
  if (cfg.joinScope) {
    const row = `p.pos_order_id || ':' || ((to_jsonb(t) - $2::text[])${links})::text`;
    return `select (p.${cfg.dateColumn})::date::text as day, md5(string_agg(${row}, '|' order by ${row})) as fp from ${cfg.table} t join ${cfg.joinScope} p on t.${cfg.joinCol} = p.id where p.business_id = $1 group by 1`;
  }
  const row = `((to_jsonb(t) - $2::text[])${links})::text`;
  const filter = cfg.sourceFilter ? ` and ${cfg.sourceFilter}` : "";
  return `select (t.${cfg.dateColumn})::date::text as day, md5(string_agg(${row}, '|' order by ${row})) as fp from ${cfg.table} t where t.business_id = $1${filter} group by 1`;
}

// remapId in SQL: the same name-based UUID (version 5) the copy gives each row, using pgcrypto's sha1.
export async function defineSqlRemapId(client) {
  const { rows } = await client.query(`select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'digest' order by n.nspname = 'extensions' desc limit 1`, []);
  if (!rows.length) throw Object.assign(new Error("pgcrypto missing"), { code: "PGCRYPTO_MISSING" });
  const ns = NAMESPACE.replace(/-/g, "");
  await client.query(`create or replace function pg_temp.sync_v5(name text) returns text language sql immutable as $f$
    select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-' ||
      substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int & 3) + 1, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12)
    from (select encode(${rows[0].nspname}.digest(decode('${ns}', 'hex') || convert_to(name, 'UTF8'), 'sha1'), 'hex') as h) x $f$`, []);
}

// Days whose rows differ between source and destination, including days only one side has.
export function daysToReplace(sourceDays, destDays, force = false) {
  const days = new Set();
  for (const [day, fp] of sourceDays) if (force || destDays.get(day) !== fp) days.add(day);
  for (const day of destDays.keys()) if (force || !sourceDays.has(day)) days.add(day);
  return [...days].sort();
}

async function readDayFingerprints(client, cfg, businessId) {
  const side = businessId === SOURCE_BUSINESS_ID ? "source" : "dest";
  const { rows } = await client.query(dayFingerprintSql(cfg, side), [businessId, fingerprintIgnoredColumns(cfg)]);
  return new Map(rows.map((r) => [r.day ?? "none", r.fp]));
}

// SQL condition selecting the given dates ($2) and, when $3 is true, rows without a date.
function dayCondition(column) {
  return `((${column})::date = any($2::date[]) or ($3::boolean and ${column} is null))`;
}
const dayParams = (businessId, days) => [businessId, days.filter((d) => d !== "none"), days.includes("none")];

async function deleteDestDays(client, cfg, days) {
  const { table, joinScope, joinCol, dateColumn } = cfg;
  const params = dayParams(DEST_BUSINESS_ID, days);
  if (joinScope) {
    await client.query(`delete from ${table} where ${joinCol} in (select p.id from ${joinScope} p where p.business_id = $1 and ${dayCondition(`p.${dateColumn}`)})`, params);
  } else {
    await client.query(`delete from ${table} where business_id = $1 and ${dayCondition(dateColumn)}`, params);
  }
}

async function copySourceDays(client, cfg, days) {
  const { table, pk, joinScope, joinCol, dateColumn, conflictMode } = cfg;
  const selectSql = joinScope
    ? `select t.* from ${table} t join ${joinScope} p on t.${joinCol} = p.id where p.business_id = $1 and ${dayCondition(`p.${dateColumn}`)}`
    : `select t.* from ${table} t where t.business_id = $1 and ${dayCondition(`t.${dateColumn}`)}${cfg.sourceFilter ? ` and ${cfg.sourceFilter}` : ""}`;
  const { rows } = await client.query(selectSql, dayParams(SOURCE_BUSINESS_ID, days));
  if (rows.length === 0) return 0;
  return chunkedInsert(client, table, rows.map((row) => remapRow(table, row, cfg)), pk, conflictMode);
}

// Compares every table day by day and replaces only the days that differ, in one transaction, so a
// failure partway through never leaves the destination with some tables refreshed and others not.
export async function runDayMirrorSync(client, counts) {
  const byTable = Object.fromEntries(REFRESH_WINDOW_TABLES.map((cfg) => [cfg.table, cfg]));
  const plans = {};
  await defineSqlRemapId(client);
  for (const tableName of DAY_MIRROR_ORDER) {
    const cfg = byTable[tableName];
    const [source, dest] = [await readDayFingerprints(client, cfg, SOURCE_BUSINESS_ID), await readDayFingerprints(client, cfg, DEST_BUSINESS_ID)];
    plans[tableName] = daysToReplace(source, dest, FORCE_FULL_COPY);
  }
  // An order and its lines are one unit: replacing an order day replaces its lines too (they
  // cascade on delete), and a day whose lines differ replaces its orders as well.
  // A re-import with unchanged orders keeps the archive identical but names a new run:
  // re-copy those days so the destination's archive rows name the run its day status points at.
  plans.toast_raw_records = [...new Set([...plans.toast_raw_records, ...(await daysWithNewRun(client))])].sort();
  const orderDays = [...new Set([...plans.orders, ...plans.order_lines])].sort();
  plans.orders = orderDays;
  plans.order_lines = orderDays;

  await client.query("begin");
  try {
    for (const tableName of [...DAY_MIRROR_ORDER].reverse()) {
      if (plans[tableName].length) await deleteDestDays(client, byTable[tableName], plans[tableName]);
    }
    for (const tableName of DAY_MIRROR_ORDER) {
      counts[tableName] = plans[tableName].length ? await copySourceDays(client, byTable[tableName], plans[tableName]) : 0;
      if (plans[tableName].length) counts[`${tableName}_days`] = plans[tableName].length;
    }
    counts.toast_day_status_runs = await linkImportRuns(client);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

// The destination keeps a copy of each import run a source day points at, so the copied archive
// and day status can name the same run. Copies are always "completed": the destination has no
// Toast connection and its scheduler skips it (its mapping is never verified).
export async function syncImportRuns(client) {
  const { rows } = await client.query(
    `select r.id, r.restaurant_guid, r.kind, r.requested_from, r.requested_to, r.started_at, r.finished_at, r.days_done, r.days_total, r.orders_seen
     from toast_sync_runs r where r.business_id = $1 and r.id in (select last_import_run_id from toast_day_status where business_id = $1)`,
    [SOURCE_BUSINESS_ID]);
  const copies = rows.map((r) => ({ ...r, id: remapId("toast_sync_runs", r.id), business_id: DEST_BUSINESS_ID,
    restaurant_guid: remapId("toast_restaurant_guid", r.restaurant_guid), state: "completed" }));
  return chunkedInsert(client, "toast_sync_runs", copies, ["id"]);
}

// Days whose latest source import run differs from the run the destination's copy names.
async function daysWithNewRun(client) {
  const read = async (businessId) => (await client.query(
    `select business_date::text as day, restaurant_guid, last_import_run_id from toast_day_status where business_id = $1 and last_import_run_id is not null`,
    [businessId])).rows;
  const dest = new Map((await read(DEST_BUSINESS_ID)).map((r) => [`${r.day}|${r.restaurant_guid}`, r.last_import_run_id]));
  return [...new Set((await read(SOURCE_BUSINESS_ID))
    .filter((r) => dest.get(`${r.day}|${remapId("toast_restaurant_guid", r.restaurant_guid)}`) !== remapId("toast_sync_runs", r.last_import_run_id))
    .map((r) => r.day))];
}

// A day status is copied without its run (the database refuses an import that names a finished
// run), then pointed at the run's copy here. Only the run column changes, so no import trigger fires.
export async function linkImportRuns(client) {
  const { rows } = await client.query(
    `select business_date::text as day, restaurant_guid, last_import_run_id from toast_day_status where business_id = $1 and last_import_run_id is not null`,
    [SOURCE_BUSINESS_ID]);
  if (!rows.length) return 0;
  const result = await client.query(
    `update toast_day_status d set last_import_run_id = m.run
     from (select unnest($2::date[]) as day, unnest($3::uuid[]) as guid, unnest($4::uuid[]) as run) m
     where d.business_id = $1 and d.business_date = m.day and d.restaurant_guid = m.guid
       and d.last_import_run_id is distinct from m.run`,
    [DEST_BUSINESS_ID, rows.map((r) => r.day), rows.map((r) => remapId("toast_restaurant_guid", r.restaurant_guid)),
      rows.map((r) => remapId("toast_sync_runs", r.last_import_run_id))]);
  return result.rowCount;
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

// Every copy step, in order. `step` is told which step is running (for the error log).
export async function syncAll(client, counts, step = () => {}) {
  step("toast_api_credentials");
  await ensureToastCredentialsPlaceholder(client); // must exist before toast_location_mappings below

  for (const cfg of INSERT_IF_MISSING_TABLES) {
    step(cfg.table);
    counts[cfg.table] = await syncTable(client, cfg);
  }

  step("toast_sync_runs");
  counts.toast_sync_runs = await syncImportRuns(client); // before the archive and day status that name them

  step("day_mirror");
  await runDayMirrorSync(client, counts);

  step("timezone_and_hours");
  await syncTimezoneAndHours(client);

  step("toast_today_live");
  counts.toast_today_live = await syncTodayLive(client);
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

    await syncAll(client, counts, (name) => { currentTable = name; });

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
