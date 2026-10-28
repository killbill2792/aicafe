#!/usr/bin/env node
// Scans supabase/migrations/*.sql for declared PRIMARY KEY / UNIQUE constraints (inline in
// CREATE TABLE, ALTER TABLE ... ADD CONSTRAINT, and CREATE UNIQUE INDEX), so other code can
// verify a configured ON CONFLICT target actually corresponds to a real constraint rather than
// one that only happens to exist on a particular live database (schema drift untracked by
// migrations breaks on any fresh deploy, CI database, or disaster-recovery restore).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function normalizeColumns(raw) {
  return raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function addConstraint(map, table, columns) {
  const key = table.toLowerCase().replace(/^public\./, "");
  const cols = normalizeColumns(columns);
  if (cols.length === 0) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(cols);
}

// Finds `create table ... tableName (` occurrences and returns [{ table, body }], where body is
// the exact text between the matching parens (paren-depth scanned, not regex-bounded, since
// column definitions commonly contain their own nested parens, e.g. check (...) or numeric(10,2)).
function extractCreateTableBlocks(sql) {
  const blocks = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_.]+)\s*\(/gi;
  let match;
  while ((match = re.exec(sql))) {
    const table = match[1];
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    blocks.push({ table, body: sql.slice(start, i - 1) });
  }
  return blocks;
}

// Splits a CREATE TABLE body into its column/constraint definitions on top-level commas only
// (parens from check(...), numeric(10,2), default exprs, etc. must not be split on).
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const RESERVED_LEADING_WORDS = new Set(["primary", "unique", "foreign", "check", "constraint", "like", "exclude"]);

// A single-column inline constraint has no parens at all, e.g. `id uuid primary key default ...`
// or `code text unique`. Table-level constraint clauses (unique(...), primary key(...), etc. —
// already handled elsewhere) start with a reserved keyword instead of a column name, so they're
// explicitly excluded here to avoid double-counting or misreading them as a column named "unique".
function extractInlineSingleColumnConstraints(body, map, table) {
  for (const def of splitTopLevel(body)) {
    const firstWord = def.split(/\s+/)[0]?.toLowerCase();
    if (!firstWord || RESERVED_LEADING_WORDS.has(firstWord)) continue;
    if (/\bprimary\s+key\b/i.test(def) || /\bunique\b/i.test(def)) {
      addConstraint(map, table, firstWord);
    }
  }
}

export function extractUniqueConstraints(migrationsDir) {
  const map = new Map();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");

    for (const { table, body } of extractCreateTableBlocks(sql)) {
      for (const m of body.matchAll(/primary\s+key\s*\(([^)]*)\)/gi)) addConstraint(map, table, m[1]);
      for (const m of body.matchAll(/(?<!add\s+constraint\s+\S+\s+)unique\s*\(([^)]*)\)/gi)) addConstraint(map, table, m[1]);
      extractInlineSingleColumnConstraints(body, map, table);
    }

    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_.]+)\s+add\s+constraint\s+\S+\s+(?:primary\s+key|unique)\s*\(([^)]*)\)/gi)) {
      addConstraint(map, m[1], m[2]);
    }

    for (const m of sql.matchAll(/create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+([a-zA-Z0-9_.]+)\s*\(([^)]*)\)/gi)) {
      addConstraint(map, m[1], m[2]);
    }
  }

  return map;
}
