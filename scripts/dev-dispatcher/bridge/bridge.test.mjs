import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { validateHandoff, pendingActions, agentInstruction, fetchLedger, reserveReceipt, runOnce, invokeOpenClaw } from './bridge.mjs';
const delivery = { version: 1, action_id:'assign:6', project:{id:'aicafe',name:'AI CAFE'}, provider:'chatgpt',
  intent:'start_new_chat', conversation_url:null, task_id:'6', prompt:'Approved task.'};
const action = {key:'assign:6',task_id:'6',type:'assign',status:'planned',created_at:'2026-01-01',delivery};
const record = {approved:true, agent:'chatgpt'};
const state = {version:1, tasks:{'6':record}, actions:{'assign:6':(({key,...rest}) => rest)(action)}};
const b64 = str => Buffer.from(JSON.stringify(str)).toString('base64');
const mockFetch = async (url, opts) => {
  assert.match(opts.headers.Authorization,/^Bearer /);
  return url.endsWith('/contents/dispatcher/state.json?ref=main') ? {ok:true,json:async()=>({content:b64(state),sha:'abc'})} : {ok:true,json:async()=>({private:true})};
};
test('only planned owner-approved action selected; proposed and unapproved ignored', () => {
  assert.deepEqual(pendingActions(state).map(x=>x.key), ['assign:6']);
  assert.equal(validateHandoff(action,{...record,approved:false}),false);
  assert.equal(validateHandoff({...action, status:'submitted_unverified'},record),false);
  assert.equal(validateHandoff({...action, type:'repair_ci'},record),false);
});
test('no chat content read; task instruction restricts browser', () => {
  const text=agentInstruction(action);
  assert.match(text,/existing authenticated OpenClaw Chrome/);
  assert.match(text,/Do not read, summarize, collect/);
  assert.match(text,/--- BEGIN APPROVED INSTRUCTION ---/);
});
test('rejects tampered or mismatched targets',()=>{
  const t={...action, type:'repair_ci', delivery:{...delivery,intent:'continue_existing_chat',conversation_url:'https://bad.example/c/a'}};
  assert.equal(validateHandoff(t,{...record,conversation_ref:'https://bad.example/c/a'}),false);
  assert.equal(validateHandoff({...action,head_sha:'a'}, {...record, head_sha:'b'}),false);
});
test('fetch requires private repo',async()=>{
  const result=await fetchLedger({repo:'owner/private',token:'test',fetchImpl:mockFetch});
  assert.equal(result.tasks['6'].approved,true);
  await assert.rejects(fetchLedger({repo:'owner/public',token:'test',fetchImpl:async()=>({ok:true,json:async()=>({private:false})})}),/private/);
});
test('local receipts cannot be reserved twice', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dave-test-'));
  try {await reserveReceipt(dir,action);await assert.rejects(reserveReceipt(dir,action),{code:'EEXIST'});}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('dry-run consumes no model and never sends',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dave-test-'));
  try {const a=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl:mockFetch});assert.equal(a.status,'dry_run');
    assert.equal((await fs.readdir(dir)).length,0);} finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('single send becomes unverified; never resend same action; credentials are not inherited',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dave-test-'));
  try {
    let sent=0;
    const spawnImpl=(cmd,args,opts)=>{sent++;assert.equal(opts.env.DISPATCH_LEDGER_READ_TOKEN,undefined);
      assert.deepEqual(args.slice(0,3),['agent','--session-key','queue-aicafe-6']);
      const p=new EventEmitter();p.kill=()=>{};queueMicrotask(()=>p.emit('close',0));return p;};
    process.env.DISPATCH_LEDGER_READ_TOKEN='secret';
    const r=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl:mockFetch,
      sendEnabled:true,invoke:(a,opts)=>invokeOpenClaw(a,{...opts,spawnImpl})});
    assert.equal(r.status,'agent_turn_completed_delivery_unverified');
    const r2=await runOnce({repo:'owner/private',token:'test',receiptDir:dir,fetchImpl:mockFetch,
      sendEnabled:true,invoke:()=>{throw Error('must not resend')}});
    assert.equal(r2.status,'idle');assert.equal(sent,1);
  } finally {delete process.env.DISPATCH_LEDGER_READ_TOKEN;await fs.rm(dir,{recursive:true,force:true});}
});
