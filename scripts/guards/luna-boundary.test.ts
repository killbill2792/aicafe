import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {verifyRace} from '../db/luna-engine-race.mjs';

const guard = resolve('scripts/guards/luna-boundary.mjs');
const legacy = 'lib/ai/conversations/agentRunner.server.ts';
const ledger = 'docs/plans/luna-rebuild.md';
let dir:string, base:string;
function put(path:string, body:string) {
  mkdirSync(dirname(join(dir,path)),{recursive:true});
  writeFileSync(join(dir,path),body);
}
function git(...args:string[]) {
  return execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
}
function commit() {
  git('add','.'); git('commit','--allow-empty','-qm','fixture');
  return git('rev-parse','HEAD');
}
function run(branch='luna/operator-rebuild',trustedBase=base) {
  const result=spawnSync(process.execPath,[guard],{cwd:dir,encoding:'utf8',
    env:{...process.env,LUNA_POLICY_BASE:trustedBase,BASE_SHA:base,HEAD_SHA:commit(),GITHUB_HEAD_REF:branch}});
  return {status:result.status, errors:result.stderr};
}
describe('Luna repository boundary',()=>{
  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'luna-boundary-'));
    git('init','-q'); git('config','user.email','boundary@example.invalid'); git('config','user.name','Fixture');
    put('tsconfig.json',JSON.stringify({compilerOptions:{moduleResolution:'bundler',paths:{'@/*':['./*']}}}));
    put('scripts/guards/luna-boundary.mjs','// installed fixture policy');
    put(ledger,'# Ledger\n'); put(legacy,'export const run = 1;');
    put('lib/metrics/core.ts','export const sales = 1;');
    put('scripts/db/luna-engine-driver.mjs','// Test driver presence fixture only.');
    base=commit();
  });
  afterEach(()=>rmSync(dir,{recursive:true,force:true}));
  it('accepts a reusable calculation',()=>{
    put('lib/luna/runtime/index.ts',"export * from '@/lib/metrics/core';");
    expect(run()).toEqual({status:0,errors:''});
  });
  it('follows alias, barrel, explicit JS extension and dynamic import to legacy',()=>{
    put('lib/luna/runtime/index.ts',"export * from './adapter.js';");
    put('lib/luna/runtime/adapter.ts',"export const f = () => import('@/lib/ai/conversations/agentRunner.server');");
    expect(run().errors).toContain(legacy);
  });
  it('rejects an opaque loader and a reverse dependency from a shared service',()=>{
    put('lib/luna/runtime/index.ts','export const load = (x:string) => require(x);');
    put('lib/metrics/core.ts',"export * from '../luna/runtime';");
    const r=run(); expect(r.status).toBe(1);
    expect(r.errors).toContain('computed module'); expect(r.errors).toContain('forbidden dependency');
  });
  it('checks a changed intermediary of an untouched shared service on unrelated branches',()=>{
    put('lib/metrics/core.ts',"export * from '../utility';");
    put('lib/utility.ts','export const sales=1;'); base=commit();
    put('lib/utility.ts',"export * from '@/lib/ai/conversations/agentRunner.server';");
    expect(run('feat/unrelated').errors).toContain(legacy);
  });
  it('requires independently reviewed revisions on canonical, worker and stacked branches',()=>{
    const proof='tests/adapter.test.ts';
    put(proof,"import {it,expect} from 'vitest'; import {run} from '../lib/ai/conversations/agentRunner.server'; it('preserves the adapter result',()=>expect(run).toBe(2));");
    put(legacy,'export const run = 2;');
    const record='| Legacy exception | '+legacy+' | '+git('rev-parse',base+':'+legacy)+' | '+
      git('hash-object',legacy)+' | adapt cutover | '+proof+' | '+git('hash-object',proof)+' | remove after drain |\n';
    put(ledger,record);
    for(const branch of ['luna/operator-rebuild','feat/worker'])
      expect(run(branch).errors).toContain('revision-bound legacy exception');
    const main=base;
    put(legacy,'export const run = 1;'); base=commit();
    put(legacy,'export const run = 2;');
    expect(run('stacked/worker',main).status).toBe(1);
    expect(run('feat/worker')).toEqual({status:0,errors:''});
    put(proof,'// assertions removed'); expect(run().status).toBe(1);
    put(legacy,'export const run = 3;'); expect(run().status).toBe(1);
  });
  it('recognizes private agent helpers through a new alias, barrel and dynamic import',()=>{
    put('tsconfig.json',JSON.stringify({extends:'./tsconfig.base.json'}));
    put('tsconfig.base.json',JSON.stringify({compilerOptions:{moduleResolution:'bundler',paths:{'old/*':['./lib/ai/agent/*']}}}));
    put('lib/ai/agent/jobState.ts','export const state=1;');
    put('lib/luna/runtime/new.ts',"export * from '../../intermediate';");
    put('lib/intermediate.ts',"export const load=()=>import('old/jobState');");
    expect(run('feat/delegated').errors).toContain('lib/ai/agent/jobState.ts');
    put('lib/intermediate.ts',"export * from 'old/missing';");
    expect(run().errors).toContain('unresolved local dependency');
  });
  it('allows a standalone shared extraction with an erased legacy type',()=>{
    rmSync(join(dir,'scripts/db/luna-engine-driver.mjs'));
    put('lib/luna/shared/amount.ts',"import type {State} from '@/lib/ai/agent/jobState'; export const amount = (s:State)=>s.total;");
    expect(run('feature/shared')).toEqual({status:0,errors:''});
  });
  it('checks JavaScript behind a TypeScript declaration',()=>{
    put('lib/luna/runtime/index.ts',"export * from '../../port.js';");
    put('lib/port.d.ts','export declare const value:number;');
    put('lib/port.js',"export * from './ai/agent/jobState';");
    put('lib/ai/agent/jobState.ts','export const value=1;');
    expect(run('feat/worker').errors).toContain('forbidden dependency lib/ai/agent/jobState.ts');
  });
  it('protects the launcher and CI even on a control-only worker branch',()=>{
    put('scripts/guards/run-all.mjs','// changed launcher');
    put('.github/workflows/ai-cafe-pr-baseline.yml','jobs: {}');
    const r=run('maintenance/worker');
    expect(r.status).toBe(1);
    expect(r.errors).toContain('scripts/guards/run-all.mjs');
    expect(r.errors).toContain('.github/workflows/ai-cafe-pr-baseline.yml');
    expect(r.errors).toContain('revision-bound safeguard change');
  });
  it('permits unrelated DB registrations while retaining the independent oracle',()=>{
    put('scripts/db/run-all.sh','node scripts/db/luna-engine-race.mjs\n'); base=commit();
    put('scripts/db/run-all.sh','node scripts/db/luna-engine-race.mjs\nsql_step unrelated.sql "Other service"\n');
    expect(run('feature/database')).toEqual({status:0,errors:''});
    put('scripts/db/run-all.sh','sql_step unrelated.sql "Other service"\n');
    expect(run('feature/database').errors).toContain('retain the registered');
  });
  it('blocks a mixed enforcement change and a missing database driver',()=>{
    put('scripts/guards/run-all.mjs',''); put('lib/luna/runtime/index.ts','export {};');
    rmSync(join(dir,'scripts/db/luna-engine-driver.mjs'));
    const r=run(); expect(r.errors).toContain('change enforcement separately');
    expect(r.errors).toContain('two-engine race driver');
  });
  it('keeps PR 594 architecture-only and preserves unrelated PR scope',()=>{
    put(legacy,'export const value = 3;');
    expect(run('luna/complete-rebuild').status).toBe(1);
    put(legacy,'export const run = 1;');
    put('lib/metrics/core.ts','export const sales = 2;');
    expect(run('feat/unrelated').status).toBe(0);
  });
});
it('fails when two engines run, a destination receives a duplicate, or the database lacks a verified receipt',()=>{
  const one={pin:'legacy', executions:['legacy'], deliveries:['key'], token:'key',
    runs:[{engine:'legacy',status:'completed'}],effects:[{state:'verified',receipt_ref:'gmail:key',provider_message_id:'key',provider_state:'verified'}]};
  expect(()=>verifyRace(one)).not.toThrow();
  for (const change of [{executions:['legacy','replacement']},{deliveries:['key','key']},{effects:[{...one.effects[0],provider_message_id:'other'}]},
    {runs:[...one.runs,...one.runs]},{effects:[{state:'uncertain',receipt_ref:null}]}])
    expect(()=>verifyRace({...one,...change})).toThrow();
});
