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
  git('add','.'); git('commit','-qm','fixture');
  return git('rev-parse','HEAD');
}
function run(branch='luna/operator-rebuild') {
  const result=spawnSync(process.execPath,[guard],{cwd:dir,encoding:'utf8',
    env:{...process.env,BASE_SHA:base,HEAD_SHA:commit(),GITHUB_HEAD_REF:branch}});
  return {status:result.status, errors:result.stderr};
}
describe('Luna repository boundary',()=>{
  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'luna-boundary-'));
    git('init','-q'); git('config','user.email','boundary@example.invalid'); git('config','user.name','Fixture');
    put('tsconfig.json',JSON.stringify({compilerOptions:{moduleResolution:'bundler',paths:{'@/*':['./*']}}}));
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
  it('checks protected changes even when the canonical branch only edits legacy code',()=>{
    put(legacy,'export const run = 2;');
    expect(run().errors).toContain('revision-bound legacy exception');
    put('tests/gate.test.ts','// test path fixture');
    const record='| Legacy exception | '+legacy+' | '+git('rev-parse',base+':'+legacy)+' | '+
      git('hash-object',legacy)+' | adapt cutover | tests/gate.test.ts | remove after drain |\n';
    put(ledger,record); expect(run().status).toBe(0);
    put(legacy,'export const run = 3;'); expect(run().status).toBe(1);
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
    put('README.md','another change'); expect(run('feat/unrelated').status).toBe(0);
  });
});
it('fails when two engines run, a destination receives a duplicate, or the database lacks a verified receipt',()=>{
  const one={pin:'legacy', executions:['legacy'], deliveries:['key'], token:'key',
    runs:[{engine:'legacy',status:'completed'}],effects:[{state:'verified',receipt_ref:'key'}]};
  expect(()=>verifyRace(one)).not.toThrow();
  for (const change of [{executions:['legacy','replacement']},{deliveries:['key','key']},
    {runs:[...one.runs,...one.runs]},{effects:[{state:'uncertain',receipt_ref:null}]}])
    expect(()=>verifyRace({...one,...change})).toThrow();
});
