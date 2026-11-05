import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedLines, hasBigOk, isIgnored } from './pr-size.mjs';

const script = fileURLToPath(new URL('./pr-size.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'c3-pr-size-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (file: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  };
  const commit = () => { git('add', '-A'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-qb', 'main');
  put('README.md', 'fixture\n');
  const base = commit();
  const run = (labels = '', summaryPath = '') => {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: 'HEAD', PR_LABELS: labels, GITHUB_STEP_SUMMARY: summaryPath },
    });
    return { code: result.status, message: result.stderr + result.stdout };
  };
  return { dir, put, commit, run };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';

describe('PR size guard', () => {
  it('counts additions and replacements but not a file that only loses lines', () => {
    expect(changedLines('4\t3\tapp/feature.ts\0' + '0\t900\tlib/removed.ts\0')).toBe(7);
    expect(changedLines('100\t100\tpackage-lock.json\0' + '200\t2\tlib/generated/client.ts\0')).toBe(0);
    expect(isIgnored('lib/calc.ts')).toBe(false);
  });

  it('excludes vendored .claude/skills files while still counting application changes', () => {
    expect(isIgnored('.claude/skills/vendor/SKILL.md')).toBe(true);
    expect(isIgnored('.claude/skills/vendor/references/guide.md')).toBe(true);
    expect(isIgnored('docs/skills/guide.md')).toBe(false);
    expect(changedLines('900\t0\t.claude/skills/vendor/SKILL.md\0' + '3\t0\tapp/real.ts\0')).toBe(3);
    const f = fixture();
    f.put('.claude/skills/vendor/SKILL.md', lines(1000));
    f.put('app/real.ts', lines(3));
    f.commit();
    const result = f.run();
    expect(result.code).toBe(0);
    expect(result.message).toContain('3 changed lines');
  });

  it('requires an exact big-ok label, including JSON label objects', () => {
    expect(hasBigOk('not-big-ok')).toBe(false);
    expect(hasBigOk('review,big-ok')).toBe(true);
    expect(hasBigOk('[{"name":"review"},{"name":"big-ok"}]')).toBe(true);
  });

  it('warns only above 400 changed lines', () => {
    const f = fixture();
    f.put('app/feature.ts', lines(401));
    f.commit();
    expect(f.run().code).toBe(0);
    const summary = path.join(f.dir, 'step-summary.md');
    const result = f.run('', summary);
    expect(result.message).toMatch(/WARNING.*401 changed lines/);
    expect(readFileSync(summary, 'utf8')).toContain('WARNING — 401 changed lines');
  });

  it('fails above 800 unless big-ok is supplied', () => {
    const f = fixture();
    f.put('lib/feature.ts', lines(801));
    f.commit();
    expect(f.run().code).toBe(1);
    expect(f.run().message).toMatch(/FAIL.*801 changed lines/);
    expect(f.run('big-ok').code).toBe(0);
  });

  it('ignores generated, lockfile and pure-deletion changes', () => {
    const f = fixture();
    f.put('app/old.ts', lines(950));
    f.commit();
    // Compare the next commit with a base containing the file to be removed.
    const newBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dir, encoding: 'utf8' }).trim();
    rmSync(path.join(f.dir, 'app/old.ts'));
    f.put('package-lock.json', lines(1000));
    f.put('lib/generated/auto.ts', lines(1200));
    f.put('app/real.ts', lines(3));
    f.commit();
    const result = spawnSync(process.execPath, [script], {
      cwd: f.dir, encoding: 'utf8',
      env: { ...process.env, BASE_SHA: newBase, HEAD_SHA: 'HEAD', PR_LABELS: '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('3 changed lines');
  });
});
