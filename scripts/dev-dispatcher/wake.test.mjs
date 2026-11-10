import test from 'node:test';
import assert from 'node:assert/strict';
import {nextWake,scheduleSelfWake,dispatchReceiptWake} from './wake.mjs';
import {loadSettings} from './settings.mjs';
const one=loadSettings(),two=structuredClone(one);
two.repo='another/stylit';two.queue.repo=two.repo;two.ledger.repo='another/stylit-ledger';
two.chatgpt.project_url='https://chatgpt.com/g/g-p-stylit';
two.chatgpt.project_id='stylit';two.chatgpt.account_label='Stylit owner';
two.chatgpt.project_name='Stylit';two.muse.space='stylit-muse';
const at=Date.parse('2026-11-10T21:00:00Z');
const state={tasks:{X:{github_state:'open',draft:false,ci_state:'success',codex_state:'pending',
 head_sha:'a'.repeat(40),ready_transition_at:new Date(at).toISOString(),
 last_github_activity:new Date(at).toISOString()}},actions:{}};
test('isolated second repository settings generate distinct wake and no shared target',()=>{
 const a=nextWake(state,at,one),b=nextWake(state,at,two);
 assert.equal(a.due_at,new Date(at+300000).toISOString());assert.notEqual(a.key,b.key);
 assert.equal(nextWake(state,at+300001,one),null);
});
test('Muse retries schedule 15-minute self-wake independent of cron',()=>{
 const s={tasks:{},actions:{x:{status:'planned',delivery_owner:'muse',
 created_at:new Date(at).toISOString()}}};
 assert.equal(nextWake(s,at,one).reason,'muse_retry');
 assert.equal(nextWake(s,at,one).due_at,new Date(at+900000).toISOString());
});
test('settle reservation sends exactly one delayed workflow dispatch',async()=>{
 let latest=structuredClone(state),calls=0;
 const ledger={transaction:async fn=>{const out=await fn(structuredClone(latest));
  if(out===null)return {committed:false,state:latest};latest=out;return {committed:true,state:latest};}};
 const fetchFn=async(url,o)=>{calls++;assert.ok(url.includes(one.repo));
  assert.equal(JSON.parse(o.body).inputs.due_at,new Date(at+300000).toISOString());
  return {ok:true,status:204};};
 assert.equal((await scheduleSelfWake({ledger,token:'mock',config:one,now:at,fetchFn})).status,'requested');
 assert.equal((await scheduleSelfWake({ledger,token:'mock',config:one,now:at,fetchFn})).status,'unchanged');
 assert.equal(calls,1);
});
test('authenticated Muse receipt and owner yes wake immediately without cron',async()=>{
 let payloads=[];const fetchFn=async(u,o)=>{assert.ok(u.includes(one.repo));
  payloads.push(JSON.parse(o.body));return {ok:true,status:204};};
 await dispatchReceiptWake({token:'mock',event:'dispatcher_receipt',fetchFn});
 await dispatchReceiptWake({token:'mock',event:'dispatcher_owner_reply',fetchFn});
 await dispatchReceiptWake({token:'mock',event:'dispatcher_delayed',fetchFn});
 assert.deepEqual(payloads.map(x=>x.event_type),['dispatcher_receipt','dispatcher_owner_reply','dispatcher_delayed']);
 await assert.rejects(dispatchReceiptWake({repo:two.repo,token:'mock',fetchFn}),/cross-project/);
});
