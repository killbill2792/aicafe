import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalSignature } from './delivery.mjs';
import { revalidateQueuedActions } from './authorization.mjs';

const task = { id:'6', state:'ready', title:'Worker',goal:'Recover',brief:'docs/plans/tasks.md#task-6',
  architecture_approval:{approved:true},depends_on:['5'],exclusive_files:['lib/ai/runs/a.ts'],
  acceptance:['one valid restart'] };
const signed = approvalSignature(task);
const makeState = (rec = {}, action = {}) => ({
  version:1, tasks:{'6':{approved:true,status:'review_fixing',agent:'chatgpt',
    approval_hash:signed,pr_number:390,github_state:'open', ...rec}},
  actions:{'fix:6':{task_id:'6',type:'repair_ci',status:'planned', ...action}}
});
const tasks = () => new Map([['6',task]]);
test('valid approved scope and open PR preserve one planned repair', () => {
  const s=makeState();
  revalidateQueuedActions(s,tasks());
  assert.equal(s.actions['fix:6'].status,'planned');
  assert.equal(s.tasks['6'].approved,true);
});
test('owner withdraws approval -> old pending instruction cancelled', () => {
  const s=makeState();
  revalidateQueuedActions(s,new Map([['6',{...task,architecture_approval:null,state:'proposed'}]]));
  assert.equal(s.actions['fix:6'].status,'cancelled_approval_changed');
  assert.equal(s.tasks['6'].approved,false);
  assert.equal(s.tasks['6'].status,'blocked_needs_owner');
});
test('task removed from approved plan -> old instruction cancelled',()=>{
  const s=makeState();revalidateQueuedActions(s,new Map());
  assert.equal(s.actions['fix:6'].status,'cancelled_approval_changed');
});
test('file ownership or accepted task brief changes -> requires reapproval',()=>{
  for(const changed of [{...task,exclusive_files:['lib/ai/runs/b.ts']},
    {...task,goal:'Changed requirements'}, {...task,acceptance:['different proof']}]) {
    const s=makeState();revalidateQueuedActions(s,new Map([['6',changed]]));
    assert.equal(s.actions['fix:6'].status,'cancelled_approval_changed');
  }
});
test('merged or closed PR -> repair cannot be sent',()=>{
  for(const github_state of ['merged','not_open_unverified',undefined]) {
    const s=makeState({github_state});
    revalidateQueuedActions(s,tasks());
    assert.equal(s.actions['fix:6'].status,'cancelled_pr_closed');
  }
});
test('completed actions are never retroactively changed',()=>{
  const s=makeState({github_state:'merged'},{status:'already_executed'});
  revalidateQueuedActions(s,tasks());
  assert.equal(s.actions['fix:6'].status,'already_executed');
});
