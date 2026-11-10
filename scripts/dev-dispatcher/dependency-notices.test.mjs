import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalSignature } from './delivery.mjs';
import { queueDependencyNotices } from './dependency-notices.mjs';
import { acceptDeliveryReceipt } from './receipt.mjs';

const sha='f'.repeat(40), childSha='a'.repeat(40);
const task={id:'child',title:'Child',goal:'Integrate',state:'architecture_approved',
  architecture_approval:{approved:true},depends_on:['parent'],
  exclusive_files:['scripts/child.mjs'],
  brief:'docs/plans/universal-supervisor-task-briefs.md#task-6',
  acceptance:['verification']};
const child=()=>({task_id:'child',status:'draft_open',approved:true,agent:'chatgpt',
  pr_number:408,github_state:'open',head_sha:childSha,base_branch:'main',
  conversation_ref:'https://chatgpt.com/c/abc-123',
  approval_hash:approvalSignature(task)});
const state=()=>({version:1,tasks:{child:child(),parent:{
  task_id:'parent',status:'integrated_proven',merge_sha:sha
}},actions:{}});
test('one existing chat receives one current-head notice when dependency proven',()=>{
  const s=state();
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),['child']);
  const entries=Object.entries(s.actions);
  assert.equal(entries.length,1);
  const [key,action]=entries[0];
  assert.match(key,/^dependency_proven:child:/);
  assert.equal(action.head_sha,childSha);
  assert.match(action.delivery.prompt,/Proven dependencies: parent/);
  assert.equal(action.delivery.intent,'continue_existing_chat');
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),[]);
});
test('authenticated dependency notice receipt stores chat by PR and prevents resend',()=>{
  const s=state();
  queueDependencyNotices(s,{tasks:[task]});
  const [actionId,action]=Object.entries(s.actions)[0];
  const accepted=acceptDeliveryReceipt(s,{
    action_id:actionId,prompt_hash:action.delivery.prompt_hash,
    approval_hash:action.delivery.approval_hash,
    conversation_url:s.tasks.child.conversation_ref,
    project_id:'aicafe',provider:'chatgpt',status:'submitted'
  },{authenticatedCourier:'muse'});
  assert.equal(accepted.actions[actionId].status,'submitted');
  assert.equal(accepted.pr_chat_links['408'].conversation_url,s.tasks.child.conversation_ref);
  assert.equal(accepted.tasks.child.last_dependency_proven_signature,action.dependency_signature);
  assert.deepEqual(queueDependencyNotices(accepted,{tasks:[task]}),[]);
});
test('unproven dependency, missing chat, pending delivery or revoked scope never sends',()=>{
  const s=state();
  s.tasks.parent.status='merged';
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),[]);
  s.tasks.parent.status='integrated_proven';
  s.tasks.child.conversation_ref=null;
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),[]);
  s.tasks.child.conversation_ref='https://chatgpt.com/c/abc-123';
  s.actions.other={task_id:'child',status:'uncertain'};
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),[]);
  delete s.actions.other;
  s.tasks.child.approval_hash='revoked';
  assert.deepEqual(queueDependencyNotices(s,{tasks:[task]}),[]);
});
