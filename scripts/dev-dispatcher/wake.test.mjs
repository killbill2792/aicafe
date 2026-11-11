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
 const overdue=nextWake(state,at+300001,one);
 assert.equal(overdue.reason,'codex_settle');
 assert.equal(overdue.due_at,new Date(at+305001).toISOString());
 assert.equal(overdue.key,a.key);
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
 await dispatchReceiptWake({token:'mock',event:'dispatcher_owner_instruction',fetchFn});
 await dispatchReceiptWake({token:'mock',event:'dispatcher_delayed',fetchFn});
 assert.deepEqual(payloads.map(x=>x.event_type),['dispatcher_receipt','dispatcher_owner_reply','dispatcher_owner_instruction','dispatcher_delayed']);
 await assert.rejects(dispatchReceiptWake({repo:two.repo,token:'mock',fetchFn}),/cross-project/);
});

test('automatic Ready-triggered Codex receives a durable 20-minute watchdog wake',()=>{
 const s=structuredClone(state),r=s.tasks.X,sha=r.head_sha;
 r.codex_review_requested_sha=sha;
 const due=nextWake(s,at,one);
 assert.equal(due.reason,'codex_watchdog');
 assert.equal(due.due_at,new Date(at+20*60000).toISOString());
 assert.equal(nextWake(s,at,one).key,due.key);
 const overdue=nextWake(s,at+20*60000+1,one);
 assert.equal(overdue.reason,'codex_watchdog');
 assert.equal(overdue.due_at,new Date(at+20*60000+5001).toISOString());
 assert.equal(overdue.key,due.key);
 r.codex_in_progress_sha=sha;
 assert.equal(nextWake(s,at,one),null);
 delete r.codex_in_progress_sha;r.codex_referee_sha=sha;
 assert.equal(nextWake(s,at,one),null);
});

test('missing wake is reissued on same key only after bounded retry lease expires',async()=>{
 const starting={tasks:{},actions:{one:{type:'assign',task_id:'6',status:'planned',
  delivery_owner:'muse',created_at:new Date(at).toISOString()}}};
 let latest=structuredClone(starting),calls=0;
 const ledger={transaction:async fn=>{
  const changed=await fn(structuredClone(latest));
  if(changed===null)return {committed:false,state:latest};
  latest=changed;return {committed:true,state:latest};
 }};
 const seen=[];const fetchFn=async(url,o)=>{
  assert.ok(url.endsWith('/dispatches'));
  seen.push(JSON.parse(o.body).inputs);
  calls++;return {ok:true,status:204};
 };
 const first=await scheduleSelfWake({ledger,token:'mock',config:one,now:at,fetchFn});
 assert.equal(first.status,'requested');
 assert.equal((await scheduleSelfWake({ledger,token:'mock',config:one,now:at+5000,fetchFn})).status,'unchanged');
 const late=await scheduleSelfWake({ledger,token:'mock',config:one,now:at+15*60000+1,fetchFn});
 assert.equal(late.status,'requested');
 assert.equal(late.key,first.key);
 assert.equal(late.due_at,new Date(at+15*60000+5001).toISOString());
 assert.equal(calls,2);
 assert.notEqual(seen[0].due_at,seen[1].due_at);
});

test('one stale Codex wake cannot starve an overdue owner approval notice',()=>{
 const now=at+25*60000;
 const s={tasks:{X:{github_state:'open',draft:false,ci_state:'success',
  codex_state:'pending',head_sha:'a'.repeat(40),
  ready_transition_at:new Date(at).toISOString(),
  last_github_activity:new Date(at).toISOString()}},
  actions:{},owner_alerts:{notice:{status:'planned',delivery_owner:'muse',
    created_at:new Date(at+60000).toISOString()}}};
 const codex=nextWake(s,now,one);
 assert.equal(codex.reason,'codex_settle');
 s.delayed_wake={key:codex.key,status:'requested',
  requested_at:new Date(now).toISOString()};
 const owner=nextWake(s,now+1000,one);
 assert.equal(owner.reason,'owner_notice_retry');
 assert.notEqual(owner.key,codex.key);
 assert.equal(owner.due_at,new Date(now+6000).toISOString());
});

test('multiple overdue wake candidates cannot ping-pong into unlimited workflow runs',async()=>{
 const now=at+25*60000;
 let latest={tasks:{X:{github_state:'open',draft:false,ci_state:'success',
   codex_state:'pending',head_sha:'a'.repeat(40),
   ready_transition_at:new Date(at).toISOString(),
   last_github_activity:new Date(at).toISOString()}},
   actions:{delivery:{status:'planned',type:'assign',delivery_owner:'muse',
     created_at:new Date(at+1000).toISOString()}},
   owner_alerts:{notice:{status:'planned',delivery_owner:'muse',
     created_at:new Date(at+2000).toISOString()}}};
 const ledger={transaction:async fn=>{
  const changed=await fn(structuredClone(latest));
  if(changed===null)return {committed:false,state:latest};
  latest=changed;return {committed:true,state:latest};
 }};
 const delivered=[];const fetchFn=async(_url,o)=>{
  delivered.push(JSON.parse(o.body).inputs.wake_key);
  return {ok:true,status:204};
 };
 for(let i=0;i<3;i++){
  const outcome=await scheduleSelfWake({ledger,token:'mock',config:one,
    now:now+i*1000,fetchFn});
  assert.equal(outcome.status,'requested');
 }
 assert.equal(new Set(delivered).size,3);
 assert.equal(Object.keys(latest.delayed_wake_history).length,3);
 const fourth=await scheduleSelfWake({ledger,token:'mock',config:one,
   now:now+3000,fetchFn});
 assert.equal(fourth.status,'unchanged');
 assert.equal(delivered.length,3);
});
