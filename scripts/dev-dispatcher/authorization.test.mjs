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
  assert.equal(changed.actions['old:5'].status,'cancelled_owner_state_changed');
});
test('reopened PR never rewrites historical proven status',()=>{
 for(const status of ['integrated_proven','released_proven']){
  const s=makeState({status,head_sha:'a'.repeat(40)});
  const out=reconcileGithub(s,[{pr_number:390,head_sha:'b'.repeat(40),base_sha:'c'.repeat(40),draft:true,mergeable:true}]);
  revalidateQueuedActions(out,new Map());
  assert.equal(out.tasks['6'].status,status);
  assert.equal(out.actions['fix:6'].status,'cancelled_stale_head');
 }
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
    architecture_foundation_implementation_approval:{
      approved:false,merged_sha:null,owner_review_url:null},
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
  state.tasks.POS0a.merge_sha='a'.repeat(40);
  // Verified merge/integration is insufficient without a separate owner review.
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),null);
  gateQueue.dispatch_rules.architecture_foundation_implementation_approval={
    approved:true,merged_sha:'b'.repeat(40),
    owner_review_url:'https://github.com/killbill2792/aicafe/pull/395#issuecomment-123'};
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),null);
  gateQueue.dispatch_rules.architecture_foundation_implementation_approval.merged_sha='a'.repeat(40);
  assert.equal(assignmentActionKey(state,'POS0b',gateQueue),'assign:POS0b:after-POS0a');
  const started={...state,tasks:{...state.tasks,POS0a:{status:'draft_open'},
    POS0b:{...state.tasks.POS0b,status:'review_fixing',github_state:'open',pr_number:400,conversation_ref:'https://chatgpt.com/c/existing'}},
    actions:{'repair:POS0b':{task_id:'POS0b',type:'repair_ci',status:'planned'}}};
  revalidateQueuedActions(started,new Map([['POS0b',b]]),gateQueue);
  assert.equal(started.tasks.POS0b.status,'review_fixing');
  assert.equal(started.actions['repair:POS0b'].status,'planned');
});

test('trusted post-merge failure survives reconciliation and stays eligible for one repair handoff',()=>{
 const merge='f'.repeat(40),failure='<!-- landing-check-failure sha:'+merge+' -->\nreal error';
 const s=makeState({github_state:'open',status:'review_fixing',head_sha:'a'.repeat(40)},
  {type:'landing_failed',head_sha:merge});
 s.tasks['6'].merge_sha=merge;
 s.tasks['6'].landing_failure=failure;
 const next=reconcileGithub(s,[],{390:{merged:true,merge_sha:merge,landing_failure:failure}});
 assert.equal(next.tasks['6'].status,'merged');
 assert.equal(next.tasks['6'].landing_failure,failure);
 assert.equal(next.actions['fix:6'].status,'planned');
 revalidateQueuedActions(next,tasks());
 assert.equal(next.actions['fix:6'].status,'planned');
 const again=reconcileGithub(next,[],{390:{merged:true,merge_sha:merge,landing_failure:null}});
 assert.equal(again.tasks['6'].landing_failure,failure);
 assert.equal(again.actions['fix:6'].status,'planned');
});
test('closed-PR landing authorization is exact merge-SHA scoped for queued and ad hoc tasks',()=>{
 const merge='e'.repeat(40),failure='<!-- landing-check-failure sha:'+merge+' --> error';
 for(const adHoc of [false,true]){
  const rec={approved:true,github_state:'merged',status:'merged',merge_sha:merge,
   landing_failure:failure,pr_number:390,adhoc:adHoc};
  const id=adHoc?'ADHOC-390':'6';
  if(!adHoc)rec.approval_hash=signed;
  const make=(head_sha,type='landing_failed')=>({version:1,tasks:{[id]:rec},
    actions:{landing:{task_id:id,type,head_sha,status:'planned'}}});
  const authorized=make(merge);
  revalidateQueuedActions(authorized,tasks());
  assert.equal(authorized.actions.landing.status,'planned',id);
  const stale=make('f'.repeat(40));
  revalidateQueuedActions(stale,tasks());
  assert.notEqual(stale.actions.landing.status,'planned',id);
 }
});


test('revoking an unshipped signed coding continuation cancels it; later Muse yes resumes same verified planning chat',()=>{
 const rec={task_id:'6',agent:'chatgpt',approved:true,planning_approved:true,
   scope_plan_completed:true,conversation_ref:'https://chatgpt.com/c/planning-6',
   scope_approval_event_id:'first-yes',approval_hash:signed,status:'assigned',
   pr_number:null};
 const pending={version:1,tasks:{'6':rec},
   actions:{'assign:6':{type:'begin_scoped_coding',task_id:'6',
     status:'planned',delivery_owner:'muse'}}};
 const unsigned={...task,state:'proposed',architecture_approval:null,exclusive_files:[]};
 revalidateQueuedActions(pending,new Map([['6',unsigned]]));
 assert.equal(pending.tasks['6'].status,'blocked_needs_owner');
 assert.equal(pending.tasks['6'].approved,false);
 assert.equal(pending.actions['assign:6'].status,'cancelled_approval_changed');
 assert.equal(pending.tasks['6'].conversation_ref,'https://chatgpt.com/c/planning-6');

 // A later independent, exact scope YES has a NEW authenticated receipt ID.
 pending.tasks['6'].planning_approved=true;
 pending.tasks['6'].scope_approval_event_id='second-yes';
 revalidateQueuedActions(pending,tasks());
 assert.equal(pending.tasks['6'].status,'proposed');
 assert.equal(pending.tasks['6'].approved,true);
 assert.equal(pending.tasks['6'].scope_plan_completed,true);
 assert.equal(pending.tasks['6'].conversation_ref,'https://chatgpt.com/c/planning-6');
 const key=assignmentActionKey(pending,'6');
 assert.match(key,/^assign:6:scope-[a-f0-9]{64}$/);
 pending.actions[key]={task_id:'6',type:'begin_scoped_coding',status:'planned'};
 assert.equal(assignmentActionKey(pending,'6'),null);
 assert.equal(pending.actions['assign:6'].status,'cancelled_approval_changed');
});

test('reissue after revoked scoped coding is forbidden after a claim or uncertain browser send',()=>{
 for(const field of [{claimed_at:'2026-11-11T10:15:00Z'},{status:'uncertain'},
                     {receipt:{courier:'muse'}},{delivery_claim:{owner:'muse'}}]){
  const rec={task_id:'6',status:'proposed',agent:'chatgpt',approved:true,
   approval_hash:signed,conversation_ref:'https://chatgpt.com/c/planning-6',
   scope_plan_completed:true,scope_approval_event_id:'new-yes'};
  const state={version:1,tasks:{'6':rec},actions:{'assign:6':{
   task_id:'6',type:'begin_scoped_coding',
   status:'cancelled_approval_changed',...field}}};
  assert.equal(assignmentActionKey(state,'6'),null);
 }
});
