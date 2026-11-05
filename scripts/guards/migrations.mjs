// New migrations use a real UTC YYYYMMDDHHmmss timestamp, e.g.
// 20261105143000_name.sql; it must sort after the newest base-branch number.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATION_DIR = "supabase/migrations/";
const VALID_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;
const NUMBER_PREFIX = /^(\d{14})_/;
const EDIT_LABEL = "migration-edit-ok";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function readMigrationTree(ref, cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-tree", "-r", "-z", ref, "--", MIGRATION_DIR], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const files = new Map();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unexpected git tree entry: ${entry.slice(0, 100)}`);
    files.set(match[3], `${match[1]}:${match[2]}`);
  }
  return files;
}

export function hasMigrationEditLabel(raw = "") {
  if (Array.isArray(raw)) return raw.some((label) => (typeof label === "string" ? label : label?.name) === EDIT_LABEL);
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return hasMigrationEditLabel(parsed);
  } catch {
    // The runner may pass a comma, space, or newline-separated label list.
  }
  return raw.split(/[,;\s]+/).includes(EDIT_LABEL);
}

function isRealUtcTimestamp(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return Number.isFinite(date.getTime()) &&
    `${date.getUTCFullYear()}`.padStart(4, "0") === value.slice(0, 4) &&
    date.getUTCMonth() + 1 === month && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

export function checkMigrations(baseFiles, headFiles, allowBaseEdits = false) {
  const errors = [];
  const report = (file, message) => errors.push(`${file}:1: ${message}`);
  const baseNumbers = [...baseFiles.keys()]
    .map((file) => NUMBER_PREFIX.exec(basename(file))?.[1])
    .filter(Boolean);
  const newestBase = baseNumbers.sort().at(-1);

  for (const file of [...headFiles.keys()].sort()) {
    if (!file.startsWith(MIGRATION_DIR)) continue;
    if (baseFiles.has(file)) {
      if (!allowBaseEdits && baseFiles.get(file) !== headFiles.get(file)) {
        report(file, "Existing migration was edited; add the migration-edit-ok PR label only if explicitly approved");
      }
      continue;
    }

    const filename = basename(file);
    const match = VALID_NAME.exec(filename);
    if (!match) {
      report(file, "New migration must be named YYYYMMDDHHmmss_lowercase_name.sql");
      continue;
    }
    const number = match[1];
    if (!isRealUtcTimestamp(number)) {
      report(file, `Migration number ${number} is not a valid UTC timestamp`);
    }
    if (newestBase && number <= newestBase) {
      report(file, `New migration number ${number} must be higher than newest base number ${newestBase}`);
    }
  }

  if (!allowBaseEdits) {
    for (const file of [...baseFiles.keys()].sort()) {
      if (!headFiles.has(file)) {
        report(file, "Existing migration was deleted; add the migration-edit-ok PR label only if explicitly approved");
      }
    }
  }

  const byNumber = new Map();
  for (const file of [...headFiles.keys()].sort()) {
    if (!file.startsWith(MIGRATION_DIR)) continue;
    const number = NUMBER_PREFIX.exec(basename(file))?.[1];
    if (!number) continue;
    const matching = byNumber.get(number) ?? [];
    matching.push(file);
    byNumber.set(number, matching);
  }
  for (const [number, files] of byNumber) {
    if (files.length < 2) continue;
    for (const file of files) {
      report(file, `Migration number ${number} is also used by ${files.filter((other) => other !== file).join(", ")}`);
    }
  }
  return errors;
}

function defaultBase(cwd, head) {
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git(["merge-base", head, candidate], cwd);
    } catch {
      // A standalone checkout may have only one of these refs.
    }
  }
  throw new Error("BASE_SHA is required when no origin/main or main merge-base exists");
}

export function runMigrationGuard(env = process.env, cwd = process.cwd()) {
  try {
    const head = env.HEAD_SHA || "HEAD";
    const base = env.BASE_SHA || defaultBase(cwd, head);
    const errors = checkMigrations(
      readMigrationTree(base, cwd),
      readMigrationTree(head, cwd),
      hasMigrationEditLabel(env.PR_LABELS),
    );
    for (const error of errors) console.error(error);
    if (errors.length) return 1;
    console.log("Migration guard passed");
    return 0;
  } catch (error) {
    console.error(`scripts/guards/migrations.mjs:1: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runMigrationGuard();
}
