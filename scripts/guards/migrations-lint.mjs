#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!/^[0-9a-f]{40}$/i.test(base ?? '') || !/^[0-9a-f]{40}$/i.test(head ?? '')) {
  console.error('scripts/guards/migrations-lint.mjs:1: BASE_SHA and HEAD_SHA must be commit SHAs');
  process.exit(1);
}

const changed = spawnSync('git', [
  'diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACMRT',
  base, head, '--', 'supabase/migrations/',
], { encoding: 'utf8' });
if (changed.error || changed.status !== 0) {
  console.error('scripts/guards/migrations-lint.mjs:1: cannot compare migration changes:',
    changed.error?.message ?? changed.stderr.trim());
  process.exit(1);
}

const migrations = changed.stdout.split('\0')
  .filter((path) => /^supabase\/migrations\/[^/]+\.sql$/.test(path));
if (migrations.length === 0) {
  console.log('migrations-lint: no newly added or changed SQL migrations');
  process.exit(0);
}

let invalid = false;
for (const path of migrations) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*--\s*squawk-(?:ignore-file|disable-assume-in-transaction)\b/i.test(line)) {
      console.error(`${path}:${index + 1}: file-wide Squawk bypasses are forbidden`);
      invalid = true;
    }
    const ignore = line.match(/^\s*--\s*squawk-ignore\b(.*)$/i);
    if (!ignore) continue;
    const ruleNames = ignore[1].trim();
    if (!/^[a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*$/.test(ruleNames)) {
      console.error(`${path}:${index + 1}: name the individual Squawk rule(s) to ignore`);
      invalid = true;
    }
    if (!/^\s*--\s*Reason:\s*\S.+$/i.test(lines[index - 1] ?? '')) {
      console.error(`${path}:${index + 1}: add one '-- Reason: ...' line immediately above the ignore`);
      invalid = true;
    }
  }
}
if (invalid) process.exit(1);

const binary = resolve('node_modules', '.bin', process.platform === 'win32' ? 'squawk.cmd' : 'squawk');
const result = spawnSync(binary, ['--config', '.squawk.toml', '--reporter', 'gcc', ...migrations], {
  stdio: 'inherit',
});
if (result.error) {
  console.error('scripts/guards/migrations-lint.mjs:1: squawk-cli is not installed; run npm ci');
  process.exit(1);
}
if (result.status !== 0) process.exitCode = result.status ?? 1;
else console.log(`migrations-lint: passed ${migrations.length} changed SQL file(s)`);
