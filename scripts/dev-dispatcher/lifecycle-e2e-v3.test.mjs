import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLifecycle,recordLifecycleTransitions} from './lifecycle-v3.mjs';
import {inspectMuseHealth,museRecoveryCandidates,planMuseBacklog} from './muse-watch-v3.mjs';
import {recoveryEvent,recordRecoveryEvent,settleRecoveryRequests,recoveryIdentity} from './recovery-v3.mjs';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),m='d'.repeat(40);
const now='2026-11-11T12:00:00Z',repo='killbill2792/aicafe',actor='killbill2792';
const mkTask=(id,deps)=>({id,title:id,depends_on:deps,acceptance:['Real test'],
  state:'ready',edits:['lib/shared.ts'],brief:'docs/plans/brief.md',
  architecture_approval:{approved:true}});
const queue={repo,tasks:[mkTask('CR-A',[]),mkTask('CR-B',['CR-A'])],
  merged_code_only:[],capacity:{chatgpt:2,claude:0}};
const state=()=>({version:1,updated_at:now,tasks:{},actions:{},owner_alerts:{}});
const proposed=(s)=>projectLifecycle(s,queue,now).tasks;
function receipt(s,id,head){
 const key='assign:'+id;
 s.actions[key]={task_id:id,status:'submitted',type:'assign',
   submitted_at:now,receipt:{courier:'muse',prompt_hash:'verified'}};
 s.tasks[id]={task_id:id,approved:true,branch:'feat/aicafe-task-'+id,
   base_branch:id==='CR-A'?'main':'feat/aicafe-task-CR-A',
   conversation_ref:'https://chatgpt.com/c/'+id,
   last_submission_at:now,head_sha:head};
}
function active(r,pr,head,base){
 Object.assign(r,{pr_number:pr,head_sha:head,base_sha:base,github_state:'open',
  draft:true,status:'draft_open',ci_state:'pending',codex_state:'pending',
  mergeable:true,threads_resolved:true});
}
test('one approved feature can code two tasks concurrently but only integrate in order',()=>{
 const s=state();
 assert.equal(proposed(s)['CR-A'].current_stage,'APPROVED');
 receipt(s,'CR-A',a);receipt(s,'CR-B',b);
 active(s.tasks['CR-A'],501,a,c);active(s.tasks['CR-B'],502,b,a);
 assert.equal(proposed(s)['CR-A'].current_stage,'CODE_SUBMITTED');
 assert.equal(proposed(s)['CR-B'].current_stage,'CODE_SUBMITTED');
 // CI is GitHub's own fact, not a coder completion message.
 s.tasks['CR-A'].ci_state='success';s.tasks['CR-B'].ci_state='success';
 assert.equal(proposed(s)['CR-A'].monitor.next_action,'MARK_PR_READY');
 assert.equal(proposed(s)['CR-B'].monitor.next_action,'WAIT_FOR_PARENT_MERGE');
 s.tasks['CR-A'].draft=false;
 assert.equal(proposed(s)['CR-A'].monitor.next_action,'VERIFY_OR_REQUEST_CODEX');
 s.tasks['CR-A'].codex_review_requested_sha=a;
 s.tasks['CR-A'].ready_transition_at=now;
 assert.equal(proposed(s)['CR-A'].codex.request_status,'AUTO_EXPECTED_UNCONFIRMED');
 s.tasks['CR-A'].codex_state='findings';s.tasks['CR-A'].codex_reviewed_sha=a;
 assert.equal(proposed(s)['CR-A'].monitor.next_actor,'MUSE');
 // Coder fixes in same chat: next head invalidates the old clean/finding.
 s.tasks['CR-A'].head_sha=m;s.tasks['CR-A'].ci_state='pending';
 s.tasks['CR-A'].codex_state='pending';s.tasks['CR-A'].codex_reviewed_sha=a;
 assert.notEqual(proposed(s)['CR-A'].codex.status,'CLEAN');
 s.tasks['CR-A'].ci_state='success';s.tasks['CR-A'].codex_state='clean';
 s.tasks['CR-A'].codex_reviewed_sha=m;
 assert.equal(proposed(s)['CR-A'].current_stage,'MERGE_READY');
 // Parent merges; post-merge integration can lag, but child coding was not blocked.
 Object.assign(s.tasks['CR-A'],{github_state:'merged',status:'merged',merge_sha:c});
 assert.equal(proposed(s)['CR-A'].current_stage,'INTEGRATION_PENDING');
 // Child base retarget + safe branch update is a GitHub responsibility.
 Object.assign(s.tasks['CR-B'],{base_branch:'main',base_sha:c,base_current:true,
  head_sha:b,draft:false,codex_state:'clean',codex_reviewed_sha:b});
 assert.equal(proposed(s)['CR-B'].current_stage,'MERGE_READY');
 s.tasks['CR-A'].status='integrated_proven';
 s.tasks['CR-A'].integration_proof={merged_sha:c,main_sha:c,conclusion:'success',
   workflow_run_id:661,required_scenarios:[{id:'1',result:'passed'}]};
 assert.equal(proposed(s)['CR-A'].milestones.task_complete,'YES');
 Object.assign(s.tasks['CR-B'],{github_state:'merged',status:'integrated_proven',merge_sha:m,
  integration_proof:{merged_sha:m,main_sha:m,conclusion:'success',
    workflow_run_id:662,required_scenarios:[{id:'1',result:'passed'}]}});
 const done=proposed(s);
 assert.equal(done['CR-A'].milestones.task_complete,'YES');
 assert.equal(done['CR-B'].milestones.task_complete,'YES');
 assert.equal(recordLifecycleTransitions(s,queue,now).lifecycle_v3.transitions.length,2);
});
test('Muse has independent outage detection and GitHub never treats its request as permission',()=>{
 const s=state();receipt(s,'CR-A',a);active(s.tasks['CR-A'],501,a,c);
 s.updated_at='2026-11-11T10:00:00Z';
 s.schedule_health={last_schedule_at:'2026-11-11T10:00:00Z'};
 const health=inspectMuseHealth(s,{now});
 assert.ok(health.incidents.some(x=>x.kind==='GITHUB_SCHEDULE_STALE'));
 const requests=museRecoveryCandidates(health,s,{repo,actor,now});
 const backlog=planMuseBacklog(null,requests,now);
 assert.ok(Object.keys(backlog.items).length);
 const req=requests.find(x=>x.intent==='RECONCILE');
 const event={action:'dispatcher_recovery',sender:{login:actor},
   client_payload:req};
 const options={repo,actors:{[actor]:'muse'},owner:actor,now,
   records:s.tasks};
 assert.equal(recoveryEvent(event,options).accepted,true);
 const accepted=recordRecoveryEvent(s,event,options);
 const settled=settleRecoveryRequests(accepted,projectLifecycle(accepted,queue,now),now);
 assert.equal(Object.values(settled.recovery_requests)[0].status,'OBSERVED');
 assert.equal(settled.tasks['CR-A'].draft,true);
 assert.equal(settled.tasks['CR-A'].ci_state,'pending');
});
