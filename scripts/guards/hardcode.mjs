#!/usr/bin/env node
/** Reject newly introduced café-specific literals; never rescan or rewrite legacy source. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowlist = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hardcode-allowlist.json'), 'utf8'));
const currencies = new Set(Intl.supportedValuesOf('currency'));
const notice = 'read it from businesses.currency / the cafe timezone setting';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function baseRef() {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  for (const candidate of ['origin/main', 'main']) {
    try { git('rev-parse', '--verify', candidate + '^{commit}'); return candidate; }
    catch { /* Try the other default ref. */ }
  }
  throw new Error('set BASE_SHA to the base commit (or fetch main)');
}

function inScope(file) {
  return /^(?:app|lib|components)\//.test(file) &&
    /\.(?:[cm]?[jt]sx?)$/.test(file) &&
    !/(?:^|\/)(?:__tests__|__fixtures__|fixtures)(?:\/|$)/i.test(file) &&
    !/(?:\.(?:test|spec|stories|fixture)|(?:^|\/)test-)[.\/-]/i.test(file);
}

function violations(line) {
  const hits = new Set();
  // Exact ISO-4217 codes, not arbitrary 3-letter words such as GET or POS.
  for (const match of line.matchAll(/(['"`])([A-Z]{3})\1/g)) {
    if (currencies.has(match[2])) hits.add('currency-code');
  }
  if (/\bcurrency\s*:\s*(['"`])[^'"`\r\n]*\1/.test(line)) hits.add('currency-literal');
  // $12, "$", or a literal dollar preceding a template interpolation ($${amount}).
  if (/(?<!\\)\$\d|(?<!\\)\$\$\{|(['"`])\$\1/.test(line)) hits.add('money-symbol');
  if (/(?:America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian|Antarctica)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)*/.test(line)) hits.add('iana-timezone');
  if (/(['"`])UTC\1/.test(line)) hits.add('utc-timezone');
  if (/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.test(line)) hits.add('uuid');
  return [...hits];
}

/** Parse the zero-context unified diff, tracking new-file line numbers. */
function check(diff) {
  const errors = [];
  let file = '', lineNumber = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { file = ''; inHunk = false; continue; }
    if (!inHunk && line.startsWith('+++ ')) {
      // Git quotes paths containing control characters; fail closed on them.
      const path = line.slice(4);
      if (path.startsWith('\"')) throw new Error('quoted diff path is unsupported');
      file = path.startsWith('b/') ? path.slice(2) : '';
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { lineNumber = Number(hunk[1]); inHunk = true; continue; }
    if (!file || !inScope(file)) continue;
    if (line.startsWith('+')) {
      const added = line.slice(1);
      // An exception requires a reason on the same added line.
      if (!/\/\/\s*hardcode-ok:\s*\S/.test(added)) {
        const allowed = allowlist.paths[file]?.rules ?? [];
        if (violations(added).some(rule => !allowed.includes(rule))) {
          errors.push(`${file}:${lineNumber}: ${notice}`);
        }
      }
      lineNumber++;
    } else if (line.startsWith(' ')) lineNumber++;
  }
  return errors;
}

try {
  const base = baseRef();
  const head = process.env.HEAD_SHA || 'HEAD';
  // PR_LABELS is supplied by the runner but never disables this safety check.
  const diff = git('diff', '--no-ext-diff', '--no-color', '--unified=0', '--find-renames', `${base}...${head}`, '--', 'app/', 'lib/', 'components/');
  const errors = check(diff);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('No new café-specific hardcodes found.');
} catch (error) {
  console.error(`scripts/guards/hardcode.mjs:1: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
