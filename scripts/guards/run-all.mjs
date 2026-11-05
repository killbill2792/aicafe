#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const locatedError = /^(?:[^\s:]+\/)*[^:\s]+:\d+(?::\d+)?:\s*.+$/;

for (const filename of guards) {
  const run = spawnSync(process.execPath, [join(directory, filename)], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  if (!run.error && run.status === 0) {
    console.log(`${filename}: passed`);
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
