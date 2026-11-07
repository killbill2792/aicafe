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
  /\b(?:toast_raw_samples(?:_latest)?|toast_raw_sample_leases|toast_claim_raw_sample|toast_acquire_raw_sample_lease|captureToastRawSample|rawSample(?:\.server)?)\b/;
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
  // Coding-agent instructions mention these names as warnings; they are not data readers.
  if (path.startsWith('scripts/dev-dispatcher/')) return false;
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

/** Validate actual YAML trigger shape, not just absence of the word "schedule".
 * A literal \\n in `on:` used to pass the old grep-only guard. Only manual dispatch
 * is allowed for diagnostic captures; malformed/missing/mixed triggers fail closed. */
export function diagnosticWorkflowTriggerErrors(body, path) {
  const errors = [];
  const onLines = [...body.matchAll(/^on:[ \t]*(?:#.*)?$/gm)];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => /^on:[ \t]*(?:#.*)?$/.test(line));
  const events = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) break;
      const event = /^  ([a-zA-Z_][a-zA-Z0-9_-]*):(?:\s|$)/.exec(line);
      if (event) events.push(event[1]);
      else if (/^\s{1,2}\S/.test(line)) events.push('malformed');
    }
  }
  if (onLines.length !== 1 || events.length !== 1 || events[0] !== 'workflow_dispatch') {
    errors.push(`${path}:1: Toast diagnostic workflow must have a valid YAML on: mapping with workflow_dispatch as its ONLY trigger`);
  }
  if (/^\s*schedule\s*:/m.test(body)) {
    errors.push(`${path}:1: Toast API diagnostics must be manual-only; never schedule test captures as business ingestion`);
  }
  return errors;
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
    errors.push(...diagnosticWorkflowTriggerErrors(body, path));
  }
  return errors;
}

/** New diagnostic-only executables and migrations must say diagnostic/diag in the name.
 * This is a naming guard, NOT permission for a diagnostic source to feed business queries.
 * Historical ambiguous filenames are preserved until separately retired. */
export function diagnosticNamingErrors(base, head) {
  const changed = git('diff', '--name-only', '--diff-filter=A', '-z', `${base}...${head}`, '--',
    'app/', 'lib/', 'scripts/', '.github/workflows/', 'supabase/migrations/')
    .split('\0').filter(Boolean);
  const problems = [];
  for (const path of changed) {
    if (!/\.(?:[cm]?[jt]sx?|mjs|cjs|sql|ya?ml)$/.test(path)) continue;
    const body = git('show', `${head}:${path}`);
    if (!/\bDIAGNOSTIC_ONLY\b/.test(body)) continue;
    const filename = path.split('/').pop() ?? '';
    if (!/(?:diag|diagnostic)/i.test(filename)) {
      problems.push(`${path}:1: DIAGNOSTIC_ONLY source must be named with diag/diagnostic; cannot look like operational code`);
    }
  }
  return problems;
}

export function run() {
  try {
    const head = process.env.HEAD_SHA || 'HEAD';
    const base = baseRef(head);
    const diff = git('diff', '--no-ext-diff', '--no-color',
      '--unified=0', '--no-renames', `${base}...${head}`);
    const errors = [...addedDiagnosticReferences(diff), ...workflowErrors(head), ...diagnosticNamingErrors(base, head)];
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
