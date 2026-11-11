import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryIdentity,recoveryEvent,recordRecoveryEvent,settleRecoveryRequests,
  RECOVERY_INTENTS} from './recovery-v3.mjs';
import {projectLifecycle} from './lifecycle-v3.mjs';
const sha='a'.repeat(40),base='b'.repeat(40),now='2026-11-11T10:00:00Z';
const repo='killbill2792/aicafe';
const records={C1:{task_id:'C1',approved:true,pr_number:440,github_state:'open',
  draft:true,head_sha:sha,base_sha:base,base_current:true,ci_state:'success',
  mergeable:true,threads_resolved:true,branch:'feat/aicafe-task-C1'}};
const state={version:1,tasks:records,actions:{},owner_alerts:{}};
const actor='killbill2792',owner=actor;
const signed=(intent='RECONCILE',override={})=>{
 const input={repo,actor,intent,task_id:'C1',pr_number:440,
   expected_head_sha:sha,requested_at:now,...override};
 return {action:'dispatcher_recovery',sender:{login:actor},
   client_payload:{version:1,...input,request_id:recoveryIdentity(input)}};
};
const options={repo,actors:{[actor]:'muse'},owner,records,now};
test('every recovery intent is a closed allowlist',()=>{
 assert.equal(RECOVERY_INTENTS.length,8);
 assert.equal(recoveryEvent(signed('APPROVE_SCOPE'),options).accepted,false);
 assert.equal(recoveryEvent(signed('FORCE_MERGE'),options).accepted,false);
});
test('authenticated current-head request is accepted exactly once',()=>{
 const event=signed('MARK_READY_IF_ELIGIBLE');
 const one=recordRecoveryEvent(state,event,options);
 const two=recordRecoveryEvent(one,event,options);
 assert.equal(Object.keys(two.recovery_requests).length,1);
 assert.equal(Object.values(two.recovery_requests)[0].intent,'MARK_READY_IF_ELIGIBLE');
 assert.deepEqual(two.recovery_requests,one.recovery_requests);
});
test('never trust client-reported actor when GitHub sender mismatches',()=>{
 const event=signed();
 event.sender.login='rogue';
 event.client_payload.actor=actor;
 assert.deepEqual(recoveryEvent(event,options),{accepted:false,reason:'unauthenticated_muse_or_owner'});
 assert.equal(recordRecoveryEvent(state,event,options).recovery_requests,undefined);
});
test('reject SHA mismatch, PR substitution, expiration and forged ID',()=>{
 for(const event of [
   signed('MERGE_IF_ELIGIBLE',{expected_head_sha:'c'.repeat(40)}),
   signed('MERGE_IF_ELIGIBLE',{pr_number:441}),
   signed('RECONCILE',{requested_at:'2026-11-11T09:00:00Z'}),
 ]){
  assert.equal(recoveryEvent(event,options).accepted,false);
 }
 const forged=signed();
 forged.client_payload.request_id='f'.repeat(64);
 assert.equal(recoveryEvent(forged,options).reason,'request_identity_mismatch');
});
test('request is only a wake: neither approvals nor merge rules change',()=>{
 const event=signed('MERGE_IF_ELIGIBLE');
 const one=recordRecoveryEvent(state,event,options);
 assert.deepEqual(one.tasks,state.tasks);
 const view=projectLifecycle(one,{tasks:[{id:'C1',depends_on:[],acceptance:['test'],edits:['a.ts']}]},now);
 const checked=settleRecoveryRequests(one,view,now);
 const item=Object.values(checked.recovery_requests)[0];
 assert.equal(item.status,'PENDING');
 assert.match(item.reason,/draft_pr/);
 assert.equal(checked.tasks.C1.draft,true);
});
test('a verified subsequent PR state satisfies a pending request',()=>{
 const event=signed('MARK_READY_IF_ELIGIBLE');
 const one=recordRecoveryEvent(state,event,options);
 one.tasks.C1.draft=false;
 const view=projectLifecycle(one,{tasks:[{id:'C1',depends_on:[],acceptance:['test'],edits:['a.ts']}]},now);
 assert.equal(Object.values(settleRecoveryRequests(one,view,now).recovery_requests)[0].status,'SATISFIED');
});
test('reconcile observation is not an invented completed merge',()=>{
 const event=signed();
 const one=recordRecoveryEvent(state,event,options);
 const view=projectLifecycle(one,{tasks:[{id:'C1',depends_on:[],acceptance:['test'],edits:['a.ts']}]},now);
 const item=Object.values(settleRecoveryRequests(one,view,now).recovery_requests)[0];
 assert.equal(item.status,'OBSERVED');
 assert.match(item.reason,/not_action_authorized/);
});

test('authorized global reconcile needs no PR or commit head',()=>{
 const input={repo,actor,intent:'RECONCILE',task_id:null,pr_number:null,
   expected_head_sha:null,requested_at:now};
 const ev={action:'dispatcher_recovery',sender:{login:actor},
   client_payload:{version:1,...input,request_id:recoveryIdentity(input)}};
 const parsed=recoveryEvent(ev,options);
 assert.equal(parsed.accepted,true);
 const one=recordRecoveryEvent(state,ev,options);
 const view=projectLifecycle(one,{tasks:[]},now);
 const item=Object.values(settleRecoveryRequests(one,view,now).recovery_requests)[0];
 assert.equal(item.status,'OBSERVED');
 assert.equal(item.reason,'global_reconcile_wake_not_evidence_of_effect');
});
