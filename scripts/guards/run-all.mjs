#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressUpdatePolicy } from '../dev-dispatcher/core.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const guards = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== 'run-all.mjs')
  .map((entry) => entry.name)
  .sort();

if (guards.length === 0) {
  console.log('No guard scripts found; guards pass.');
  process.exit(0);
}

const env = {
  ...process.env,
  BASE_SHA: process.env.BASE_SHA ?? '',
  HEAD_SHA: process.env.HEAD_SHA ?? '',
  PR_LABELS: process.env.PR_LABELS ?? '',
};
let failures = 0;

// This existing guard runs with exact base/head commits in PR CI.
// No parallel coding PR may change the shared PROGRESS checklist; a dedicated
// coordinator-only PR updates it after merge, on top of latest main.
const shaPattern=/^[a-f0-9]{40}$/;
if (shaPattern.test(env.BASE_SHA) && shaPattern.test(env.HEAD_SHA) &&
    env.BASE_SHA !== env.HEAD_SHA) {
  const diff=spawnSync('git',['diff','--name-only','-z',`${env.BASE_SHA}...${env.HEAD_SHA}`],
    {cwd:process.cwd(),encoding:'utf8'});
  if (diff.error || diff.status!==0) {
    console.error('PROGRESS.md:1: Cannot verify changed paths for single-writer progress rule');
    failures++;
  } else {
    const changed=diff.stdout.split('\0').filter(Boolean);
    const policy=progressUpdatePolicy(changed);
    if (!policy.allowed) {
      console.error('PROGRESS.md:1: Shared PROGRESS.md may only change in a dedicated single-writer progress-only PR after merge');
      failures++;
    } else {
      console.log('Shared progress single-writer guard: passed');
    }
  }
}
const locatedError = /^(?:[^\s:]+\/)*[^:\s]+:\d+(?::\d+)?:\s*.+$/;

for (const filename of guards) {
  const run = spawnSync(process.execPath, [join(directory, filename)], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  if (!run.error && run.status === 0) {
    console.log(filename === 'migrations-lint.mjs' ? `${filename}: passed\n${run.stdout.trim()}` : `${filename}: passed`);
    continue;
  }

  failures++;
  const lines = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const located = lines.filter((line) => locatedError.test(line));
  if (located.length > 0) {
    for (const line of located) console.error(line);
  } else {
    const useful = lines.find((line) => !line.startsWith('at ') && !line.startsWith('Node.js '));
    const reason = run.error?.message ?? useful ?? `exited with ${run.signal ?? run.status ?? 'unknown status'}`;
    console.error(`scripts/guards/${filename}:1: ${reason}`);
  }
}

if (failures > 0) process.exitCode = 1;
