#!/usr/bin/env node
// Writes supabase/seed.sql from the test café profiles (scripts/seed/cafes.mjs).
//   node scripts/seed/generateSeedSql.mjs                      window ends at the latest closed day
//   node scripts/seed/generateSeedSql.mjs --end-date 2026-11-03 --days 14
//   node scripts/seed/generateSeedSql.mjs --check              fail if seed.sql is not the generator's output
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TEST_CAFES } from "./cafes.mjs";
import { buildSeedSql, latestClosedDate, SEED_HEADER_RE } from "./seedSql.mjs";

const DEFAULT_DAYS = 14;
const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "seed.sql");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args.includes("--check")) {
  const current = existsSync(seedPath) ? readFileSync(seedPath, "utf8") : "";
  const match = current.match(SEED_HEADER_RE);
  if (!match) {
    console.error("supabase/seed.sql is missing or has no generator header. Run: node scripts/seed/generateSeedSql.mjs");
    process.exit(1);
  }
  const expected = buildSeedSql({ cafes: TEST_CAFES, endDateStr: match[1], days: Number(match[2]) });
  if (expected !== current) {
    console.error("supabase/seed.sql differs from the generator output. Run: node scripts/seed/generateSeedSql.mjs");
    process.exit(1);
  }
  console.log(`supabase/seed.sql matches the generator (end ${match[1]}, ${match[2]} days).`);
} else {
  const endDateStr = flag("--end-date") ?? latestClosedDate(TEST_CAFES);
  const days = Number(flag("--days") ?? DEFAULT_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateStr) || !Number.isInteger(days) || days < 1) {
    console.error("Usage: generateSeedSql.mjs [--end-date YYYY-MM-DD] [--days N] [--check]");
    process.exit(1);
  }
  const sql = buildSeedSql({ cafes: TEST_CAFES, endDateStr, days });
  writeFileSync(seedPath, sql);
  console.log(`Wrote supabase/seed.sql: ${TEST_CAFES.length} cafés, ${days} days ending ${endDateStr}, ${(sql.length / 1024).toFixed(0)} KB.`);
}
