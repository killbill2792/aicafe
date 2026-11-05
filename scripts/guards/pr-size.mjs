#!/usr/bin/env node
// PR-only size guard. Pure removals, generated output and dependency locks do not count.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();

export function refs() {
  const head = process.env.HEAD_SHA || 'HEAD';
  if (process.env.BASE_SHA) return [process.env.BASE_SHA, head];
  for (const branch of ['origin/main', 'main']) {
    try { return [git('merge-base', branch, head), head]; } catch { /* try next */ }
  }
  return [git('rev-parse', `${head}^`), head];
}

export function hasBigOk(raw = '') {
  let labels = raw;
  try { labels = JSON.parse(raw); } catch { /* plain comma/space-delimited labels */ }
  if (Array.isArray(labels)) return labels.some((v) => (typeof v === 'string' ? v : v?.name) === 'big-ok');
  return typeof labels === 'string' && labels.split(/[\s,;]+/).includes('big-ok');
}

export function isIgnored(path) {
  return /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock)$/.test(path)
    || /(?:^|\/)(?:\.next|dist|build|coverage|generated|__generated__|vendor)(?:\/|$)/.test(path)
    || /(?:\.generated\.[^/]+|\.min\.(?:js|css)|\.map|\.snap|\.tsbuildinfo)$/.test(path)
    || path === 'next-env.d.ts'
    || path.startsWith('.claude/skills/');
}

export function changedLines(numstat) {
  let total = 0;
  for (const entry of numstat.split('\0')) {
    if (!entry) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Cannot parse git diff --numstat output');
    const [, added, removed, path] = match;
    if (added === '-' || removed === '-' || Number(added) === 0 || isIgnored(path)) continue;
    total += Number(added) + Number(removed);
  }
  return total;
}

export function run() {
  const [base, head] = refs();
  const lines = changedLines(git('diff', '--numstat', '-z', '--no-renames', `${base}...${head}`));
  if (lines > 800 && !hasBigOk(process.env.PR_LABELS)) {
    console.error(`PR size: FAIL — ${lines} changed lines (limit 800; add the big-ok label for an exception).`);
    return 1;
  }
  if (lines > 400) {
    const message = `PR size: WARNING — ${lines} changed lines (prefer 400 or fewer).`;
    console.warn(message);
    // The shared runner captures successful child output; publish advisory warnings to CI's job summary.
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`); }
      catch { /* Warning-only diagnostics must never fail a PR. */ }
    }
  }
  else console.log(`PR size: ${lines} changed lines; within the recommended limit.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = run(); }
  catch (error) { console.error(`PR size: FAIL — ${error.message}`); process.exitCode = 1; }
}
