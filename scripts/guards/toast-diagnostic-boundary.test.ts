import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {addedDiagnosticReferences, diagnosticWorkflowTriggerErrors, isOperationalSource} from './toast-diagnostic-boundary.mjs';

const guard = fileURLToPath(new URL('./toast-diagnostic-boundary.mjs', import.meta.url));
const workdirs: string[] = [];
afterEach(() => { for (const d of workdirs.splice(0)) rmSync(d, {recursive: true, force: true}); });

function fixture(previous: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'aicafe-source-boundary-'));
  workdirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const put = (file: string, content: string) => {
    mkdirSync(dirname(join(cwd, file)), {recursive: true});
    writeFileSync(join(cwd, file), content);
  };
  git('init', '-qb', 'main');
  git('config', 'user.email', 'source-boundary@example.invalid');
  git('config', 'user.name', 'Source Boundary Test');
  put('README.md', 'test fixture\n');
  for (const [path, value] of Object.entries(previous)) put(path, value);
  git('add', '.'); git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD');
  return {
    put,
    run: (moreEnv: Record<string, string> = {}) => {
      git('add', '.'); git('commit', '--allow-empty', '-qm', 'feature');
      return spawnSync(process.execPath, [guard], {
        cwd, encoding: 'utf8', env: {...process.env,
          BASE_SHA: base, HEAD_SHA: 'HEAD', PR_LABELS: '[]', ...moreEnv},
      });
    },
  };
}

describe('Toast diagnostics may not feed operational data', () => {
  it('rejects a newly added live Supervisor query or screen data source', () => {
    const r = fixture();
    r.put('lib/ai/agent/tools/missingSource.ts',
      'const fromSamples = await db.from("toast_raw_samples").select("*");\n');
    r.put('app/[locale]/operations/queries.ts',
      'const latest = db.from("toast_raw_samples_latest");\n');
    const result = r.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lib/ai/agent/tools/missingSource.ts:1');
    expect(result.stderr).toContain('app/[locale]/operations/queries.ts:1');
    expect(result.stderr).toContain('diagnostic Toast capture is NOT an operational source');
  });

  it('rejects new SQL migrations that make diagnostics an active reader', () => {
    const r = fixture();
    r.put('supabase/migrations/20261108000000_bad_reader.sql',
      'create view public.cv_wrong as select * from public.toast_raw_samples;\n');
    const result = r.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('20261108000000_bad_reader.sql:1');
  });

  it('blocks reintroducing samples into the café mirror, while leaving old code untouched', () => {
    const r = fixture({
      'lib/data/legacy.ts': 'const legacy = db.from("toast_raw_samples");\n',
    });
    r.put('lib/data/legacy.ts',
      'const legacy = db.from("toast_raw_samples");\nexport const unrelated = 1;\n');
    r.put('scripts/sync-cafe-data.mjs',
      'const mirror = ["toast_raw_samples"];\n');
    const result = r.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scripts/sync-cafe-data.mjs:1');
    expect(result.stderr).not.toContain('lib/data/legacy.ts:1');
  });

  it('allows diagnostic capture implementations and synthetic diagnostic tests only', () => {
    const r = fixture();
    r.put('lib/pos/toast/rawSample.server.ts',
      'const table = "toast_raw_samples";\n');
    r.put('scripts/toast-raw-sample-sql-integration.sql',
      'insert into toast_raw_samples(sample) values (\'{}\');\n');
    r.put('scripts/guards/unrelated.test.ts',
      'const fixture = "toast_raw_samples";\n');
    r.put('docs/rules/pos-data.md',
      'Historical diagnostic table: toast_raw_samples\n');
    const result = r.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no newly introduced operational dependencies');
  });

  it('does not allow misleading naming to disguise a new canonical dependency', () => {
    expect(isOperationalSource('lib/data/canonical/reads.server.ts')).toBe(true);
    expect(isOperationalSource('scripts/sync-cafe-data.mjs')).toBe(true);
    expect(isOperationalSource('lib/pos/toast/rawSample.server.ts')).toBe(false);
    expect(isOperationalSource('lib/ai/agent/tools/dataQuery.test.ts')).toBe(false);
    const patch = [
      'diff --git a/lib/data/current.ts b/lib/data/current.ts',
      '--- /dev/null', '+++ b/lib/data/current.ts',
      '@@ -0,0 +1,3 @@',
      '+const okay = 1;', '+const old = "toast_raw_samples_latest";',
      '+const sample = captureToastRawSample();',
    ].join('\n');
    expect(addedDiagnosticReferences(patch)).toEqual([
      expect.stringContaining('lib/data/current.ts:2:'),
      expect.stringContaining('lib/data/current.ts:3:'),
    ]);
  });

  it('retires old auto-scheduled diagnostics and preserves a manual-only workflow', () => {
    const old = fixture();
    old.put('.github/workflows/toast-raw-capture-daily.yml',
      'on:\n  schedule:\n    - cron: "0 * * * *"\n');
    const bad = old.run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('retired scheduled diagnostic workflow');

    const scheduled = fixture();
    scheduled.put('.github/workflows/toast-diagnostic-capture-manual.yml',
      'on:\n  schedule:\n    - cron: "0 * * * *"\n  workflow_dispatch:\n');
    const wrong = scheduled.run();
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('must be manual-only');

    const manual = fixture();
    manual.put('.github/workflows/toast-diagnostic-capture-manual.yml',
      'name: DIAGNOSTIC_ONLY\non:\n  workflow_dispatch:\n');
    expect(manual.run().status).toBe(0);
  });


  it('rejects malformed literal-backslash-n trigger and nonmanual YAML trigger on actual guard path', () => {
    const malformed = fixture();
    malformed.put('.github/workflows/toast-diagnostic-capture-manual.yml',
      String.raw`on:\n  workflow_dispatch:` + '\n');
    const invalid = malformed.run();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('valid YAML on: mapping');

    const push = fixture();
    push.put('.github/workflows/toast-diagnostic-capture-manual.yml',
      'on:\n  workflow_dispatch:\n  push:\n');
    expect(push.run().stderr).toContain('as its ONLY trigger');
  });

  it('checks the REAL proposed diagnostic workflow file has a manual-only valid trigger', () => {
    const path = fileURLToPath(new URL('../../.github/workflows/toast-diagnostic-capture-manual.yml', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(diagnosticWorkflowTriggerErrors(source,path)).toEqual([]);
    expect(source).toMatch(/^on:\n  workflow_dispatch:\s*$/m);
    expect(source).not.toMatch(/^\s*schedule\s*:/m);
    expect(source).not.toContain(String.raw`on:\n  workflow_dispatch:`);
  });

  it('checks documented authority routing and preserves historical context', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const read = (p: string) => readFileSync(join(root,p),'utf8');
    const docs = read('docs/README.md');
    const agents = read('AGENTS.md');
    const rules = read('docs/rules/pos-data.md');
    const notes = read('docs/data-dictionary-notes.md');
    const queue = JSON.parse(read('docs/plans/universal-supervisor-queue.json'));
    expect(docs).toMatch(/Toast integration — historical phase runbooks/);
    expect(docs).not.toMatch(/### Toast integration \(current\)/);
    expect(docs).toContain('toast-polling.md');
    expect(docs).toContain('binding source/consumer rules');
    expect(agents).toContain('Mandatory actual first-read sequence');
    expect(rules).toContain('First-read and conflict priority');
    expect(notes).toContain('Generated-dictionary contradiction requiring later code ownership');
    expect(queue.dispatch_rules.architecture_foundation_implementation_approval.approved).toBe(false);
    expect(queue.dispatch_rules.pos_source_authority.ordered_first_read).toHaveLength(6);
    expect(queue.dispatch_rules.pos_source_authority.known_deployed_defects.join(' ')).toContain('SQL toast_import_day');
    expect(agents).toContain('D4A/D4B owner decisions');
    expect(rules).toContain('Owner-approved D4A and D4B');
    expect(docs).toContain('D1–D4A/D4B');
    expect(queue.dispatch_rules.pos_d4_contract.implementation_approved).toBe(false);
    expect(queue.dispatch_rules.pos_d4_contract.future_order_recovery.dispatchable).toBe(false);
    expect(queue.dispatch_rules.pos_d4_contract.must_preserve_merged_prs).toEqual([189,203,264,297]);
    expect(queue.tasks.some((t: {id: string}) => t.id==='POS0-order-recovery')).toBe(false);
  });

  it('enforces explicit naming for new diagnostic-only sources without banning historical files', () => {
    const bad = fixture();
    bad.put('lib/pos/toast/hiddenCapture.ts',
      '// DIAGNOSTIC_ONLY: investigation; no operating data.\nexport const testCapture = true;\n');
    const invalid = bad.run();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('lib/pos/toast/hiddenCapture.ts:1: DIAGNOSTIC_ONLY source must be named');

    const good = fixture();
    good.put('lib/pos/toast/toastDiagnosticCapture.ts',
      '// DIAGNOSTIC_ONLY: investigation; no operating data.\nexport const capture = true;\n');
    expect(good.run().status).toBe(0);

    const existing = fixture({
      'lib/pos/toast/rawSample.server.ts': '// DIAGNOSTIC_ONLY: existing old name.\n',
    });
    existing.put('lib/pos/toast/rawSample.server.ts',
      '// DIAGNOSTIC_ONLY: existing old name.\nexport const noNewCapture = true;\n');
    expect(existing.run().status).toBe(0);
  });

  it('fails closed if the supplied Git base cannot be checked', () => {
    const r = fixture();
    r.put('app/page.tsx', 'export const version = 1;\n');
    const result = r.run({BASE_SHA: 'unknown-git-commit'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scripts/guards/toast-diagnostic-boundary.mjs:1:');
  });
});
