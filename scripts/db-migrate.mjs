#!/usr/bin/env node
// Applies supabase/migrations/*.sql against SUPABASE_DB_URL without touching any business's data —
// unlike db-reset.mjs, this never reseeds the demo café. Use this against a database that has real
// (not just demo) businesses on it, when only a schema change needs to go out.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

loadEnvLocal();
const { SUPABASE_DB_URL } = process.env;
if (!SUPABASE_DB_URL) {
  console.log("db:migrate needs SUPABASE_DB_URL in .env.local. Skipping — nothing was changed.");
  process.exit(0);
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

const client = new Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const migrationsDir = path.join(rootDir, "supabase", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  console.log(`Applying ${files.length} migration(s) (schema only, no reseed)...`);
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await client.query(sql);
    console.log(`  ok ${file}`);
  }
  await client.query("NOTIFY pgrst, 'reload schema'");
  console.log("Done.");
} finally {
  await client.end();
}
