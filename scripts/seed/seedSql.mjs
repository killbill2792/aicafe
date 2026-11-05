import { generateDemoData, addDays } from "./demoData.mjs";

/** Rows from generateDemoData() and the columns each table gets, in insert order. */
export const SEED_TABLES = [
  ["businesses", "business", ["id", "name", "timezone", "currency", "payroll_tax_rate", "default_language", "opened_on", "is_demo"]],
  ["locations", "location", ["id", "business_id", "name", "pos_location_id", "open_hours"]],
  ["pos_connections", "posConnection", ["id", "business_id", "provider", "merchant_id", "access_token_enc", "refresh_token_enc", "token_expires_at", "status", "last_synced_at", "backfill_completed_at"]],
  ["ingredients", "ingredients", ["id", "business_id", "name", "base_unit", "icon"]],
  ["menu_items", "menuItems", ["id", "business_id", "pos_item_id", "name", "base_name", "price_cents", "category", "prep_seconds", "is_active"]],
  ["employees", "employees", ["id", "business_id", "pos_team_member_id", "display_name", "role"]],
  ["recurring_costs", "recurringCosts", ["id", "business_id", "category_code", "label", "amount_cents", "frequency", "due_day", "is_estimate", "active_from", "active_to"]],
  ["recovery_order", "recoveryOrder", ["business_id", "bucket_code", "position"]],
  ["ingredient_prices", "ingredientPrices", ["id", "ingredient_id", "effective_from", "cost_per_base_unit_micros", "source", "source_expense_line_id"]],
  ["recipe_lines", "recipeLines", ["menu_item_id", "ingredient_id", "quantity"]],
  ["orders", "orders", ["id", "business_id", "location_id", "pos_order_id", "closed_at", "business_date", "gross_sales_cents", "discounts_cents", "refunds_cents", "tax_cents", "tip_cents", "processing_fee_cents", "processing_fee_status", "processing_fee_provider", "net_sales_cents", "customer_ref"]],
  ["order_lines", "orderLines", ["id", "order_id", "menu_item_id", "pos_item_id", "name", "quantity", "net_sales_cents", "modifiers", "voided", "voided_by"]],
  ["timecards", "timecards", ["id", "business_id", "employee_id", "pos_timecard_id", "clock_in", "clock_out", "hourly_wage_cents", "breaks"]],
  ["processing_fee_daily_candidates", "processingFeeDailyCandidates", ["business_id", "business_date", "source_type", "provider", "amount_cents", "status", "source_reference", "metadata", "eligible"]],
  ["processing_fee_daily_facts", "processingFeeDailyFacts", ["business_id", "business_date", "amount_cents", "status", "source_type", "provider", "source_reference", "metadata"]],
  ["daily_rollups", "dailyRollups", ["business_id", "business_date", "net_sales_cents", "orders_count", "drinks_count", "ingredients_cents", "staff_wages_cents", "staff_tax_cents", "card_fees_cents", "card_fees_status", "voids_cents"]],
  ["expenses", "expenses", ["id", "business_id", "spent_on", "amount_cents", "vendor", "category_code", "source", "status", "recurring_cost_id", "confidence", "reason", "attachment_path", "dedupe_key"]],
  ["expense_lines", "expenseLines", ["id", "expense_id", "description", "quantity", "unit", "amount_cents", "ingredient_id"]],
];

export const SEED_HEADER_RE = /^-- end_date: (\d{4}-\d{2}-\d{2}); days: (\d+)$/m;

function literal(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`seed value is not a finite number: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replaceAll("'", "''")}'`;
}

function insertSql(table, columns, rows, chunkSize = 500) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const values = rows.slice(i, i + chunkSize).map((row) => `(${columns.map((c) => literal(row[c])).join(",")})`);
    out.push(`insert into public.${table} (${columns.join(",")}) values\n${values.join(",\n")};`);
  }
  return out.join("\n");
}

function ownerSql(cafe) {
  const { userId, email, password } = cafe.owner;
  const identity = JSON.stringify({ sub: userId, email, email_verified: true });
  return `-- Owner login for ${cafe.name} (local stack only): ${email}
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', ${literal(userId)}, 'authenticated', 'authenticated', ${literal(email)},
  extensions.crypt(${literal(password)}, extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (${literal(userId)}, ${literal(userId)}, ${literal(userId)}, 'email', ${literal(identity)}, now(), now(), now());
insert into public.memberships (business_id, user_id, role, can_see_profit)
values (${literal(cafe.businessId)}, ${literal(userId)}, 'owner', true);`;
}

function cafeSql(cafe, endDateStr, days) {
  const data = generateDemoData({ businessId: cafe.businessId, endDateStr, days, cafe });
  const parts = [`-- ===== ${cafe.name} (${cafe.currency}, ${cafe.timezone}) =====`];
  for (const [table, key, columns] of SEED_TABLES) {
    const rows = Array.isArray(data[key]) ? data[key] : [data[key]];
    if (rows.length > 0) parts.push(insertSql(table, columns, rows));
    if (table === "businesses") {
      // A new café starts with expired access (initialize_cafe_access trigger); test cafés get full access.
      parts.push(`insert into public.cafe_access (business_id, mode, code_id, access_end, updated_at)
values (${literal(cafe.businessId)}, 'grandfathered', null, null, now())
on conflict (business_id) do update set mode = 'grandfathered', code_id = null, access_end = null, updated_at = now();`);
    }
  }
  parts.push(ownerSql(cafe));
  return parts.join("\n");
}

/** The full supabase/seed.sql text for the given cafés and window. Same inputs, same text. */
export function buildSeedSql({ cafes, endDateStr, days }) {
  const header = [
    "-- GENERATED FILE. Do not edit by hand.",
    "-- Regenerate: node scripts/seed/generateSeedSql.mjs   Check: node scripts/seed/generateSeedSql.mjs --check",
    "-- Source: scripts/seed/cafes.mjs (café profiles) + scripts/seed/demoData.mjs (generator).",
    `-- Test cafés: ${cafes.map((c) => `${c.name} (${c.currency}, ${c.timezone}) owner ${c.owner.email}`).join("; ")}.`,
    `-- end_date: ${endDateStr}; days: ${days}`,
    `-- Window: ${addDays(endDateStr, -(days - 1))} .. ${endDateStr} (café local business dates).`,
  ].join("\n");
  return `${header}\n\n${cafes.map((cafe) => cafeSql(cafe, endDateStr, days)).join("\n\n")}\n`;
}

/** The newest business date that is already closed in every café (yesterday in the café furthest behind). */
export function latestClosedDate(cafes, now = new Date()) {
  const todays = cafes.map((cafe) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: cafe.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now));
  return addDays(todays.sort()[0], -1);
}
