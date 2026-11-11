import test from 'node:test';
import assert from 'node:assert/strict';
import {taskLifecycle,projectLifecycle,recordLifecycleTransitions} from './lifecycle-v3.mjs';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const plan={repo:'killbill2792/aicafe',tasks:[
  {id:'CR-A',title:'First',depends_on:[],acceptance:['unit'],edits:['lib/shared.ts'],
   architecture_approval:{approved:true},state:'ready'},
  {id:'CR-B',title:'Second',depends_on:['CR-A'],acceptance:['integration'],edits:['lib/shared.ts'],
   architecture_approval:{approved:true},state:'ready'}
]};
const task=plan.tasks[0];
const basics={version:1,updated_at:'2026-11-11T10:00:00Z',tasks:{},actions:{},owner_alerts:{}};
const rec={task_id:'CR-A',approved:true,approval_hash:'a'.repeat(64),github_state:'open',pr_number:123,draft:true,
  branch:'feat/aicafe-task-CR-A',head_sha:a,base_sha:b,base_current:true,
  ci_state:'success',mergeable:true,threads_resolved:true,last_commit_at:'2026-11-11T09:58:00Z'};
const now='2026-11-11T10:00:00Z';
const project=(r=rec,s=basics,t=task,q=plan)=>taskLifecycle(t,r,{...s,tasks:{...s.tasks,[t.id]:r}},q,now);
test('green draft has explicit next action, no ChatGPT completion claim',()=>{
  const x=project({...rec,coder_done:true});
  assert.equal(x.current_stage,'CODE_SUBMITTED');
  assert.equal(x.monitor.next_action,'MARK_PR_READY');
  assert.equal(x.monitor.next_actor,'GITHUB');
  assert.equal(x.acceptance.status,'MISSING');
  assert.equal(x.coding.chat_completion_authoritative,false);
});
test('missing PR remains unverified; no unsupported inference from time without commits',()=>{
  const x=project({approved:true,conversation_ref:'https://chatgpt.com/c/abc',branch:'feat/aicafe-task-CR-A'});
  assert.equal(x.pr.state,'MISSING');
  assert.equal(x.current_stage,'APPROVED');
  assert.equal(x.monitor.next_action,'DELIVER_OR_RECOVER_PROMPT');
  assert.notEqual(x.milestones.code_submitted,'YES');
});
test('a real verified Muse receipt progresses the delivery milestone',()=>{
  const s={...basics,actions:{'assign:CR-A':{task_id:'CR-A',status:'submitted',type:'assign',
    delivery_owner:'muse',submitted_at:now,
    delivery:{provider:'chatgpt',intent:'start_new_chat',conversation_url:null,
      approval_hash:'a'.repeat(64),prompt_hash:'b'.repeat(64)},
    receipt:{courier:'muse',prompt_hash:'b'.repeat(64),
      conversation_url:'https://chatgpt.com/c/abc'}}}};
  const x=project({approved:true,approval_hash:'a'.repeat(64),
    conversation_ref:'https://chatgpt.com/c/abc'},s);
  assert.equal(x.current_stage,'DELIVERED');
  assert.equal(x.milestones.delivered,'YES');
  assert.equal(x.monitor.next_action,'VERIFY_BRANCH_AND_PR');
});
test('CI failure classifies code repair vs authenticated startup retry',()=>{
  const fail={...rec,ci_state:'failure',draft:false};
  assert.equal(project(fail).monitor.next_action,'REPAIR_CI_IN_ORIGINAL_CHAT');
  assert.equal(project({...fail,ci_failure_kind:'startup_failure'}).monitor.next_action,'RETRY_VERIFIED_CI_STARTUP');
});
test('auto Codex trigger expected is not a confirmed review or request',()=>{
  const x=project({...rec,draft:false,codex_state:'pending',
    ready_transition_at:now,codex_review_requested_sha:a});
  assert.equal(x.codex.request_status,'AUTO_EXPECTED_UNCONFIRMED');
  assert.equal(x.codex.status,'PENDING');
  assert.equal(x.monitor.next_action,'VERIFY_OR_REQUEST_CODEX');
  assert.equal(x.milestones.merge_ready,'NO');
});
test('verified exact-head Codex, green CI and resolved threads permits coding merge',()=>{
  const x=project({...rec,draft:false,codex_state:'clean',codex_reviewed_sha:a});
  assert.equal(x.codex.status,'CLEAN');
  assert.equal(x.merge.eligible,true);
  assert.equal(x.monitor.next_action,'MERGE_IF_AUTHORIZED');
  assert.equal(x.milestones.task_complete,'NO');
});
test('old-head clean Codex becomes stale, cannot authorize current merge',()=>{
  const x=project({...rec,draft:false,codex_state:'clean',codex_reviewed_sha:c});
  assert.equal(x.codex.status,'STALE');
  assert.equal(x.merge.eligible,false);
});
test('parent dependencies hold integration, not simultaneous coding',()=>{
  const r={...rec,task_id:'CR-B',pr_number:124,draft:true,head_sha:b};
  const s={...basics,tasks:{'CR-A':rec,'CR-B':r}};
  const x=taskLifecycle(plan.tasks[1],r,s,plan,now);
  assert.equal(x.current_stage,'CODE_SUBMITTED');
  assert.deepEqual(x.remaining_dependencies,['CR-A']);
  assert.equal(x.monitor.next_action,'WAIT_FOR_PARENT_MERGE');
});
test('shared-write predecessor is merge-ordered even without explicit depends_on',()=>{
  const standalone={...plan.tasks[1],depends_on:[]};
  const s={...basics,tasks:{'CR-A':rec,'CR-B':{...rec,pr_number:124,draft:false,task_id:'CR-B',head_sha:b,codex_state:'clean',codex_reviewed_sha:b}}};
  const x=taskLifecycle(standalone,s.tasks['CR-B'],s,{...plan,tasks:[plan.tasks[0],standalone]},now);
  assert.deepEqual(x.remaining_dependencies,['CR-A']);
  assert.equal(x.merge.eligible,false);
});
test('merged is not integrated, and misleading old coder_done does not matter',()=>{
  const merged={...rec,github_state:'merged',status:'merged',merge_sha:b,coder_done:true};
  const x=project(merged);
  assert.equal(x.current_stage,'INTEGRATION_PENDING');
  assert.equal(x.milestones.task_complete,'NO');
  assert.equal(x.monitor.next_action,'VERIFY_INTEGRATION');
});
test('integration requires exact merged SHA and successful scenarios',()=>{
  const merged={...rec,github_state:'merged',status:'integrated_proven',merge_sha:b,
    integration_proof:{merged_sha:b,main_sha:b,conclusion:'success',workflow_run_id:23,
      required_scenarios:[{id:'1',result:'passed'}]}};
  assert.equal(project(merged).milestones.task_complete,'YES');
  assert.equal(project({...merged,integration_proof:{...merged.integration_proof,main_sha:c}})
    .milestones.task_complete,'NO');
});
test('unknown or stale observations never become a guessed green',()=>{
  const x=project({...rec,ci_state:'unknown',draft:false,mergeable:null});
  assert.equal(x.ci.status,'UNKNOWN');
  assert.equal(x.monitor.next_action,'OBSERVE_CI');
  assert.equal(x.merge.eligible,false);
});
test('full projection creates rows for approved tasks without records',()=>{
  const x=projectLifecycle(basics,plan,now);
  assert.deepEqual(Object.keys(x.tasks),['CR-A','CR-B']);
  assert.equal(x.tasks['CR-A'].monitor.next_actor,'MUSE');
  assert.equal(x.health.schedule_status,'UNKNOWN');
});
test('transition history changes only on evidence, retains same pending actions',()=>{
  const s={...basics,tasks:{'CR-A':rec}};
  const first=recordLifecycleTransitions(s,plan,now);
  assert.equal(first.lifecycle_v3.transitions.length,2);
  const again=recordLifecycleTransitions(first,plan,now);
  assert.equal(again.lifecycle_v3.transitions.length,2);
  assert.deepEqual(again.actions,first.actions);
});
test('dispatcher heartbeat reports stale separate from ledger update',()=>{
  const s={...basics,schedule_health:{last_schedule_at:'2026-11-11T09:00:00Z'}};
  const view=projectLifecycle(s,plan,now);
  assert.equal(view.health.schedule_status,'STALE');
  assert.equal(view.health.schedule_age_minutes,60);
});


test('infrastructure PR is never advertised as eligible for automatic merge',()=>{
  const x=project({...rec,draft:false,codex_state:'clean',codex_reviewed_sha:a,
    dispatcher_only:true});
  assert.equal(x.merge.eligible,false);
  assert.ok(x.merge.blockers.includes('owner_merge_required'));
  assert.equal(x.monitor.next_action,'OWNER_MERGE_REQUIRED');
});
test('review from outdated base cannot be presented as merge-ready',()=>{
  const x=project({...rec,draft:false,codex_state:'clean',codex_reviewed_sha:a,
    review_base_current:false});
  assert.equal(x.merge.eligible,false);
  assert.ok(x.merge.blockers.includes('review_base_outdated'));
});
test('signed ad hoc stacked PR never advertised as eligible to merge into open parent',()=>{
  const x=project({...rec,draft:false,codex_state:'clean',codex_reviewed_sha:a,
    adhoc:true,base_branch:'feat/parent'});
  assert.equal(x.merge.eligible,false);
  assert.ok(x.merge.blockers.includes('adhoc_parent_base_not_main'));
});


test('every lifecycle column group records evidence or explicit unknown, never fabricated checks',()=>{
 const x=project({...rec,ci_state:'unknown',codex_state:'unknown',
   codex_review_requested_sha:null,acceptance_proven:false,
   last_commit_actor:'killbill2792'});
 assert.equal(x.approval.status,'APPROVED');
 assert.deepEqual(x.approval.authorized_files,['lib/shared.ts']);
 assert.equal(x.coding.last_commit_actor,'killbill2792');
 assert.equal(x.ci.started_at,null);
 assert.equal(x.ci.finished_at,null);
 assert.equal(x.codex.requested_at,null);
 assert.equal(x.codex.status,'UNKNOWN');
 assert.equal(x.acceptance.status,'MISSING');
 assert.equal(x.dependency_state.branch_conflict,null);
 assert.equal(x.merge.attempted_at,null);
 assert.equal(x.integration.proof_run_url,null);
 assert.equal(x.monitor.pending_recovery_count,0);
});
