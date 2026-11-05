import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const guard = join(dirname(fileURLToPath(import.meta.url)), 'hardcode.mjs');

function repo(files: Record<string, string>, previous: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aicafe-hardcode-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  function write(paths: Record<string, string>) {
    for (const [path, content] of Object.entries(paths)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'guard@example.invalid');
  git('config', 'user.name', 'Guard Test');
  write({ 'README.md': 'base\n', ...previous });
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  write(files);
  git('add', '.'); git('commit', '-qm', 'feature');
  const head = git('rev-parse', 'HEAD');
  return { dir, base, head, git };
}

function run(r: ReturnType<typeof repo>, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [guard], {
    cwd: r.dir, encoding: 'utf8',
    env: { ...process.env, BASE_SHA: r.base, HEAD_SHA: r.head, PR_LABELS: '[]', ...env }
  });
}

function withRepo(files: Record<string, string>, previous: Record<string, string>, fn: (r: ReturnType<typeof repo>) => void) {
  const r = repo(files, previous);
  try { fn(r); } finally { rmSync(r.dir, { recursive: true, force: true }); }
}

test('flags only new production lines with accurate new-file line numbers', () => {
  withRepo({
    'app/page.tsx': [
      'export const safe = true;',
      'const a = "EUR";',
      'const b = "Asia/Tokyo";',
      'const c = "6ac42775-19cd-4674-a29a-d93c5bdf3721";',
      'const d = { currency: "not-an-ISO-code" };',
      'const e = `$${amount}`;',
      'const f = "$";',
      'const g = "UTC";',
    ].join('\n') + '\n',
    'lib/legacy.ts': 'const unchanged = "USD";\nexport const newSafe = true;\n',
  }, { 'lib/legacy.ts': 'const unchanged = "USD";\n' }, r => {
    const result = run(r);
    assert.equal(result.status, 1);
    for (const n of [2, 3, 4, 5, 6, 7, 8]) assert.match(result.stderr, new RegExp(`app/page\\.tsx:${n}: read it from businesses\\.currency / the cafe timezone setting`));
    assert.doesNotMatch(result.stderr, /lib\/legacy/);
    assert.equal(result.stderr.trim().split('\n').length, 7);
  });
});

test('skips tests, deleted lines, non-production paths and false-positive three-letter words', () => {
  withRepo({
    'app/page.tsx': 'const a = "GET";\nconst b = `${value}`;\n',
    'app/page.test.ts': 'const a = "USD";\n',
    'lib/__tests__/example.ts': 'const a = "EUR";\n',
    'components/Sample.stories.tsx': 'const a = "USD";\n',
    'scripts/random.mjs': 'const a = "USD";\n',
  }, {}, r => assert.equal(run(r).status, 0));
});

test('accepts a same-line reason but rejects an empty hardcode-ok', () => {
  withRepo({ 'lib/example.ts': 'const ok = "JPY"; // hardcode-ok: third-party API contract\nconst bad = "USD"; // hardcode-ok: \n' }, {}, r => {
    const result = run(r);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lib\/example\.ts:2:/);
    assert.doesNotMatch(result.stderr, /lib\/example\.ts:1:/);
  });
});

test('allowlist is scoped by both path and rule, not a blanket exception', () => {
  withRepo({
    'components/more/cafeProfileOptions.ts': 'const currency = "USD";\nconst timezone = "Europe/Paris";\n',
    'lib/admin/format.ts': 'const billing = { currency: "USD" };\n',
    'lib/events/holidays.ts': 'const holidayZone = "America/Chicago";\n',
    'lib/pos/rollup.ts': 'const storedZone = "UTC";\n',
  }, {}, r => {
    const result = run(r);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /components\/more\/cafeProfileOptions\.ts:2:/);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  });
});

test('standalone uses local main when BASE_SHA and HEAD_SHA are absent', () => {
  withRepo({ 'components/new.tsx': 'export const a = "CAD";\n' }, {}, r => {
    const result = run(r, { BASE_SHA: '', HEAD_SHA: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /components\/new\.tsx:1:/);
  });
});

test('bad base fails closed instead of treating the diff as empty', () => {
  withRepo({ 'app/a.ts': 'export const a = "USD";\n' }, {}, r => {
    const result = run(r, { BASE_SHA: 'missing-ref' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/guards\/hardcode\.mjs:1:/);
  });
});
