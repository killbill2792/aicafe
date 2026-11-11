import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMuseHealth,inspectMuseEligibleTasks,museRecoveryCandidates,planMuseBacklog,
 deliverMuseRecovery,reconcileMuseBacklog} from './muse-watch-v3.mjs';
const now='2026-11-11T10:00:00Z',sha='a'.repeat(40);
const state={version:1,updated_at:'2026-11-11T09:00:00Z',
 schedule_health:{last_schedule_at:'2026-11-11T09:00:00Z'},
 tasks:{T1:{pr_number:441,head_sha:sha,github_state:'open',draft:true,
   ci_state:'success',last_commit_at:'2026-11-11T09:00:00Z'}},actions:{},owner_alerts:{}};
const identity={repo:'killbill2792/aicafe',actor:'killbill2792',now};
test('detects never-run or stale dispatcher independent of unchanged ledger',()=>{
 const health=inspectMuseHealth(state,{now});
 assert.deepEqual(health.incidents.map(i=>i.kind),
   ['GITHUB_SCHEDULE_STALE','LEDGER_STALE','SUSPECTED_CODING_STALL']);
 const requests=museRecoveryCandidates(health,state,identity);
 assert.equal(requests.length,2);
 assert.equal(requests[0].intent,'RECONCILE');
 assert.equal(requests[0].task_id,null);
 assert.equal(requests[1].intent,'CHECK_STALL');
});
test('a green CI job does not mean chat finished',()=>{
 const health=inspectMuseHealth(state,{now});
 assert.deepEqual(health.tasks_suspected_stalled,['T1']);
 assert.ok(!JSON.stringify(health).includes('coding_complete'));
});
test('Codex missing after ready state triggers safe GitHub check',()=>{
 const s={...state,tasks:{T1:{...state.tasks.T1,draft:false,
   ready_transition_at:'2026-11-11T09:00:00Z',codex_state:'pending'}}};
 const health=inspectMuseHealth(s,{now});
 assert.ok(health.incidents.some(i=>i.kind==='CODEX_NOT_RECEIVED'));
 assert.ok(museRecoveryCandidates(health,s,identity).some(r=>r.intent==='REQUEST_CODEX_IF_ELIGIBLE'));
});
test('planned Muse notices are not mistaken for delivered browser messages',()=>{
 const s={...state,actions:{act:{task_id:'T1',status:'planned',delivery_owner:'muse',
    created_at:'2026-11-11T09:00:00Z'}},
    owner_alerts:{n:{delivery_owner:'muse',status:'planned'}}};
 const health=inspectMuseHealth(s,{now});
 assert.ok(health.incidents.some(i=>i.kind==='MUSE_DELIVERY_PENDING'));
 assert.ok(health.incidents.some(i=>i.kind==='OWNER_NOTICES_OUTSTANDING'));
});
test('one stable pending recovery per issue; ack requires GitHub ledger receipt',()=>{
 const health=inspectMuseHealth(state,{now});
 const req=museRecoveryCandidates(health,state,identity);
 const first=planMuseBacklog(null,req,now);
 const second=planMuseBacklog(first,req,now);
 assert.deepEqual(second,first);
 const ack=reconcileMuseBacklog(first,{...state,recovery_requests:{
   [req[0].request_id]:{status:'OBSERVED',checked_at:now,reason:'reconciled'}}});
 const row=Object.values(ack.items).find(x=>x.request.intent==='RECONCILE');
 assert.equal(row.status,'GITHUB_ACKNOWLEDGED');
});
test('GitHub 204 means accepted event only, not completed task',async()=>{
 let calls=0;
 const req=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity);
 const input=planMuseBacklog(null,req,now);
 const out=await deliverMuseRecovery(input,{token:'test',now,fetchImpl:async(url,options)=>{
   calls++;
   assert.match(url,/github.com\/repos\/killbill2792\/aicafe\/dispatches/);
   assert.equal(JSON.parse(options.body).event_type,'dispatcher_recovery');
   return {status:204};
 }});
 assert.equal(calls,req.length);
 assert.ok(Object.values(out.backlog.items).every(x=>x.status==='SENT_UNVERIFIED'));
 assert.ok(Object.values(out.backlog.items).every(x=>x.status!=='GITHUB_ACKNOWLEDGED'));
});
test('rate limit and transport failure are backlogged without false success',async()=>{
 const req=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity);
 const input=planMuseBacklog(null,req.slice(0,1),now);
 const limited=await deliverMuseRecovery(input,{token:'test',now,
  fetchImpl:async()=>({status:429,headers:{get:()=> '1800'}})});
 const item=Object.values(limited.backlog.items)[0];
 assert.equal(item.status,'RETRYABLE');
 assert.equal(item.next_retry_at,'2026-11-11T10:30:00.000Z');
 let called=0;
 const paused=await deliverMuseRecovery(input,{token:'test',now,
  apiPauseUntil:'2026-11-11T10:40:00Z',
  fetchImpl:async()=>{called++;return {status:204};}});
 assert.equal(called,0);
 assert.equal(paused.results[0].status,'API_PAUSED');
});
test('no wake credential means safe queued action, not imaginary delivery',async()=>{
 const req=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity);
 const input=planMuseBacklog(null,req.slice(0,1),now);
 const out=await deliverMuseRecovery(input,{token:null,now,
  fetchImpl:async()=>{throw Error('not called');}});
 assert.equal(out.results[0].status,'WAITING_FOR_AUTHORIZED_WAKE_TOKEN');
 assert.equal(Object.values(out.backlog.items)[0].status,'QUEUED');
});


test('Muse independently reads signed queue and requests GitHub validation for newly eligible tasks',()=>{
 const queue={tasks:[{id:'new',depends_on:[],acceptance:['evidence'],
  brief:'docs/plans/brief.md',edits:['lib/new.ts'],state:'ready',
  architecture_approval:{approved:true}}],merged_code_only:[],
  capacity:{chatgpt:1,claude:0}};
 const s={...state,tasks:{},actions:{},owner_alerts:{},
  schedule_health:{last_schedule_at:now},updated_at:now};
 assert.deepEqual(inspectMuseEligibleTasks(queue,s).map(x=>x.task_id),['new']);
 const health=inspectMuseHealth(s,{now,queue});
 assert.equal(health.incidents[0].kind,'UNASSIGNED_APPROVED_TASKS');
 assert.equal(museRecoveryCandidates(health,s,identity)[0].intent,'RECONCILE');
 const held={...s,owner_controls:{revision:1,per_task:{new:{pause_new_dispatch:true}}}};
 assert.deepEqual(inspectMuseEligibleTasks(queue,held),[]);
});


test('Muse detects a delivered pre-PR task without inventing ChatGPT completion',()=>{
 const s={...state,tasks:{T2:{task_id:'T2',approved:true,
   conversation_ref:'https://chatgpt.com/c/existing',
   last_submission_at:'2026-11-11T09:00:00Z',status:'assigned'}},
   actions:{},owner_alerts:{},updated_at:now,
   schedule_health:{last_schedule_at:now}};
 const health=inspectMuseHealth(s,{now});
 assert.equal(health.incidents[0].kind,'DELIVERED_TASK_NO_PR');
 assert.equal(health.incidents[0].action,'MUSE_INSPECT_CHAT_AND_RECONCILE');
 assert.equal(museRecoveryCandidates(health,s,identity)[0].intent,'RECONCILE');
});
