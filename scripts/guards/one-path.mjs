#!/usr/bin/env node
// Advisory checks for parallel implementations. This script NEVER blocks a PR.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const source = (path) => /^(?:app|lib|components)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path)
  && !/(?:^|\/)(?:__tests__|__generated__|generated)\//.test(path)
  && !/\.(?:test|spec|generated)\.[cm]?[jt]sx?$/.test(path);
const common = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'formatDate']);

export function additions(patch) {
  const result = [];
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (row.startsWith('+++') || row.startsWith('---')) continue;
    if (row.startsWith('+')) { result.push({ line, text: row.slice(1) }); line++; }
    else if (row.startsWith(' ')) line++;
  }
  return result;
}

export function exportedFunction(line, following = '') {
  const fn = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(/.exec(line);
  if (fn) return fn[1];
  const arrow = /^\s*export\s+(?:const|let)\s+([\w$]+)\s*(?::[^=]+)?=\s*(.*)/.exec(line);
  if (!arrow) return null;
  // Inspect a short continuation for multi-line exported arrow functions.
  const value = (arrow[2] + '\n' + following).slice(0, 1200);
  return /^(?:\s*async\s*)?(?:function\b|(?:\([^;{}]*\)|[\w$]+)\s*=>)/s.test(value) ? arrow[1] : null;
}

export function moneyCalculation(line) {
  if (/^\s*(?:\/\/|\*|import\b|type\b|interface\b)/.test(line)) return false;
  return /\b(?:price|cost|margin|profit|revenue|sales|total|fee|tax|payroll|wage|labor|amount|cents|subtotal|discount)[\w]*\b/i.test(line)
    && /(?:[\w$)]|\d)\s*(?:\+|-|\*|\/)\s*(?:[\w$(]|\d)/.test(line)
    && /(?:\b(?:return|const|let)\b|=>|=|Math\.|\.reduce\s*\()/.test(line);
}

export function directQuery(line) {
  if (/^\s*(?:\/\/|\*|import\b)/.test(line) || /\bArray\.from\s*\(/.test(line)) return false;
  return /\.from\s*\(\s*['"`]\w[\w.]*['"`]/.test(line)
    || /\.query\s*\(\s*['"`]\s*(?:select|with|insert|update|delete)\b/i.test(line);
}

function publishWarnings(messages) {
  for (const message of messages) console.warn(message);
  // The shared runner does not forward successful children's output to CI logs.
  if (messages.length && process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### One-path advisory warnings\n\n${messages.map((message) => `- ${message}`).join('\n')}\n`); }
    catch { /* Advisory checks never fail a PR. */ }
  }
}

export function run() {
  try {
    const head = process.env.HEAD_SHA || 'HEAD';
    let base = process.env.BASE_SHA;
    if (!base) {
      for (const branch of ['origin/main', 'main']) {
        try { base = git('merge-base', branch, head).trim(); break; } catch { /* next branch */ }
      }
    }
    base ||= git('rev-parse', `${head}^`).trim();
    const range = `${base}...${head}`;
    const paths = git('diff', '--name-only', '-z', '--no-renames', range).split('\0').filter(Boolean);
    const addedFiles = new Set(git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', range).split('\0').filter(Boolean));
    const warnings = [];
    const warn = (path, line, message) => warnings.push(`${path}:${line}: WARNING: ${message}`);
    const seen = new Set();

    for (const path of paths.filter(source)) {
      const patch = additions(git('diff', '--no-renames', '--unified=0', range, '--', path));
      if (!patch.length) continue;
      const fileLines = git('show', `${head}:${path}`).split('\n');
      for (const { line, text } of patch) {
        const name = exportedFunction(text, fileLines.slice(line, line + 9).join('\n'));
        if (name && !common.has(name) && !seen.has(`${path}:${name}`)) {
          seen.add(`${path}:${name}`);
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let hits = [];
          try {
            hits = git('grep', '-l', '-E', `(^|[^[:alnum:]_$])(function|const|let)[[:space:]]+${escaped}([^[:alnum:]_$]|$)`, head, '--', 'app', 'lib', 'components')
              .split('\n').filter(Boolean).map((hit) => hit.slice(hit.indexOf(':') + 1));
          } catch (error) { if (error.status !== 1) throw error; }
          const elsewhere = hits.find((hit) => hit !== path && source(hit));
          if (elsewhere) warn(path, line, `exported function ${name} also exists in ${elsewhere}; reuse the existing path`);
        }
        if (!path.startsWith('lib/metrics/core/') && moneyCalculation(text)) {
          warn(path, line, 'possible money calculation outside lib/metrics/core/');
        }
        if (!path.startsWith('lib/data/') && directQuery(text)) {
          warn(path, line, 'possible direct table query outside lib/data/');
        }
      }
    }

    for (const path of addedFiles) {
      if (/^\.github\/workflows\/[^/]+-verify\.ya?ml$/.test(path)) {
        warn(path, 1, 'new *-verify workflow; check whether the baseline already covers it');
      }
    }
    const cronRoutes = [...addedFiles].filter((path) => /^app\/api\/cron\/[^/]+\/route\.[cm]?[jt]s$/.test(path));
    if (cronRoutes.length) {
      let schedules = [];
      try { schedules = JSON.parse(git('show', `${head}:vercel.json`)).crons ?? []; }
      catch { warn('vercel.json', 1, 'cannot read cron configuration'); }
      const registered = new Set(schedules.map((item) => item.path));
      for (const path of cronRoutes) {
        const route = `/${path.replace(/^app\//, '').replace(/\/route\.[cm]?[jt]s$/, '')}`;
        if (!registered.has(route)) warn(path, 1, `new cron route ${route} missing from vercel.json`);
      }
    }
    publishWarnings(warnings);
    console.log(`One-path: ${warnings.length} advisory warning(s); never blocks a PR.`);
  } catch (error) {
    publishWarnings([`One-path: WARNING: could not complete advisory scan (${error.message}); never blocks a PR.`]);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run();
