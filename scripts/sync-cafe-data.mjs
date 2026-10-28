#!/usr/bin/env node
// Clones / incrementally syncs café operating data from "My café" (seiyunyemenicoffee@gmail.com,
// business 0200c26e-b971-4236-ac6b-56dd191ec59b) into "Test Café" (mail2raj27@gmail.com,
// business 719af528-af8e-4203-bb25-4c118c9ff832).
//
// Deliberately excludes: AI chat/threads, owner notifications, supervisor proposals/reports,
// scheduling AI-plan audit trail, screen view analytics, and anything credential-bearing
// (pos_connections tokens, toast_api_credentials, toast_* integration sync state). Includes
// operating_tasks / operating_task_responses per explicit request (used to test alerting).
//
// Idempotent: destination ids are derived deterministically from (table, source id, dest
// business id) via uuidv5, so re-running only inserts rows that are new on the source side —
// it never updates or deletes a row already in Test Café, so test modifications are untouched.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const SOURCE_BUSINESS_ID = "0200c26e-b971-4236-ac6b-56dd191ec59b"; // My café (seiyunyemenicoffee@gmail.com)
const DEST_BUSINESS_ID = "719af528-af8e-4203-bb25-4c118c9ff832"; // Test Café (mail2raj27@gmail.com)
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // fixed uuidv5 namespace, arbitrary but stable

loadEnvLocal();

if (!process.env.SUPABASE_DB_URL) {
  console.log("sync-cafe-data needs SUPABASE_DB_URL in .env.local. Skipping — nothing was changed.");
  process.exit(0);
}

// Each entry: table name, whether it carries business_id directly (false => scoped via join),
// the primary-key columns (post-remap) used for ON CONFLICT, which columns need deterministic
// id remapping (own id, or FKs into other remapped tables), and any columns to null out because
// their target isn't being cloned (e.g. an AI scheduling proposal that doesn't exist in dest).
const TABLES = [
  t("locations", { remapOwnId: true }),
  t("ingredients", { remapOwnId: true }),
  t("menu_items", { remapOwnId: true }),
  t("employees", { remapOwnId: true }),
  t("recurring_costs", { remapOwnId: true }),
  t("recovery_order", { pk: ["business_id", "bucket_code"] }),
  t("staff_schedules", { remapOwnId: true }),
  t("scheduling_qualification_types", { remapOwnId: true }),
  t("ingredient_prices", { remapOwnId: true, joinScope: "ingredients", joinCol: "ingredient_id", fk: { ingredient_id: "ingredients" } }),
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
  t("employee_sales_rollup", { pk: ["business_id", "business_date", "employee_id"], fk: { employee_id: "employees" } }),
  t("pos_scheduled_shifts", { pk: ["business_id", "provider", "external_shift_id"], fk: { location_id: "locations" } }),
  t("timecards", { remapOwnId: true, fk: { employee_id: "employees", schedule_id: "staff_schedules" } }),
  t("orders", { remapOwnId: true, fk: { location_id: "locations", employee_id: "employees", superseded_by: "orders" } }),
  t("order_lines", { remapOwnId: true, joinScope: "orders", joinCol: "order_id", fk: { order_id: "orders", menu_item_id: "menu_items" } }),
  t("hourly_sales_rollup", { pk: ["business_id", "business_date", "hour_local"] }),
  t("daily_rollups", { pk: ["business_id", "business_date"] }),
  t("expenses", { remapOwnId: true, fk: { recurring_cost_id: "recurring_costs" } }),
  t("expense_lines", { remapOwnId: true, joinScope: "expenses", joinCol: "expense_id", fk: { expense_id: "expenses", ingredient_id: "ingredients" } }),
  t("vendor_rules", { pk: ["business_id", "normalized_vendor"] }),
  t("uploads", { remapOwnId: true }),
  t("processing_fee_daily_candidates", { pk: ["business_id", "business_date", "source_type", "provider"] }),
  t("processing_fee_daily_facts", { pk: ["business_id", "business_date"] }),
  t("processing_fee_rate_plans", { remapOwnId: true }),
  t("product_photos", { remapOwnId: true, fk: { anchor_menu_item_id: "menu_items" } }),
  t("pantry_stock_counts", { remapOwnId: true, fk: { ingredient_id: "ingredients" } }),
  t("pantry_stock_purchases", { remapOwnId: true, fk: { ingredient_id: "ingredients", expense_line_id: "expense_lines" } }),
  t("pantry_modifier_links", { pk: ["business_id", "provider", "location_ref", "pos_modifier_id"], fk: { modifier_recipe_id: "modifier_recipes" } }),
  t("operating_tasks", { pk: ["business_id", "id"] }),
  t("operating_task_responses", { remapOwnId: true, fk: { employee_id: "employees" } }),
];

function t(table, opts = {}) {
  return {
    table,
    pk: opts.pk ?? ["id"],
    remapOwnId: opts.remapOwnId ?? false,
    fk: opts.fk ?? {},
    nullOut: opts.nullOut ?? [],
    joinScope: opts.joinScope ?? null, // parent table to scope by, for tables with no business_id column
    joinCol: opts.joinCol ?? null, // this table's column that references joinScope.id
  };
}

function uuidv5(name) {
  const namespaceBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = crypto.createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function remapId(targetTable, sourceId) {
  return uuidv5(`${DEST_BUSINESS_ID}|${targetTable}|${sourceId}`);
}

loadEnvLocal();

await main();

async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    let totalInserted = 0;
    for (const cfg of TABLES) {
      const inserted = await syncTable(client, cfg);
      if (inserted > 0) console.log(`  ✓ ${cfg.table}: ${inserted} new row(s)`);
      totalInserted += inserted;
    }
    console.log(`\n✅ sync complete. ${totalInserted} new row(s) copied from My café → Test Café.`);
  } finally {
    await client.end();
  }
}

async function syncTable(client, cfg) {
  const { table, pk, remapOwnId, fk, nullOut, joinScope, joinCol } = cfg;

  let selectSql;
  let params;
  if (joinScope) {
    selectSql = `select t.* from ${table} t join ${joinScope} p on t.${joinCol} = p.id where p.business_id = $1`;
    params = [SOURCE_BUSINESS_ID];
  } else {
    selectSql = `select * from ${table} where business_id = $1`;
    params = [SOURCE_BUSINESS_ID];
  }

  const { rows } = await client.query(selectSql, params);
  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0]);
  const remappedRows = rows.map((row) => {
    const out = { ...row };
    if (columns.includes("business_id")) out.business_id = DEST_BUSINESS_ID;
    if (remapOwnId) out.id = remapId(table, row.id);
    for (const [col, targetTable] of Object.entries(fk)) {
      if (out[col] != null) out[col] = remapId(targetTable, row[col]);
    }
    for (const col of nullOut) out[col] = null;
    return out;
  });

  const pkColumns = pk.map((c) => (c === "id" && remapOwnId ? "id" : c));
  const chunkSize = Math.max(1, Math.floor(1000 / columns.length)); // stay well under postgres's 65535 bind-param limit
  let inserted = 0;
  for (let i = 0; i < remappedRows.length; i += chunkSize) {
    const chunk = remappedRows.slice(i, i + chunkSize);
    const placeholders = [];
    const values = [];
    let p = 1;
    for (const row of chunk) {
      const rowPlaceholders = columns.map(() => `$${p++}`);
      placeholders.push(`(${rowPlaceholders.join(",")})`);
      for (const c of columns) values.push(toParam(row[c]));
    }
    const sql = `insert into ${table} (${columns.join(",")}) values ${placeholders.join(",")} on conflict (${pkColumns.join(",")}) do nothing`;
    const result = await client.query(sql, values);
    inserted += result.rowCount;
  }
  return inserted;
}

function toParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || (typeof value === "object" && !(value instanceof Date))) return JSON.stringify(value);
  return value;
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
