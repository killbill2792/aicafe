#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { generateDemoData } from "./seed/demoData.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DEMO_BUSINESS_ID = "11111111-1111-1111-1111-111111111111";
const DEMO_LOGIN_EMAIL = "demo@cafeprofit.app";

loadEnvLocal();

const {
  SUPABASE_DB_URL,
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_DB_URL || !NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    "db:reset needs SUPABASE_DB_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local " +
      "(see the credentials list in PROGRESS.md → \"Needs connecting\"). Skipping — nothing was changed.",
  );
  process.exit(0);
}

await main();

async function main() {
  const client = new Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await applyMigrations(client);
    await reseedDemoBusiness(client);
    await ensureDemoLoginUser();
    console.log("\n✅ db:reset complete. Demo café is seeded; log in as demo@cafeprofit.app (magic link) to see it.");
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

async function applyMigrations(client) {
  const migrationsDir = path.join(rootDir, "supabase", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  console.log(`Applying ${files.length} migration(s)...`);
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await client.query(sql);
    console.log(`  ✓ ${file}`);
  }
  // Applying SQL directly over `pg` (no Supabase CLI in this environment) skips the automatic
  // schema-cache reload the CLI would trigger — without this, a migration that adds a new table,
  // column, or RPC function 404s from PostgREST for a while even though it already exists in
  // Postgres. Found the hard way after 20260928000013 added an RPC function.
  await client.query("NOTIFY pgrst, 'reload schema'");
}

async function reseedDemoBusiness(client) {
  console.log("Reseeding demo café...");
  // Cascades to every child row (locations, orders, expenses, ...) via `on delete cascade`.
  await client.query("delete from businesses where id = $1", [DEMO_BUSINESS_ID]);

  const today = new Date().toISOString().slice(0, 10);
  const data = generateDemoData({ businessId: DEMO_BUSINESS_ID, endDateStr: today, days: 90 });

  await insertRows(client, "businesses",
    ["id", "name", "timezone", "currency", "payroll_tax_rate", "default_language", "opened_on", "is_demo"],
    [data.business]);
  await insertRows(client, "locations",
    ["id", "business_id", "name", "pos_location_id", "open_hours"],
    [data.location]);
  await insertRows(client, "pos_connections",
    ["id", "business_id", "provider", "merchant_id", "access_token_enc", "refresh_token_enc", "token_expires_at", "status", "last_synced_at", "backfill_completed_at"],
    [data.posConnection]);
  await insertRows(client, "ingredients",
    ["id", "business_id", "name", "base_unit", "icon"], data.ingredients);
  await insertRows(client, "menu_items",
    ["id", "business_id", "pos_item_id", "name", "price_cents", "category", "prep_seconds", "is_active"], data.menuItems);
  await insertRows(client, "employees",
    ["id", "business_id", "pos_team_member_id", "display_name", "role"], data.employees);
  await insertRows(client, "recurring_costs",
    ["id", "business_id", "category_code", "label", "amount_cents", "frequency", "due_day", "is_estimate", "active_from", "active_to"],
    data.recurringCosts);
  await insertRows(client, "recovery_order",
    ["business_id", "bucket_code", "position"], data.recoveryOrder);
  await insertRows(client, "ingredient_prices",
    ["id", "ingredient_id", "effective_from", "cost_per_base_unit_micros", "source", "source_expense_line_id"],
    data.ingredientPrices);
  await insertRows(client, "recipe_lines",
    ["menu_item_id", "ingredient_id", "quantity"], data.recipeLines);
  await insertRows(client, "orders",
    ["id", "business_id", "location_id", "pos_order_id", "closed_at", "business_date", "gross_sales_cents", "discounts_cents", "refunds_cents", "tax_cents", "tip_cents", "processing_fee_cents", "net_sales_cents", "customer_ref"],
    data.orders);
  await insertRows(client, "order_lines",
    ["id", "order_id", "menu_item_id", "pos_item_id", "name", "quantity", "net_sales_cents", "modifiers", "voided", "voided_by"],
    data.orderLines);
  await insertRows(client, "timecards",
    ["id", "business_id", "employee_id", "pos_timecard_id", "clock_in", "clock_out", "hourly_wage_cents", "breaks"],
    data.timecards);
  await insertRows(client, "daily_rollups",
    ["business_id", "business_date", "net_sales_cents", "orders_count", "drinks_count", "ingredients_cents", "staff_wages_cents", "staff_tax_cents", "card_fees_cents", "voids_cents"],
    data.dailyRollups);
  await insertRows(client, "expenses",
    ["id", "business_id", "spent_on", "amount_cents", "vendor", "category_code", "source", "status", "recurring_cost_id", "confidence", "reason", "attachment_path", "dedupe_key"],
    data.expenses);
  await insertRows(client, "expense_lines",
    ["id", "expense_id", "description", "quantity", "unit", "amount_cents", "ingredient_id"],
    data.expenseLines);

  console.log(
    `  ✓ ${data.orders.length} orders, ${data.orderLines.length} order lines, ${data.timecards.length} timecards, ` +
      `${data.expenses.length} expenses over ${data.startDateStr}..${data.endDateStr}`,
  );
}

async function ensureDemoLoginUser() {
  console.log("Ensuring demo login user...");
  const admin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: DEMO_LOGIN_EMAIL,
    email_confirm: true,
  });

  if (created?.user) {
    userId = created.user.id;
  } else if (createError) {
    // Already exists from a previous db:reset — look it up instead.
    const { data: list, error: listError } = await admin.auth.admin.listUsers();
    if (listError) throw listError;
    const existing = list.users.find((u) => u.email === DEMO_LOGIN_EMAIL);
    if (!existing) throw createError;
    userId = existing.id;
  }

  const { error: membershipError } = await admin
    .from("memberships")
    .upsert(
      { business_id: DEMO_BUSINESS_ID, user_id: userId, role: "owner", can_see_profit: true },
      { onConflict: "business_id,user_id" },
    );
  if (membershipError) throw membershipError;
  console.log(`  ✓ ${DEMO_LOGIN_EMAIL} is owner of the demo café`);
}

function toParam(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return value;
}

async function insertRows(client, table, columns, rows, chunkSize = 500) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, rIdx) => {
      const cols = columns.map((col, cIdx) => {
        values.push(toParam(row[col]));
        return `$${rIdx * columns.length + cIdx + 1}`;
      });
      return `(${cols.join(",")})`;
    });
    const sql = `insert into ${table} (${columns.join(",")}) values ${placeholders.join(",")}`;
    await client.query(sql, values);
  }
}
