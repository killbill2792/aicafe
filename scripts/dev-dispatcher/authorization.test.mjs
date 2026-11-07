import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalSignature } from './delivery.mjs';
import { dispatchFrontier, reconcileGithub } from './core.mjs';
import { revalidateQueuedActions, assignmentActionKey } from './authorization.mjs';

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

test('historical integrated predecessor proof survives revocation and unblocks dependent work',()=>{
  const dependent = {...task,depends_on:['5']};
  const current = {version:1, tasks:{'5':{status:'integrated_proven',pr_number:378,approved:false}},
    actions:{'old:5':{task_id:'5',type:'repair_ci',status:'planned'}}};
  const queue = {merged_code_only:[{id:'5',pr:378}],tasks:[dependent]};
  assert.equal(dispatchFrontier(queue,current.tasks).length,1);
  revalidateQueuedActions(current,new Map([['6',dependent]]));
  assert.equal(current.tasks['5'].status,'integrated_proven');
  assert.equal(current.actions['old:5'].status,'cancelled_approval_changed');
  assert.equal(dispatchFrontier(queue,current.tasks).length,1);
});
test('released-proven record is never downgraded to merged or blocked',()=>{
  const previous = {version:1,tasks:{'5':{status:'released_proven',pr_number:378}},
    actions:{'old:5':{task_id:'5',type:'repair_ci',status:'planned'}}};
  const changed = reconcileGithub(previous,[],{378:true});
  revalidateQueuedActions(changed,new Map());
  assert.equal(changed.tasks['5'].status,'released_proven');
  assert.equal(changed.actions['old:5'].status,'cancelled_approval_changed');
});
test('revoking new sends does not erase already proven integration on same task',()=>{
  const s=makeState({status:'integrated_proven'});
  revalidateQueuedActions(s,new Map());
  assert.equal(s.tasks['6'].approved,false);
  assert.equal(s.tasks['6'].status,'integrated_proven');
  assert.equal(s.actions['fix:6'].status,'cancelled_approval_changed');
});

const priority = {dispatch_rules:{priority_gate_task:'POS0f',priority_gate_allow_task_ids:['POS0a','POS0b','POS0c','POS0d','POS0e','POS0f']}};
test('pre-POS0f old undelivered assignment is cancelled, not sent to Muse',()=>{
  const state=makeState({status:'assigned',pr_number:null,conversation_ref:null},{type:'assign'});
  revalidateQueuedActions(state,tasks(),priority);
  assert.equal(state.actions['fix:6'].status,'cancelled_priority_gate');
  assert.equal(state.tasks['6'].status,'proposed');
  assert.equal(state.tasks['6'].priority_deferred,true);
});
test('priority gate keeps already-open PR repair, and releases only after durable proof',()=>{
  const ongoing=makeState();
  revalidateQueuedActions(ongoing,tasks(),priority);
  assert.equal(ongoing.actions['fix:6'].status,'planned');
  const proven=makeState({status:'assigned',pr_number:null,conversation_ref:null},{type:'assign'});
  proven.tasks.POS0f={status:'integrated_proven'};
  revalidateQueuedActions(proven,tasks(),priority);
  assert.equal(proven.actions['fix:6'].status,'planned');
  assert.equal(proven.tasks['6'].status,'assigned');
});

test('priority cancellation later requeues on a new deterministic key exactly once',()=>{
 const state=makeState({status:'assigned',pr_number:null,conversation_ref:null},{type:'assign'});
 state.actions['assign:6'] = {...state.actions['fix:6'],task_id:'6',type:'assign'};
 delete state.actions['fix:6'];
 revalidateQueuedActions(state,tasks(),priority);
 assert.equal(state.actions['assign:6'].status,'cancelled_priority_gate');
 assert.equal(assignmentActionKey(state,'6',priority),null);
 state.tasks.POS0f={status:'integrated_proven'};
 const key=assignmentActionKey(state,'6',priority);
 assert.equal(key,'assign:6:after-POS0f');
 state.actions[key]={status:'planned',task_id:'6',type:'assign'};
 assert.equal(assignmentActionKey(state,'6',priority),null);
 assert.equal(state.actions['assign:6'].status,'cancelled_priority_gate');
});
test('no replay after a claimed or uncertain action, or without priority gate proof',()=>{
 const state=makeState({status:'assigned',pr_number:null,conversation_ref:null},{type:'assign'});
 state.actions['assign:6']={task_id:'6',status:'cancelled_priority_gate',delivery_claim:{owner:'muse'}};
 assert.equal(assignmentActionKey(state,'6',priority),null);
 state.tasks.POS0f={status:'integrated_proven'};
 assert.equal(assignmentActionKey(state,'6',priority),null);
 delete state.actions['assign:6'].delivery_claim;
 state.actions['assign:6'].status='uncertain';
 assert.equal(assignmentActionKey(state,'6',priority),null);
 state.actions['assign:6'].status='submitted';
 assert.equal(assignmentActionKey(state,'6',priority),null);
});

test('architecture gate cancels unsent downstream work but preserves active PR and reopens after proof',()=>{
  const b={...task,id:'POS0b',depends_on:['POS0a'],exclusive_files:['lib/pos/toast/b.ts']};
  const signature=approvalSignature(b);
  const gateQueue={dispatch_rules:{
    architecture_foundation_proof_task:'POS0a',
    architecture_foundation_dependent_task_ids:['POS0b'],
  }};
  const state={version:1,tasks:{
    POS0a:{status:'draft_open',pr_number:398},
    POS0b:{task_id:'POS0b',status:'assigned',approved:true,agent:'chatgpt',
      approval_hash:signature}},
    actions:{'assign:POS0b':{task_id:'POS0b',type:'assign',status:'planned'}}};
  revalidateQueuedActions(state,new Map([['POS0b',b]]),gateQueue);
  assert.equal(state.tasks.POS0b.status,'proposed');
  assert.equal(state.actions['assign:POS0b'].status,'cancelled_architecture_gate');
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),null);
  state.tasks.POS0a.status='merged';
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),null);
  state.tasks.POS0a.status='integrated_proven';
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),'assign:POS0b:after-POS0a');
  const started={...state,tasks:{...state.tasks,POS0a:{status:'draft_open'},
    POS0b:{...state.tasks.POS0b,status:'review_fixing',pr_number:400,conversation_ref:'https://chatgpt.com/c/existing'}},
    actions:{'repair:POS0b':{task_id:'POS0b',type:'repair_ci',status:'planned'}}};
  revalidateQueuedActions(started,new Map([['POS0b',b]]),gateQueue);
  assert.equal(started.tasks.POS0b.status,'review_fixing');
  assert.equal(started.actions['repair:POS0b'].status,'planned');
});
