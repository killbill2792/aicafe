import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {verifyRace} from '../db/luna-engine-race.mjs';
import {verifyExactRegression} from './lib/luna-boundary-proof.mjs';

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
  it('resolves direct literal CommonJS dependencies and ignores type-only Node imports',()=>{
    put('lib/luna/runtime/index.ts', `
      import type { Module } from 'node:module';
      export const first = require('@/lib/metrics/core');
      export const second = module.require('@/lib/metrics/core');
      export const permissions = { require: () => true };
      export type LoaderModule = Module;
      export type Callback = Function;
      export type Evaluator = typeof eval;
    `);
    expect(run()).toEqual({status:0,errors:''});
  });
  it('accepts the same member and binding names on ordinary business data',()=>{
    put('lib/luna/runtime/index.ts',"export * from '../../adapter';");
    put('lib/adapter.ts', `
      const metrics = { mainModule: 'sales', getBuiltinModule: 'orders', createRequire: false };
      export const mainModule = metrics.mainModule;
      export const { getBuiltinModule } = metrics;
      export const available = metrics['createRequire'];
      export const enabled = process.env.ENABLED;
      export const uuid = globalThis.crypto.randomUUID;
      export function format(process: { format: string }, require: () => string, Function: string) {
        return [process.format, require(), Function];
      }
    `);
    expect(run()).toEqual({status:0,errors:''});
  });
  it('allows only declared and locked external packages and reviewed Node data APIs',()=>{
    put('package.json', JSON.stringify({dependencies:{'@example/metrics':'1.0.0','linked':'file:lib/local'}}));
    put('package-lock.json',JSON.stringify({packages:{
      'node_modules/@example/metrics':{version:'1.0.0',resolved:'https://example.invalid/metrics.tgz',integrity:'sha512-test'},
      'node_modules/linked':{resolved:'lib/local',link:true},
    }}));
    const path='lib/luna/runtime/index.ts';
    put(path,"export * from '@example/metrics/reports'; export {createHash} from 'node:crypto';");
    expect(run()).toEqual({status:0,errors:''});
    put(path,"export * from 'linked'; export * from '@example/metrics/../local'; export * from 'node:unknown-future-api';");
    const errors=run().errors;
    expect(errors).toContain('undeclared package linked');
    expect(errors).toContain('undeclared package @example/metrics/../local');
    expect(errors).toContain('unapproved Node builtin node:unknown-future-api');
  });
  it('checks local aliases even when the spelling also names a builtin',()=>{
    put('tsconfig.json',JSON.stringify({compilerOptions:{moduleResolution:'bundler',paths:{crypto:['./'+legacy]}}}));
    put('lib/luna/runtime/index.ts',"export {run} from 'crypto';");
    expect(run().errors).toContain('forbidden dependency '+legacy);
  });
  it('checks import and require package conditions behind declarations',()=>{
    put('package.json',JSON.stringify({name:'fixtures',type:'module',imports:{
      '#shared':{types:'./lib/contract.d.ts',import:'./lib/metrics/core.ts',require:'./'+legacy},
    }}));
    put('lib/contract.d.ts','export declare const sales:number;');
    const path='lib/luna/runtime/index.ts';
    put(path,"export {sales} from '#shared';");
    expect(run()).toEqual({status:0,errors:''});
    put(path,"export const report = require('#shared');");
    expect(run().errors).toContain('forbidden dependency '+legacy);
  });
  it('checks Next runtime conditions and treats browser rewrites as reviewed configuration',()=>{
    put('package.json',JSON.stringify({name:'fixtures',type:'module',imports:{
      '#shared':{browser:'./'+legacy,default:'./lib/metrics/core.ts'},
    }}));
    put('lib/luna/runtime/index.ts',"export {sales} from '#shared';");
    expect(run().errors).toContain('forbidden dependency '+legacy);
    put('package.json',JSON.stringify({browser:{'./lib/metrics/core.ts':'./'+legacy}}));
    expect(run().errors).toContain('package.json:1: missing independently reviewed');
  });
  it('derives Edge, Node and nested future condition branches from package metadata',()=>{
    const fallback='./safe.ts';
    const imports={
      '#edge': {browser:fallback,'edge-light':'./private.ts',default:fallback},
      '#nested': {'application-runtime':{'application-worker':'./private.ts',default:fallback},default:fallback},
      '#node': {node:'./private.ts',default:fallback},
    };
    put('tsconfig.json',JSON.stringify({compilerOptions:{
      moduleResolution:'bundler',customConditions:['browser'],paths:{'@/*':['./*']},
    }}));
    put('lib/luna/runtime/index.ts',"export * from '../../conditional/adapter';");
    put('lib/conditional/package.json',JSON.stringify({name:'nested-test',type:'module',imports}));
    put('lib/conditional/safe.ts','export const sales=1;');
    put('lib/conditional/private.ts',"export * from '@/lib/ai/conversations/agentRunner.server';");
    for (const alias of Object.keys(imports)) {
      put('lib/conditional/adapter.ts',"export * from '"+alias+"';");
      expect(run().errors).toContain('forbidden dependency '+legacy);
    }
  });
  it('checks external capabilities reached by a conditional package pattern',()=>{
    const imports={
      '#data/*': {'edge-light':'node:*',default:'./lib/metrics/core.ts'},
      '#data/checked': 'node:crypto',
    };
    put('package.json',JSON.stringify({type:'module',imports}));
    const runtime='lib/luna/runtime/index.ts';
    put(runtime,"export * from '#data/checked';");
    expect(run()).toEqual({status:0,errors:''});
    put(runtime,"export * from '#data/module';");
    expect(run().errors).toContain('unapproved Node builtin node:module');
  });
  it('checks the automatic JSX runtime through the same local graph',()=>{
    put('lib/luna/runtime/index.tsx','/** @jsxImportSource ../../component-runtime */\nexport const View = <div />;');
    put('lib/component-runtime/jsx-runtime.ts',"export * from '@/lib/ai/conversations/agentRunner.server';");
    expect(run().errors).toContain('forbidden dependency '+legacy);
  });
  it('rejects missing local assets, symlinks and runtime imports of test sources',()=>{
    put('lib/luna/runtime/index.ts',"import './missing.css'; import './link.svg'; import './fake.test';");
    put('lib/luna/runtime/fake.test.ts','export {};');
    symlinkSync('missing.css',join(dir,'lib/luna/runtime/link.svg'));
    const errors=run().errors;
    expect(errors).toContain('unresolved local dependency or undeclared package ./missing.css');
    expect(errors).toContain('symlink crosses an unchecked module boundary');
    expect(errors).toContain('forbidden dependency lib/luna/runtime/fake.test.ts');
  });
  it.each([
    ["const loader = require; export { loader };", 'computed module loading'],
    ["const loader = module.require; export { loader };", 'computed module loading'],
    ["const { require: loader } = module; export { loader };", 'computed module loading'],
    ["const loader = globalThis['require']; export { loader };", 'computed module loading'],
    ["export { createRequire as loader } from 'node:module';", 'unapproved Node builtin'],
    ["export const loader = import('module');", 'unapproved Node builtin'],
    ["export const lookup = process.getBuiltinModule;", 'computed module loading'],
    ["const { getBuiltinModule } = process; export { getBuiltinModule };", 'computed module loading'],
    ["const { 'getBuiltinModule': lookup } = process; export { lookup };", 'computed module loading'],
    ["const runtime = process; export const lookup = runtime['getBuiltinModule'];", 'computed module loading'],
    ["export const lookup = globalThis.process.getBuiltinModule;", 'computed module loading'],
    ["export { getBuiltinModule as lookup } from 'node:process';", 'unapproved Node builtin'],
    ["export const evaluate = eval;", 'computed module loading'],
    ["export const evaluate = new Function('return 1');", 'computed module loading'],
    ["export const evaluate = globalThis['eval'];", 'computed module loading'],
    ["export { compileFunction } from 'node:vm';", 'unapproved Node builtin'],
    ["export { Worker } from 'node:worker_threads';", 'unapproved Node builtin'],
    ["export { spawn } from 'child_process';", 'unapproved Node builtin'],
    ["export { fork } from 'node:cluster';", 'unapproved Node builtin'],
    ["export { start } from 'node:repl';", 'unapproved Node builtin'],
    ["export { Session } from 'node:inspector/promises';", 'unapproved Node builtin'],
  ])('rejects unverifiable module loader references (%s)', (source, diagnostic)=>{
    put('lib/luna/runtime/index.ts',"export * from '../../adapter';");
    put('lib/adapter.ts',source);
    const result=run('feat/worker');
    expect(result.status).toBe(1);
    expect(result.errors).toContain('lib/adapter.ts '+diagnostic);
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
  it.each([
    ['package.json', (target:string)=>({type:'module',imports:{'#shared':'./'+target}})],
    ['tsconfig.aliases.json', (target:string)=>({compilerOptions:{
      moduleResolution:'bundler',paths:{'#shared':['./'+target]},
    }})],
  ] as const)('checks all shared edges when only %s changes', (metadata, mapping)=>{
    const reusable='lib/lib-common.ts';
    const alternate='lib/lib-alternate.ts';
    const replacement='lib/luna/runtime/index.ts';
    put(reusable,'export const value=1;');
    put(alternate,'export const value=3;');
    put(replacement,'export const value=2;');
    put('lib/metrics/core.ts',"export {value} from '#shared';");
    if (metadata !== 'package.json') put('tsconfig.json',JSON.stringify({extends:'./'+metadata}));
    put(metadata,JSON.stringify(mapping(reusable)));
    base=commit();
    put(metadata,JSON.stringify(mapping(replacement)));
    const result=run('review/dependency');
    expect(result.status).toBe(1);
    expect(result.errors).toContain('lib/metrics/core.ts forbidden dependency '+replacement);
    put(metadata,JSON.stringify(mapping(alternate)));
    expect(run('review/dependency')).toEqual({status:0,errors:''});
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
  it('allows a module whose declaration references legacy types without a runtime edge',()=>{
    put('lib/ai/agent/jobState.ts','export type Owner=number;');
    base=commit();
    put('lib/luna/runtime/index.ts',"export * from '../../port.js';");
    put('lib/port.d.ts',"import {Owner} from './ai/agent/jobState'; export declare const value: Owner;");
    put('lib/port.js','export const value=1;');
    expect(run()).toEqual({status:0,errors:''});
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
  it('checks inherited control changes against the exact approved main blobs',()=>{
    const control='scripts/guards/run-all.mjs';
    const proof='tests/safeguard.test.ts';
    put(control,'// reviewed launcher');
    put(proof,"import {it,expect} from 'vitest'; import {sales} from '../lib/metrics/core'; it('reads sales',()=>expect(sales).toBe(1));");
    const prior=commit();
    put(control,'// independently reviewed candidate');
    const approved=[control,git('rev-parse',prior+':'+control),git('hash-object',control),
      'approved change',proof,git('hash-object',proof),'retire after migration'].join(' | ');
    put(control,'// reviewed launcher');
    put(ledger,'| Safeguard change | '+approved+' |\n');
    const main=commit();

    put(control,'// unapproved inherited launcher');
    put(legacy,'export const run = 2;');
    put('lib/metrics/core.ts',"export * from '@/lib/ai/conversations/agentRunner.server';");
    base=commit();
    const rejected=run('stacked/worker',main);
    expect(rejected.errors).toContain(control+':1: missing independently reviewed');
    expect(rejected.errors).toContain(legacy+':1: missing independently reviewed');
    expect(rejected.errors).toContain('lib/metrics/core.ts forbidden dependency');
    put(control,'// independently reviewed candidate');
    put(legacy,'export const run = 1;');
    put('lib/metrics/core.ts','export const sales = 1;');
    base=commit();
    expect(run('stacked/worker',main)).toEqual({status:0,errors:''});
  });
  it('permits unrelated DB registrations while retaining the independent oracle',()=>{
    put('scripts/db/run-all.sh','node scripts/db/luna-engine-race.mjs\n'); base=commit();
    put('scripts/db/run-all.sh','node scripts/db/luna-engine-race.mjs\nsql_step unrelated.sql "Other service"\n');
    expect(run('feature/database')).toEqual({status:0,errors:''});
    put('scripts/db/run-all.sh','sql_step unrelated.sql "Other service"\n');
    expect(run('feature/database').errors).toContain('retain the registered');
    put('scripts/db/run-all.sh','# node scripts/db/luna-engine-race.mjs\n');
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
it('requires the approved file and every test to actually execute',()=>{
  const file='tests/repair.test.ts';
  const row={name:'/repo/'+file,status:'passed',assertionResults:[{status:'passed'}]};
  const results={testResults:[row],numTotalTests:1,numPassedTests:1,
    numFailedTests:0,numPendingTests:0,numTodoTests:0};
  expect(verifyExactRegression(results,'/repo',file).passed).toBe(1);
  expect(()=>verifyExactRegression({...results,testResults:[{...row,name:'/repo/other/'+file}]},'/repo',file)).toThrow('exact approved');
  expect(()=>verifyExactRegression({...results,testResults:[row,row]},'/repo',file)).toThrow('exact approved');
  expect(()=>verifyExactRegression({...results,testResults:[{...row,assertionResults:[]}]},'/repo',file)).toThrow();
  expect(()=>verifyExactRegression({...results,numPendingTests:1},'/repo',file)).toThrow();
});
it('fails when two engines run, a destination receives a duplicate, or the database lacks a verified receipt',()=>{
  const one={pin:'legacy', executions:['legacy'], deliveries:['key'], token:'key',
    runs:[{engine:'legacy',status:'completed'}],effects:[{state:'verified',receipt_ref:'gmail:key',provider_message_id:'key',provider_state:'verified'}]};
  expect(()=>verifyRace(one)).not.toThrow();
  for (const change of [{executions:['legacy','replacement']},{deliveries:['key','key']},{effects:[{...one.effects[0],provider_message_id:'other'}]},
    {runs:[...one.runs,...one.runs]},{effects:[{state:'uncertain',receipt_ref:null}]}])
    expect(()=>verifyRace({...one,...change})).toThrow();
});
