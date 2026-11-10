import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {renderPrivateQueue,publishPrivateQueue,PRIVATE_VIEW_PATH} from './private-owner-view.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const h='a'.repeat(64),head='b'.repeat(40);
const chat='https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
const actionId='POS0c:repair_ci:current';
const prompt='private test-only instruction not suitable for public Pages';
const task={approved:true,approval_hash:h,head_sha:head,
 github_state:'open',pr_number:406,agent:'chatgpt',conversation_ref:chat,
 status:'blocked_needs_owner',github_owner_question:'Need owner signoff on another file'};
const delivery={version:1,task_id:'POS0c',action_id:actionId,
 provider:'chatgpt',project:{id:'ai-cafe',name:'AI CAFE'},intent:'continue_existing_chat',
 conversation_url:chat,prompt,prompt_hash:sha(prompt),
 base_branch:'main',approval_hash:h};
const state={version:1,updated_at:'2026-11-09T22:55:00Z',
 tasks:{POS0c:task},
 actions:{
 [actionId]:{task_id:'POS0c',type:'repair_ci',status:'planned',head_sha:head,
  delivery_owner:'muse',created_at:'2026-11-09T22:00:00Z',last_wake_at:'2026-11-09T22:45:00Z',
  wake_round:4,delivery},
 'POS0c:repair_ci:old':{task_id:'POS0c',type:'repair_ci',status:'cancelled_stale_head',
   delivery_owner:'muse',created_at:'2026-11-09T20:10:00Z',head_sha:'c'.repeat(40),delivery}
 },
 owner_alerts:{'notice:1':{task_id:'POS0c',pr_number:406,kind:'owner_decision',
  status:'planned',created_at:'2026-11-09T20:05:00Z',
  question:'Approve runner scope; https://chatgpt.com/c/private-123'}}
};

test('private queue shows signed repair even if separate owner question is open',()=>{
 const view=renderPrivateQueue(state);
 assert.match(view,/POS0c/);
 assert.match(view,/Signed\/current-head delivery; browser idle check required/);
 assert.match(view,/blocked_needs_owner|pending|Outstanding owner notices/i);
 assert.match(view,/No verified submission/);
 assert.match(view,/Wake round/);
 assert.match(view,/cancelled_stale_head/);
 assert.match(view,/History only — do not send/);
 assert.match(view,/Open existing chat/);
 assert.match(view,/Original private ledger/);
 assert.doesNotMatch(view,/private test-only instruction not suitable/);
});
test('private queue labels bad head as INELIGIBLE and never calls it submitted',()=>{
 const modified=structuredClone(state);
 modified.actions[actionId].head_sha='c'.repeat(40);
 const view=renderPrivateQueue(modified);
 assert.match(view,/INELIGIBLE — hold; inspect approval\/head\/target/);
 assert.match(view,/No verified submission/);
 assert.doesNotMatch(view,/Signed\/current-head delivery/);
});
test('private queue refuses unexpected repo and missing ledger fields',()=>{
 assert.throws(()=>renderPrivateQueue(state,{repo:'public/repository'}),/Unexpected private queue repository/);
 assert.throws(()=>renderPrivateQueue({tasks:{}}),/Invalid private owner queue state/);
});
test('private queue upsert creates then skips identical content and CAS-updates safely',async()=>{
 const file=renderPrivateQueue(state);
 const calls=[];
 const ledger={repo:'killbill2792/dave-task-queue',
  load:async()=>({state,sha:'ledger-sha'}),
  request:async(path,opts)=>{
   calls.push({path,opts});
   if(path.endsWith('?ref=main'))return {absent:true};
   if(opts?.method==='PUT')return {commit:{sha:'saved-sha'}};
   throw Error('Unexpected '+path);
  }};
 assert.deepEqual(await publishPrivateQueue({ledger}),{status:'created',sha:'saved-sha'});
 assert.equal(calls[1].path,'/contents/'+PRIVATE_VIEW_PATH);
 const payload=JSON.parse(calls[1].opts.body);
 assert.equal(payload.branch,'main');
 assert.equal(Buffer.from(payload.content,'base64').toString('utf8'),file);
 assert.equal(payload.sha,undefined);
 const same={...ledger,request:async(path)=>{
  if(path.endsWith('?ref=main'))return {sha:'oldsha',content:Buffer.from(file).toString('base64')};
  throw Error('Should not overwrite identical content');
 }};
 assert.deepEqual(await publishPrivateQueue({ledger:same}),{status:'unchanged'});
 const changed={...ledger,request:async(path,options)=>{
  if(path.endsWith('?ref=main'))return {sha:'oldsha',content:Buffer.from('stale private view').toString('base64')};
  assert.equal(JSON.parse(options.body).sha,'oldsha');
  return {commit:{sha:'newsha'}};
 }};
 assert.deepEqual(await publishPrivateQueue({ledger:changed}),{status:'updated',sha:'newsha'});
});
test('private view never grants approval or invokes a courier browser',()=>{
 const result=renderPrivateQueue(state);
 assert.match(result,/does NOT authorize, send, approve, retry, or merge/);
 assert.match(result,/remains the only action authority/);
 assert.equal(result.includes('BEGIN APPROVED INSTRUCTION'),false);
});
