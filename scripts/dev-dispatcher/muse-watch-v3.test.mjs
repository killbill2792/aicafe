import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMuseHealth,inspectMuseEligibleTasks,museRecoveryCandidates,planMuseBacklog,
 deliverMuseRecovery,reconcileMuseBacklog,runMuseWatch} from './muse-watch-v3.mjs';
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
   approval_hash:'a'.repeat(64),
   conversation_ref:'https://chatgpt.com/c/existing',
   last_submission_at:'2026-11-11T09:00:00Z',status:'assigned'}},
   actions:{original:{task_id:'T2',type:'assign',status:'submitted',delivery_owner:'muse',
     delivery:{provider:'chatgpt',intent:'start_new_chat',conversation_url:null,
       approval_hash:'a'.repeat(64),prompt_hash:'b'.repeat(64)},
     receipt:{courier:'muse',prompt_hash:'b'.repeat(64),
       conversation_url:'https://chatgpt.com/c/existing'}}},
   owner_alerts:{},updated_at:now,
   schedule_health:{last_schedule_at:now}};
 const health=inspectMuseHealth(s,{now});
 assert.equal(health.incidents[0].kind,'DELIVERED_TASK_NO_PR');
 assert.equal(health.incidents[0].action,'MUSE_INSPECT_CHAT_AND_RECONCILE');
 assert.equal(museRecoveryCandidates(health,s,identity)[0].intent,'RECONCILE');
 const forged={...s,actions:{}};
 assert.equal(inspectMuseHealth(forged,{now}).incidents.some(x=>x.kind==='DELIVERED_TASK_NO_PR'),false);
});


test('429 cooldown survives repeated polls and stops GitHub wake storm',async()=>{
 const req=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity);
 const start=planMuseBacklog(null,req,now);
 let count=0;
 const limited=await deliverMuseRecovery(start,{token:'test',now,fetchImpl:async()=>{
  count++;return {status:429,headers:{get:k=>k==='retry-after'?'1800':null}};
 }});
 assert.equal(count,1);
 assert.equal(limited.backlog.api_pause_until,'2026-11-11T10:30:00.000Z');
 const later='2026-11-11T10:05:00Z';
 const candidates=museRecoveryCandidates(inspectMuseHealth(state,{now:later}),state,{...identity,now:later});
 const after=planMuseBacklog(limited.backlog,candidates,later);
 const old=Object.values(after.items).find(x=>x.request.intent==='RECONCILE');
 assert.equal(old.next_retry_at,'2026-11-11T10:30:00.000Z');
 let retried=0;
 const paused=await deliverMuseRecovery(after,{token:'test',now:later,fetchImpl:async()=>{
  retried++;return {status:204};
 }});
 assert.equal(retried,0);
 assert.equal(paused.results[0].status,'API_PAUSED');
 const due='2026-11-11T10:31:00Z';
 const refreshed=museRecoveryCandidates(inspectMuseHealth(state,{now:due}),state,{...identity,now:due});
 const newer=planMuseBacklog(after,refreshed,due);
 const item=Object.values(newer.items).find(x=>x.request.intent==='RECONCILE');
 assert.equal(item.request.requested_at,new Date(due).toISOString());
 assert.notEqual(item.request.request_id,old.request.request_id);
});
test('GitHub acknowledged wake is not resent on the next minute',()=>{
 const request=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity)[0];
 const first=planMuseBacklog(null,[request],now);
 const ack=reconcileMuseBacklog(first,{...state,recovery_requests:{
  [request.request_id]:{status:'OBSERVED',checked_at:now,reason:'reconciled'}}});
 const later='2026-11-11T10:03:00Z';
 const refreshed=museRecoveryCandidates(inspectMuseHealth(state,{now:later}),state,{...identity,now:later});
 const after=planMuseBacklog(ack,refreshed,later);
 const row=Object.values(after.items).find(x=>x.request.intent==='RECONCILE');
 assert.equal(row.status,'GITHUB_ACKNOWLEDGED');
 assert.equal(row.request.request_id,request.request_id);
});
test('403 without rate-limit evidence remains unclassified with safe cooldown',async()=>{
 const request=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity)[0];
 const input=planMuseBacklog(null,[request],now);
 const r=await deliverMuseRecovery(input,{token:'test',now,
  fetchImpl:async()=>({status:403,headers:{get:()=>null}})});
 const item=Object.values(r.backlog.items)[0];
 assert.match(item.last_error,/rate limit or authorization unverified/);
 assert.equal(item.next_retry_at,'2026-11-11T11:00:00.000Z');
 assert.equal(r.backlog.api_pause_until,item.next_retry_at);
});


test('Muse sees precise GitHub stale-head rejection and does not flood replays',()=>{
 const request=museRecoveryCandidates(inspectMuseHealth(state,{now}),state,identity)[0];
 const pending=planMuseBacklog(null,[request],now);
 const acknowledged=reconcileMuseBacklog(pending,{...state,recovery_rejections:{
   [request.request_id]:{reason:'stale_head',at:now}}});
 const one=Object.values(acknowledged.items)[0];
 assert.equal(one.status,'GITHUB_REJECTED');
 assert.equal(one.verified_reason,'stale_head');
 const later='2026-11-11T10:02:00Z';
 const fresh=museRecoveryCandidates(inspectMuseHealth(state,{now:later}),state,
   {...identity,now:later})[0];
 const next=planMuseBacklog(acknowledged,[fresh],later);
 assert.equal(Object.values(next.items)[0].request.request_id,request.request_id);
});

test('Muse host monitor preserves recovery backlog atomically and privately',async()=>{
 const fs=await import('node:fs/promises');
 const path=await import('node:path');
 const os=await import('node:os');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'muse-watch-v3-'));
 const ledgerPath=path.join(dir,'ledger.json'),backlogPath=path.join(dir,'backlog.json');
 try{
  await fs.writeFile(ledgerPath,JSON.stringify(state));
  const input={ledgerPath,backlogPath,repo:identity.repo,actor:identity.actor,
    token:null,now};
  const one=await runMuseWatch(input);
  assert.equal(one.backlog_path,backlogPath);
  const file=JSON.parse(await fs.readFile(backlogPath,'utf8'));
  assert.ok(Object.keys(file.items).length>0);
  assert.ok(Object.values(file.items).every(x=>x.status==='QUEUED'));
  const two=await runMuseWatch(input);
  assert.deepEqual(JSON.parse(await fs.readFile(backlogPath,'utf8')),file);
  assert.equal((await fs.stat(backlogPath)).mode&0o777,0o600);
  assert.ok(!(await fs.readdir(dir)).some(x=>x.includes('.tmp-')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('Muse detects an old pending CI head without claiming failure or completion',()=>{
 const s={...state,tasks:{T1:{...state.tasks.T1,draft:false,ci_state:'pending',
  head_first_seen_at:'2026-11-11T09:00:00Z',
  last_commit_at:'2026-11-11T09:00:00Z'}},
  schedule_health:{last_schedule_at:now},updated_at:now};
 const health=inspectMuseHealth(s,{now});
 assert.ok(health.incidents.some(i=>i.kind==='CI_PENDING_STALE'));
 assert.ok(museRecoveryCandidates(health,s,identity).some(x=>x.intent==='RECONCILE'));
 assert.ok(!JSON.stringify(health).includes('CI_FAILED'));
});


test('missing PR writer becomes a precise Muse owner incident, not repeated impossible POSTs',()=>{
 const chat='https://chatgpt.com/c/approved-chat';
 const root={task_id:'T2',status:'assigned',approved:true,
   approval_hash:'a'.repeat(64),conversation_ref:chat,
   last_submission_at:'2026-11-11T09:00:00Z'};
 const delivered={task_id:'T2',type:'assign',status:'submitted',delivery_owner:'muse',
   delivery:{provider:'chatgpt',intent:'start_new_chat',
     conversation_url:null,approval_hash:'a'.repeat(64),prompt_hash:'b'.repeat(64)},
   receipt:{courier:'muse',prompt_hash:'b'.repeat(64),conversation_url:chat}};
 for(const reason of ['missing_pr_creator_install_token','pr_creator_permission_denied']){
   const s={...state,updated_at:now,schedule_health:{last_schedule_at:now},
     tasks:{T2:{...root,github_effects:{CREATE_DRAFT_PR:{
       operation:'CREATE_DRAFT_PR',status:'blocked',reason}}}},
     actions:{initial:delivered},owner_alerts:{}};
   const health=inspectMuseHealth(s,{now});
   assert.deepEqual(health.incidents.map(x=>x.kind),['GITHUB_PR_WRITE_UNAVAILABLE']);
   assert.equal(health.incidents[0].action,'MUSE_NOTIFY_OWNER');
   assert.equal(health.incidents[0].reason,reason);
   assert.deepEqual(museRecoveryCandidates(health,s,identity),[],
     'No repeated GitHub create action while writer permission is unavailable');
   const unsigned={...s,actions:{}};
   assert.equal(inspectMuseHealth(unsigned,{now}).incidents.length,0,
     'Unsigned chat URLs must not generate owner credential incidents');
 }
});

test('5-minute Codex warning does not automatically request a second review',()=>{
 const base={...state,tasks:{T1:{...state.tasks.T1,draft:false,
   ready_transition_at:'2026-11-11T09:55:00Z',ci_state:'success',codex_state:'pending'}}};
 const health=inspectMuseHealth(base,{now});
 const issue=health.incidents.find(x=>x.kind==='CODEX_NOT_RECEIVED');
 assert.equal(issue.age_minutes,5);
 assert.equal(issue.action,'MUSE_NOTIFY_OWNER');
 assert.ok(!museRecoveryCandidates(health,base,identity)
   .some(r=>r.intent==='REQUEST_CODEX_IF_ELIGIBLE'));
});
test('10-minute unchanged ready head triggers one bounded safe recovery request',()=>{
 const base={...state,tasks:{T1:{...state.tasks.T1,draft:false,
   ready_transition_at:'2026-11-11T09:50:00Z',ci_state:'success',codex_state:'pending'}}};
 const health=inspectMuseHealth(base,{now});
 const issue=health.incidents.find(x=>x.kind==='CODEX_NOT_RECEIVED');
 assert.equal(issue.age_minutes,10);
 assert.equal(issue.action,'REQUEST_CODEX_IF_ELIGIBLE');
 const requests=museRecoveryCandidates(health,base,identity);
 assert.equal(requests.filter(x=>x.intent==='REQUEST_CODEX_IF_ELIGIBLE').length,1);
 const backlog=planMuseBacklog(null,requests,now);
 assert.deepEqual(planMuseBacklog(backlog,requests,now),backlog);
});
test('integrated parent suggests proposed scope for owner without auto-authorization',()=>{
 const queue={merged_code_only:[{id:'T1'}],tasks:[{id:'E2',state:'proposed',
   depends_on:['T1'],edits:[],uses:[],acceptance:['owner verified scope'],brief:'owner plan'}]};
 const completed={...state,tasks:{T1:{...state.tasks.T1,status:'integrated_proven',
   integration_proof:{conclusion:'success'}}}};
 const health=inspectMuseHealth(completed,{now,queue});
 const notice=health.incidents.find(x=>x.kind==='SCOPE_PROPOSAL_READY');
 assert.equal(notice.task_id,'E2');
 assert.equal(notice.action,'MUSE_NOTIFY_OWNER');
 assert.ok(!museRecoveryCandidates(health,completed,identity)
   .some(r=>r.task_id==='E2'));
 const notProven={...completed,tasks:{T1:{...completed.tasks.T1,
   integration_proof:{conclusion:'pending'}}}};
 assert.ok(!inspectMuseHealth(notProven,{now,queue}).incidents
   .some(x=>x.kind==='SCOPE_PROPOSAL_READY'));
});
test('invalid Codex escalation configuration fails before dispatch',()=>{
 assert.throws(()=>inspectMuseHealth(state,{now,codexWarnMinutes:10,
   codexEscalateMinutes:5}),/Invalid watchdog configuration/);
});
