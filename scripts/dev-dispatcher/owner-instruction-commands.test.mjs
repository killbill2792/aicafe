import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOwnerInstruction,applyMuseOwnerInstruction} from './owner-instruction-commands.mjs';
import {recoveryIdentity} from './recovery-v3.mjs';
import {settings} from './settings.mjs';

const clock='2026-11-12T05:01:00Z';
const head='a'.repeat(40);
const fixture=()=>({version:1,
 tasks:{'9':{approved:true,pr_number:442,head_sha:head,github_state:'open',
   ci_state:'success',codex_state:'pending'},
   '10':{approved:true,branch:'feat/aicafe-task-10',pr_number:null,ci_state:null}},
 actions:{},owner_instruction_events:{},
 lifecycle_v3:{rows:{'9':{current_stage:'CODE_SUBMITTED'},
   '10':{current_stage:'APPROVED'},'11':{current_stage:'NOT_APPROVED'}}}
});
const receipt=(text,target={task_id:'9'},event_id='owner_instruction_1')=>({
 kind:'owner_instruction',event_id,target,text,submitted_at:clock
});
const apply=(s,r)=>applyMuseOwnerInstruction(s,r,{actor:'muse-writer',now:clock});

test('owner ordinary English controls are parsed without hashtags or special commands',()=>{
 const inputs=[
  ['Set Task 9 priority to 90.',{kind:'control',task_id:'9',field:'dispatch_priority',value:90}],
  ['Owner said: pause Task 9',{kind:'control',task_id:'9',field:'pause_new_dispatch',value:true}],
  ['Resume Task 9',{kind:'control',task_id:'9',field:'pause_new_dispatch',value:false}],
  ['Add a note to Task 9: Review CI before release',
   {kind:'control',task_id:'9',field:'note',value:'Review CI before release'}],
  ['Set stall timeout to 10 minutes',
   {kind:'control',task_id:'__global__',field:'stall_minutes',value:10}],
  ['Set escalation timeout to 15 minutes',
   {kind:'control',task_id:'__global__',field:'escalation_minutes',value:15}],
  ['Recheck Task 10',{kind:'recovery',intent:'RECONCILE',task_id:'10',global:true}],
  ['Refresh the dispatcher',{kind:'recovery',intent:'RECONCILE',task_id:null}],
  ['Request Codex review for PR #442',
   {kind:'recovery',intent:'REQUEST_CODEX_IF_ELIGIBLE',pr_number:442}],
  ['Retry CI for PR 442',{kind:'recovery',intent:'RETRY_CI_IF_SAFE',pr_number:442}],
  ['Merge PR 442 if eligible',{kind:'recovery',intent:'MERGE_IF_ELIGIBLE',pr_number:442}],
  ['Verify integration for Task 9',{kind:'recovery',intent:'VERIFY_INTEGRATION',task_id:'9'}]
 ];
 for(const [input,expected] of inputs)
   assert.deepEqual(parseOwnerInstruction(input),expected,input);
 assert.equal(parseOwnerInstruction('Mark CI on Task 9 green'),null);
 assert.equal(parseOwnerInstruction('Approve all proposals'),null);
});
test('authenticated Muse owner instruction changes existing owner controls and status only',()=>{
 let s=fixture();
 s=apply(s,receipt('Set Task 9 priority to 90'));
 assert.equal(s.owner_controls.per_task['9'].dispatch_priority,90);
 assert.equal(s.owner_controls.revision,1);
 assert.equal(s.owner_instruction_events.owner_instruction_1.status,'APPLIED');
 assert.equal(s.owner_instruction_events.owner_instruction_1.control_revision,1);
 assert.equal(s.tasks['9'].ci_state,'success');
 assert.equal(s.tasks['9'].codex_state,'pending');
 const same=apply(s,receipt('Set Task 9 priority to 90'));
 assert.deepEqual(same,s,'same event ID cannot replay an edit');
 s=apply(s,receipt('Pause Task 9',{task_id:'9'},'owner_instruction_2'));
 assert.equal(s.owner_controls.per_task['9'].pause_new_dispatch,true);
 s=apply(s,receipt('Resume Task 9',{task_id:'9'},'owner_instruction_3'));
 assert.equal(s.owner_controls.per_task['9'].pause_new_dispatch,false);
 s=apply(s,receipt('Add note to Task 9: private owner decision',{task_id:'9'},'owner_instruction_4'));
 assert.equal(s.owner_controls.per_task['9'].note,'private owner decision');
});
test('global monitoring thresholds use existing CAS history',()=>{
 let s=apply(fixture(),receipt('Set stall timeout to 10 minutes',{task_id:'__global__'}));
 s=apply(s,receipt('Set escalation timeout to 15 minutes',{task_id:'__global__'},'threshold_2'));
 assert.equal(s.owner_controls.monitoring.stall_minutes,10);
 assert.equal(s.owner_controls.monitoring.escalation_minutes,15);
 assert.equal(s.owner_controls.history.length,2);
});
test('safe Codex request is queued with verified task, PR and head; not marked clean',()=>{
 const s=apply(fixture(),receipt('Request Codex review for PR 442',{pr_number:442}));
 const event=s.owner_instruction_events.owner_instruction_1;
 assert.equal(event.status,'REQUESTED');
 const req=s.recovery_requests?.[event.recovery_request_id];
 assert.equal(req.intent,'REQUEST_CODEX_IF_ELIGIBLE');
 assert.equal(req.task_id,'9');assert.equal(req.pr_number,442);
 assert.equal(req.expected_head_sha,head);
 assert.equal(req.request_id,recoveryIdentity({repo:settings.repo,actor:'muse-writer',
   intent:req.intent,task_id:'9',pr_number:442,expected_head_sha:head,requested_at:clock}));
 assert.equal(s.tasks['9'].codex_state,'pending','not forged as clean');
 assert.equal(s.actions?.length,undefined);
});
test('task not linked to PR can still request global reconciliation, but cannot forge merge',()=>{
 const s=apply(fixture(),receipt('Recheck Task 10',{task_id:'10'}));
 const e=s.owner_instruction_events.owner_instruction_1;
 assert.equal(e.status,'REQUESTED');
 assert.equal(s.recovery_requests[e.recovery_request_id].task_id,null);
 assert.equal(s.tasks['10'].pr_number,null);
 const bad=apply(fixture(),receipt('Merge PR 443 if eligible',{pr_number:443}));
 assert.equal(bad.owner_instruction_events.owner_instruction_1.status,'BLOCKED');
 assert.equal(bad.owner_instruction_events.owner_instruction_1.reason,'pr_not_linked_to_task');
 assert.ok(!bad.recovery_requests);
});
test('unsupported/invalid/ambiguous instructions are explicit BLOCKED, never effects',()=>{
 for(const text of ['Approve Task 11','Mark Task 9 CI green',
   'Set Task 9 priority to 999','Do anything you want for Task 9']){
  const s=apply(fixture(),receipt(text));
  assert.equal(s.owner_instruction_events.owner_instruction_1.status,'BLOCKED',text);
  assert.equal(s.owner_controls,undefined);
  assert.equal(s.recovery_requests,undefined);
 }
 const mismatched=apply(fixture(),receipt('Set Task 9 priority to 80',{task_id:'10'}));
 assert.equal(mismatched.owner_instruction_events.owner_instruction_1.reason,
  'target_does_not_match_owner_words');
 assert.ok(!mismatched.owner_controls);
 const unknown=apply(fixture(),receipt('Set Task 77 priority to 25',{task_id:'77'}));
 assert.equal(unknown.owner_instruction_events.owner_instruction_1.reason,'unknown_task');
 const suspicious=apply(fixture(),receipt('Merge PR 442 if eligible',{pr_number:443}));
 assert.equal(suspicious.owner_instruction_events.owner_instruction_1.reason,
  'target_does_not_match_owner_words');
});

test('Muse can translate owner speech into a bounded typed control without a hashtag',()=>{
 const r=receipt('Please move my rolling memory task ahead of the other work',
   {task_id:'9'});
 r.command={type:'control',task_id:'9',field:'dispatch_priority',value:85};
 const next=apply(fixture(),r);
 assert.equal(next.owner_instruction_events.owner_instruction_1.status,'APPLIED');
 assert.equal(next.owner_controls.per_task['9'].dispatch_priority,85);
 assert.equal(next.owner_controls.history[0].actor,'authenticated_owner');
});
test('unambiguous owner words override and verify a Muse structured interpretation',()=>{
 const r=receipt('Set Task 9 priority to 90',{task_id:'9'});
 r.command={type:'control',task_id:'9',field:'dispatch_priority',value:10};
 const next=apply(fixture(),r);
 assert.equal(next.owner_instruction_events.owner_instruction_1.status,'BLOCKED');
 assert.equal(next.owner_instruction_events.owner_instruction_1.reason,
   'muse_command_conflicts_with_owner_words');
 assert.equal(next.owner_controls,undefined);
});
test('typed Muse recovery is a safe verified hint rather than a forged GitHub status',()=>{
 const r=receipt('Please get the review moving again',{pr_number:442});
 r.command={type:'recovery',intent:'REQUEST_CODEX_IF_ELIGIBLE',
   task_id:null,pr_number:442};
 const state=apply(fixture(),r);
 const event=state.owner_instruction_events.owner_instruction_1;
 assert.equal(event.status,'REQUESTED');
 assert.equal(state.recovery_requests[event.recovery_request_id].expected_head_sha,head);
 assert.equal(state.tasks['9'].codex_state,'pending');
 const wrong=receipt('Please get the review moving again',{pr_number:442,task_id:'10'});
 wrong.command=r.command;
 const blocked=apply(fixture(),wrong);
 assert.equal(blocked.owner_instruction_events.owner_instruction_1.reason,
   'target_does_not_match_verified_pr_task');
});
test('invalid typed Muse operations cannot expand owner control permissions',()=>{
 for(const cmd of [
  {type:'control',task_id:'9',field:'approved',value:true},
  {type:'control',task_id:'9',field:'ci_state',value:'success'},
  {type:'recovery',intent:'FORCE_MERGE',task_id:'9',pr_number:442},
  {type:'control',task_id:'9',field:'dispatch_priority',value:100,
    arbitrary_rewrite:true}
 ]){
   const r=receipt('Do what I just said',{task_id:'9'});r.command=cmd;
   const state=apply(fixture(),r);
   assert.equal(state.owner_instruction_events.owner_instruction_1.status,'BLOCKED');
   assert.equal(state.owner_instruction_events.owner_instruction_1.reason,
     'unsupported_or_malformed_muse_command');
   assert.equal(state.owner_controls,undefined);
   assert.equal(state.recovery_requests,undefined);
 }
});

test('closed PR and misleading global target cannot trigger an unintended owner action',()=>{
 const closed=fixture();closed.tasks['9'].github_state='merged';
 const request=apply(closed,receipt('Merge PR 442 if eligible',{pr_number:442}));
 assert.equal(request.owner_instruction_events.owner_instruction_1.status,'BLOCKED');
 assert.equal(request.owner_instruction_events.owner_instruction_1.reason,'pr_not_open');
 assert.equal(request.recovery_requests,undefined);
 const wrong=apply(fixture(),receipt('Pause Task 9',{task_id:'__global__'}));
 assert.equal(wrong.owner_instruction_events.owner_instruction_1.reason,
   'target_does_not_match_owner_words');
 assert.equal(wrong.owner_controls,undefined);
});
