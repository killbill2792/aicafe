#!/usr/bin/env node
/**
 * P0 source authority: a diagnostic Toast capture must never become an
 * operational Supervisor, screen or café-mirror source.
 *
 * Diff-only until POS0e removes the known legacy canonical dependencies.
 * The POS0e cutover must also add a final-schema SQL lineage assertion,
 * because unchanged historical migrations cannot be checked by a diff guard.
 * Historical migrations are immutable and only diagnostic implementations
 * (not live readers) may continue maintaining the investigation table.
 */
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DIAGNOSTIC_REFERENCE =
  /\b(?:toast_raw_samples(?:_latest)?|toast_raw_sample_leases|toast_claim_raw_sample|toast_acquire_raw_sample_lease|captureToastRawSample)\b/;
const DIAGNOSTIC_IMPLEMENTATIONS = new Set([
  'lib/pos/toast/rawSample.server.ts',
  'lib/pos/toast/rawSample.test.ts',
  'lib/pos/toast/dailyCapture.server.ts',
  'lib/pos/toast/dailyCapture.ts',
  'scripts/toast-raw-capture-daily.ts',
  'scripts/toast-raw-sample-sql-integration.sql',
]);

export function isOperationalSource(path) {
  if (DIAGNOSTIC_IMPLEMENTATIONS.has(path)) return false;
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(path)) return true;
  if (/^(?:app|lib|components)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path)) {
    if (/(?:^|\/)(?:__tests__|fixtures|__fixtures__)\//.test(path) ||
        /\.(?:test|spec|fixture|stories)\.[cm]?[jt]sx?$/.test(path)) return false;
    return true;
  }
  if (/^scripts\//.test(path) && /\.(?:mjs|cjs|js|ts|sql)$/.test(path)) {
    if (/^scripts\/(?:guards\/|.*(?:test|spec|fixture|diagnostic|raw-sample)[.\/-])/.test(path)) return false;
    return true;
  }
  return false;
}

export function addedDiagnosticReferences(diff) {
  const violations = [];
  let file = '', lineNumber = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = ''; inHunk = false; continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const raw = line.slice(4);
      if (raw.startsWith('"')) throw new Error('Quoted Git diff paths require review');
      file = raw.startsWith('b/') ? raw.slice(2) : '';
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNumber = Number(hunk[1]); inHunk = true; continue;
    }
    if (!file || !inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const added = line.slice(1);
      if (isOperationalSource(file) && DIAGNOSTIC_REFERENCE.test(added)) {
        violations.push(`${file}:${lineNumber}: diagnostic Toast capture is NOT an operational source; use current keyed records + the existing shared reader (docs/rules/pos-data.md)`);
      }
      lineNumber++;
    } else if (line.startsWith(' ')) lineNumber++;
  }
  return violations;
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function baseRef(head) {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  for (const ref of ['origin/main', 'main']) {
    try { return git('merge-base', ref, head); }
    catch { /* Attempt next base ref. */ }
  }
  throw new Error('Missing PR base: set BASE_SHA or fetch main');
}

/** A removed automatic investigation cron must not quietly return under a new PR. */
function workflowErrors(head) {
  const paths = git('ls-tree', '-r', '--name-only', head, '--', '.github/workflows/')
    .split('\n').filter(Boolean);
  const errors = [];
  const retired = '.github/workflows/toast-raw-capture-daily.yml';
  if (paths.includes(retired)) {
    errors.push(`${retired}:1: retired scheduled diagnostic workflow must not be reintroduced; manual-only naming is required`);
  }
  for (const path of paths.filter(p => /toast[-_](?:diagnostic|raw[-_]capture)/i.test(p))) {
    const body = git('show', `${head}:${path}`);
    if (/^\s*schedule\s*:/m.test(body)) {
      errors.push(`${path}:1: Toast API diagnostics must be manual-only; never schedule test captures as business ingestion`);
    }
  }
  return errors;
}

export function run() {
  try {
    const head = process.env.HEAD_SHA || 'HEAD';
    const base = baseRef(head);
    const diff = git('diff', '--no-ext-diff', '--no-color',
      '--unified=0', '--no-renames', `${base}...${head}`);
    const errors = [...addedDiagnosticReferences(diff), ...workflowErrors(head)];
    if (errors.length) {
      for (const message of errors) console.error(message);
      return 1;
    }
    console.log('Toast diagnostic source boundary: no newly introduced operational dependencies');
    return 0;
  } catch (error) {
    console.error(`scripts/guards/toast-diagnostic-boundary.mjs:1: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
