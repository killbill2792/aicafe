import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOwnerDashboardEdit,dispatchPreferences,validateDashboardEdit} from './owner-controls-v3.mjs';
const now='2026-11-11T10:00:00Z';
const state={version:1,tasks:{A:{approved:true,head_sha:'a'.repeat(40),ci_state:'failure'}},actions:{}};
test('owner edits notes and priority without overwriting verified GitHub facts',()=>{
 const first=applyOwnerDashboardEdit(state,{task_id:'A',field:'note',value:'Check CI errors',
   expected_revision:0},{role:'owner',now});
 const next=applyOwnerDashboardEdit(first,{task_id:'A',field:'dispatch_priority',value:75,
   expected_revision:1},{role:'owner',now});
 assert.equal(next.tasks.A.ci_state,'failure');
 assert.equal(next.tasks.A.head_sha,'a'.repeat(40));
 assert.equal(next.owner_controls.revision,2);
 assert.equal(next.owner_controls.history.length,2);
 assert.equal(dispatchPreferences(next).priority.A,75);
});
test('Muse cannot edit owner preferences or signed scope',()=>{
 assert.throws(()=>applyOwnerDashboardEdit(state,{task_id:'A',field:'note',value:'a',
  expected_revision:0},{role:'muse'}),/Owner authentication/);
 for(const field of ['approved','merge_eligible','codex_state','ci_state','authorized_files','merge_hold']){
   assert.throws(()=>validateDashboardEdit({task_id:'A',field,value:true}),/Unsupported/);
 }
});
test('reject stale owner edit revisions instead of overwriting another edit',()=>{
 const first=applyOwnerDashboardEdit(state,{task_id:'A',field:'pause_new_dispatch',value:true,
   expected_revision:0},{role:'owner',now});
 assert.throws(()=>applyOwnerDashboardEdit(first,{task_id:'A',field:'note',value:'stale',
   expected_revision:0},{role:'owner',now}),/conflict/);
 assert.equal(dispatchPreferences(first).paused.has('A'),true);
});
test('global thresholds are bounded, individual overrides do not authorize effects',()=>{
 const one=applyOwnerDashboardEdit(state,{task_id:'__global__',field:'stall_minutes',value:30,
   expected_revision:0},{role:'owner',now});
 assert.equal(dispatchPreferences(one).stall_minutes,30);
 assert.throws(()=>validateDashboardEdit({task_id:'__global__',field:'stall_minutes',value:0}));
 assert.throws(()=>validateDashboardEdit({task_id:'A',field:'stall_minutes',value:30}));
 assert.throws(()=>validateDashboardEdit({task_id:'__global__',field:'pause_new_dispatch',value:true}));
});
