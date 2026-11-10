import './repair-receipts.test.mjs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createDelivery, approvalSignature } from '../delivery.mjs';
import { signalFor } from '../signal.mjs';
import { validateHandoff, pendingActions, agentInstruction, fetchLedger,
  reserveReceipt, runOnce, invokeOpenClaw, taskHoldFile } from './bridge.mjs';

const sig = 'a'.repeat(64);
const delivery = { version: 1, action_id:'assign:6', project:{id:'aicafe',name:'AI CAFE'},
  approval_hash:sig, provider:'chatgpt', intent:'start_new_chat',
  conversation_url:null, task_id:'6', base_branch:'main', prompt:'Approved task.',
  prompt_hash:createHash('sha256').update('Approved task.').digest('hex') };
const action = {key:'assign:6',task_id:'6',type:'assign',status:'planned',delivery_owner:'dave',created_at:'2026-01-01',delivery};
const record = {approved:true, agent:'chatgpt', approval_hash:sig};
const state = {version:1, tasks:{'6':record},
  actions:{'assign:6':(({key,...rest}) => rest)(action)}};
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const makeFetch = data => async (url, opts) => {
  assert.match(opts.headers.Authorization,/^Bearer /);
  return url.endsWith('/contents/dispatcher/state.json?ref=main')
    ? {ok:true,json:async()=>({content:b64(data),sha:'abc'})}
    : {ok:true,json:async()=>({private:true})};
};
const mockFetch = makeFetch(state);
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(),'dave-bridge-test-'));

test('planned approved delivery selected; changed approval and wrong intent refused', () => {
  assert.deepEqual(pendingActions(state).map(x=>x.key),['assign:6']);
  assert.equal(validateHandoff(action,{...record,approved:false}),false);
  assert.equal(validateHandoff(action,{...record,approval_hash:'b'.repeat(64)}),false);
  assert.equal(validateHandoff({...action,status:'cancelled_approval_changed'},record),false);
  assert.equal(validateHandoff({...action,type:'repair_ci'},record),false);
});
test('agent instruction confines navigation and avoids chat content', () => {
  const text=agentInstruction(action);
  assert.match(text,/existing authenticated OpenClaw Chrome/);
  assert.match(text,/Do not read, summarize, collect/);
  assert.match(text,/--- BEGIN APPROVED INSTRUCTION ---/);
});
test('closed or merged PR repair never delivered, even with matching SHA', () => {
  const url='https://chatgpt.com/c/abc-123';
  const fix={...action,key:'repair:6',type:'repair_ci',head_sha:'sha-one',
    delivery:{...delivery,action_id:'repair:6',intent:'continue_existing_chat',conversation_url:url}};
  const open={...record,pr_number:390,conversation_ref:url,
    head_sha:'sha-one',github_state:'open'};
  assert.equal(validateHandoff(fix,open),true);
  assert.equal(validateHandoff(fix,{...open,github_state:'merged'}),false);
  assert.equal(validateHandoff(fix,{...open,github_state:'not_open_unverified'}),false);
  assert.equal(validateHandoff(fix,{...open,head_sha:'sha-two'}),false);
  assert.equal(validateHandoff(fix,{...open,approved:false}),false);
  assert.equal(validateHandoff({...fix,delivery:{...fix.delivery,conversation_url:'https://evil.example/c/abc'}},open),false);
});
test('fetch requires private repository, never public',async()=>{
  const result=await fetchLedger({repo:'owner/private',token:'test',fetchImpl:mockFetch});
  assert.equal(result.tasks['6'].approved,true);
  await assert.rejects(fetchLedger({repo:'owner/public',token:'test',
    fetchImpl:async()=>({ok:true,json:async()=>({private:false})})}),/private/);
});
test('one action receipt cannot be reserved twice',async()=>{
  const dir=await tempDir();
  try { await reserveReceipt(dir,action);
    await assert.rejects(reserveReceipt(dir,action),{code:'EEXIST'}); }
  finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('dry-run never starts model, writes no receipts',async()=>{
  const dir=await tempDir();
  try {const a=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl:mockFetch});
    assert.equal(a.status,'dry_run');assert.equal((await fs.readdir(dir)).length,0);}
  finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a finished unverified action retains hold, no second key for same task',async()=>{
  const dir=await tempDir();
  try {
    let sent=0;
    const spawnImpl=(cmd,args,opts)=>{
      sent++;assert.equal(opts.env.DISPATCH_LEDGER_READ_TOKEN,undefined);
      assert.equal(opts.env.GH_TOKEN,undefined);
      assert.deepEqual(args.slice(0,3),['agent','--session-key','queue-aicafe-6']);
      const p=new EventEmitter();p.kill=()=>{};queueMicrotask(()=>p.emit('close',0));return p;
    };
    process.env.DISPATCH_LEDGER_READ_TOKEN='secret';process.env.GH_TOKEN='repo-credential';
    const first=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl:mockFetch,
      sendEnabled:true,invoke:(a,opts)=>invokeOpenClaw(a,{...opts,spawnImpl})});
    assert.equal(first.status,'agent_turn_completed_delivery_unverified');
    const newAction={...action,key:'assign:6:changed',delivery:{...delivery,action_id:'assign:6:changed'},created_at:'2026-01-02'};
    const next={version:1,tasks:state.tasks,actions:{'assign:6:changed':(({key,...rest})=>rest)(newAction)}};
    const second=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,
      fetchImpl:makeFetch(next),sendEnabled:true,invoke:()=>{throw Error('must not send')}});
    assert.equal(second.status,'idle');assert.equal(sent,1);
    const hold=JSON.parse(await fs.readFile(taskHoldFile(dir,action),'utf8'));
    assert.equal(hold.status,'agent_turn_completed_delivery_unverified');
  } finally {delete process.env.DISPATCH_LEDGER_READ_TOKEN;delete process.env.GH_TOKEN;
    await fs.rm(dir,{recursive:true,force:true});}
});
test('in-flight task holds block concurrent workers and different event keys',async()=>{
  const dir=await tempDir();
  let release;
  try {
    const newAction={...action,key:'assign:6:second',delivery:{...delivery,action_id:'assign:6:second'},created_at:'2026-01-02'};
    const next={version:1,tasks:state.tasks,actions:{...state.actions,
      'assign:6:second':(({key,...rest})=>rest)(newAction)}};
    const fetchImpl=makeFetch(next);
    let started;
    const invoked = new Promise(resolve=>{started=resolve;});
    const first=runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl,
      sendEnabled:true,invoke:async()=>{started();return new Promise(resolve=>{release=resolve;});}});
    await invoked;
    const other=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl,
      sendEnabled:true,invoke:()=>{throw Error('concurrent duplicate')}});
    assert.equal(other.status,'idle');
    release('uncertain');
    assert.equal((await first).status,'uncertain');
    assert.equal((await runOnce({repo:'owner/private',token:'test',receiptDir:dir,
      fetchImpl,sendEnabled:true})).status,'idle');
  } finally {if(release)release('uncertain'); await fs.rm(dir,{recursive:true,force:true});}
});
test('actual CLI entry point accepts --dry-run and rejects bad arguments correctly',()=>{
  const cli=fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const env={...process.env};delete env.DISPATCH_LEDGER_REPO;delete env.DISPATCH_LEDGER_READ_TOKEN;
  const dry=spawnSync(process.execPath,[cli,'--dry-run'],{env,encoding:'utf8'});
  assert.equal(dry.status,1);
  assert.match(dry.stderr,/Private ledger repository and read token required/);
  assert.doesNotMatch(dry.stderr,/Usage:/);
  const bad=spawnSync(process.execPath,[cli,'--unexpected'],{env,encoding:'utf8'});
  assert.equal(bad.status,2);assert.match(bad.stderr,/Usage:/);
  const locked=spawnSync(process.execPath,[cli,'--send'],{env,encoding:'utf8'});
  assert.equal(locked.status,2);assert.match(locked.stderr,/Live handoff OFF/);
});

test('Dave never sends Muse-owned actions even when live sending enabled',async()=>{
 const dir=await tempDir();
 try {
  const museAction={...action,delivery_owner:'muse'};
  const next={...state,actions:{'assign:6':(({key,...rest})=>rest)(museAction)}};
  const result=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,
    fetchImpl:makeFetch(next),sendEnabled:true,invoke:()=>{throw Error('must not invoke')}});
  assert.equal(result.status,'idle');
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});


test('v2 reason-specific continuations are signed, head-bound, and visible to pendingActions',()=>{
  const url='https://chatgpt.com/c/abc-123';
  const head='a'.repeat(40);
  const live={...record,pr_number:408,github_state:'open',head_sha:head,
    base_branch:'main',conversation_ref:url};
  const make = (type,actionId,headSha=head) => {
    const prompt='Approved v2 '+type;
    return {...action,key:actionId,task_id:'6',type,head_sha:headSha,
      delivery:{...delivery,action_id:actionId,intent:'continue_existing_chat',
        conversation_url:url,base_branch:'main',prompt,
        prompt_hash:createHash('sha256').update(prompt).digest('hex')}};
  };
  const kinds=['ci_failed','codex_comments','owner_answered','idle_continue'];
  const actions=Object.fromEntries(kinds.map(type=>{
    const id='v2:'+type+':6';
    const item=make(type,id);
    assert.equal(validateHandoff(item,live),true,type);
    assert.equal(validateHandoff(item,{...live,head_sha:'b'.repeat(40)}),false,
      type+' must be current-head only');
    assert.equal(validateHandoff(item,{...live,github_state:'merged'}),false);
    return [id,(({key,...rest})=>rest)(item)];
  }));
  assert.deepEqual(pendingActions({version:1,tasks:{'6':live},actions})
    .map(x=>x.type),kinds);
});

test('parent_merged continuation remains eligible after child head moves, but never before verified main retarget',()=>{
  const url='https://chatgpt.com/c/abc-123',merged='f'.repeat(40);
  const live={...record,pr_number:408,github_state:'open',head_sha:'a'.repeat(40),
    base_branch:'main',conversation_ref:url,parent_merged_sha:merged,
    branch_maintenance_merge_sha:merged,last_parent_rebase_sha:merged};
  const key='parent_merged:6:'+merged,prompt='Verified parent merged: rebase onto main and continue';
  const item={...action,key,task_id:'6',type:'parent_merged',head_sha:null,
    delivery:{...delivery,action_id:key,intent:'continue_existing_chat',
      conversation_url:url,base_branch:'main',prompt,
      prompt_hash:createHash('sha256').update(prompt).digest('hex')}};
  assert.equal(validateHandoff(item,live),true);
  assert.deepEqual(pendingActions({version:1,tasks:{'6':live},
    actions:{[key]:(({key,...rest})=>rest)(item)}}).map(x=>x.key),[key]);
  assert.equal(validateHandoff(item,{...live,head_sha:'b'.repeat(40)}),true);
  for(const rec of [
    {...live,base_branch:'feat/parent'},
    {...live,branch_maintenance_merge_sha:null},
    {...live,last_parent_rebase_sha:null},
    {...live,parent_merged_sha:'e'.repeat(40)},
    {...live,github_state:'merged'},
  ]) assert.equal(validateHandoff(item,rec),false);
  assert.equal(validateHandoff({...item,head_sha:'a'.repeat(40)},live),false);
  assert.equal(validateHandoff({...item,key:key+':retry'},live),false);
  assert.equal(validateHandoff({...item,delivery:{...item.delivery,base_branch:'feat/parent'}},live),false);
});



test('v2 dispatcher nudges pass bridge and opaque wake-up signal without changing receipt identity',()=>{
  const task={id:'6',title:'Continuation',goal:'finish authorized work',
    state:'ready',architecture_approval:{approved:true},exclusive_files:['scripts/owned.mjs'],
    brief:'docs/plans/universal-supervisor-task-briefs.md#task-6'};
  const signature=approvalSignature(task), url='https://chatgpt.com/c/abc-123';
  const head='a'.repeat(40), merged='b'.repeat(40);
  const current={task_id:'6',approved:true,agent:'chatgpt',approval_hash:signature,
    conversation_ref:url,pr_number:390,github_state:'open',head_sha:head,base_branch:'main',
    parent_merged_sha:merged,branch_maintenance_merge_sha:merged,last_parent_rebase_sha:merged};
  for(const type of ['codex_comments','ci_failed','parent_merged','owner_answered','idle_continue']){
    const key=type==='parent_merged'?'parent_merged:6:'+merged:'nudge:'+type;
    const d=createDelivery({task,record:current,action:type,actionId:key});
    const pending={key,task_id:'6',type,status:'planned',delivery_owner:'muse',
      head_sha:type==='parent_merged'?null:head,delivery:d};
    const ledger={version:1,tasks:{'6':current},actions:{[key]:(({key,...a})=>a)(pending)}};
    assert.equal(validateHandoff(pending,current),true,type);
    assert.deepEqual(pendingActions(ledger).map(a=>a.key),[key],type);
    assert.equal(signalFor(ledger,'secret'.repeat(8)).pending_count,1,type);
    assert.equal(d.prompt_hash,createHash('sha256').update(d.prompt).digest('hex'));
    if(type==='parent_merged'){
      assert.equal(validateHandoff(pending,{...current,head_sha:'c'.repeat(40)}),true,
        'verified parent-merge action is head-independent');
      assert.equal(validateHandoff(pending,{...current,branch_maintenance_merge_sha:'c'.repeat(40)}),false);
      assert.equal(validateHandoff(pending,{...current,base_branch:'feat/parent'}),false);
      assert.equal(validateHandoff({...pending,head_sha:head},current),false);
    }else{
      assert.equal(validateHandoff(pending,{...current,head_sha:'c'.repeat(40)}),false,
        type+' must remain exact-head');
    }
  }
  const unknown={...action,type:'unapproved_action'};
  assert.equal(validateHandoff(unknown,record),false);
});
