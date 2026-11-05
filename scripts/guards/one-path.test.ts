import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { additions, directQuery, exportedFunction, moneyCalculation } from './one-path.mjs';

const script = fileURLToPath(new URL('./one-path.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(initial: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'c3-one-path-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (file: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  };
  const commit = () => { git('add', '-A'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-qb', 'main');
  put('README.md', 'fixture\n');
  put('vercel.json', JSON.stringify({ crons: [{ path: '/api/cron/known' }] }));
  for (const [name, body] of Object.entries(initial)) put(name, body);
  const base = commit();
  const run = (summaryPath = '') => {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, HEAD_SHA: 'HEAD', GITHUB_STEP_SUMMARY: summaryPath },
    });
    return { code: result.status, message: result.stderr + result.stdout };
  };
  return { dir, put, commit, run };
}

describe('one-path advisory guard', () => {
  it('extracts only additions with exact new line numbers', () => {
    expect(additions('@@ -7,1 +7,2 @@\n-old\n+new\n+more\n')).toEqual([
      { line: 7, text: 'new' }, { line: 8, text: 'more' },
    ]);
    expect(exportedFunction('export const calculatePay = (x) => x')).toBe('calculatePay');
    expect(exportedFunction('export const data = { active: true }')).toBeNull();
    expect(directQuery('const result = db.from("orders")')).toBe(true);
    expect(directQuery('const array = Array.from(items)')).toBe(false);
    expect(moneyCalculation('const netSales = grossSales - fees')).toBe(true);
  });

  it('reports all five warning categories without failing', () => {
    const f = fixture();
    f.put('lib/existing.ts', 'export function sharedPlan() { return true; }\n');
    f.put('components/new.ts', 'export function sharedPlan() { return false; }\nexport async function GET() { return null; }\n');
    f.put('app/quote.ts', 'const totalCost = inputCost * quantity;\nconst orders = db.from("orders");\n');
    f.put('.github/workflows/check-verify.yml', 'name: redundant\n');
    f.put('app/api/cron/unlisted/route.ts', 'export async function GET() {}\n');
    f.commit();
    const summary = path.join(f.dir, 'step-summary.md');
    const res = f.run(summary);
    expect(res.code).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('One-path advisory warnings');
    expect(res.message).toContain('exported function sharedPlan also exists in lib/existing.ts');
    expect(res.message).toContain('possible money calculation outside lib/metrics/core');
    expect(res.message).toContain('possible direct table query outside lib/data');
    expect(res.message).toContain('new *-verify workflow');
    expect(res.message).toContain('missing from vercel.json');
    expect(res.message).not.toContain('function GET also exists');
  });

  it('does not flag canonical paths, registered cron routes or existing lines', () => {
    const f = fixture({ 'app/old.ts': 'const rows = db.from("orders");\n' });
    f.put('app/old.ts', 'const rows = db.from("orders");\n// unchanged query above\n');
    f.put('lib/data/reader.ts', 'const rows = db.from("orders");\n');
    f.put('lib/metrics/core/profit.ts', 'const totalCost = inputCost * quantity;\n');
    f.put('app/api/cron/known/route.ts', 'export async function GET() {}\n');
    f.commit();
    expect(f.run().message).toContain('0 advisory warning(s)');
  });
});
