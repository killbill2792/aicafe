import test from 'node:test';
import assert from 'node:assert/strict';
import { linkPullRequests } from './dependencies.mjs';
import { reconcileGithub, decideNudge } from './core.mjs';
import { queueOwnerAlerts, acceptOwnerNoticeReceipt } from './alerts.mjs';
import { revalidateQueuedActions } from './authorization.mjs';
import { signalFor } from './signal.mjs';
import { approvalSignature } from './delivery.mjs';

const task={id:'POS0a',state:'architecture_approved',title:'Read-only API audit',
  goal:'Document canonical coverage',brief:'docs/plans/tasks.md#task-pos0a',
  architecture_approval:{approved:true},depends_on:[],
  exclusive_files:['docs/plans/coverage.md'],acceptance:['field audit']};
const conversation='https://chatgpt.com/g/aicafe-project/c/session-abc';
function pending() {
  const record={task_id:task.id,status:'assigned',approved:true,agent:'chatgpt',
    branch:'feat/aicafe-task-POS0a',approval_hash:approvalSignature(task),
    conversation_ref:conversation,last_submission_at:'2026-11-07T05:57:00Z',
    submission_state:'submitted'};
  return {version:1,tasks:{POS0a:record},
    actions:{'assign:POS0a':{task_id:task.id,type:'assign',status:'submitted'},
      'POS0a:pre_pr_reminder:pre-pr:v1:start':{
        task_id:task.id,type:'pre_pr_reminder',head_sha:null,status:'planned'}}};
}
function newDraft(question) {
  return {pr_number:398,task_marker:'POS0a',branch:'feat/aicafe-task-POS0a',
    base_branch:'main',base_sha:'a'.repeat(40),head_sha:'b'.repeat(40),
    last_commit_at:'2026-11-07T09:08:36Z',draft:true,github_owner_question:question,
    ci_state:'pending',codex_state:'pending',threads_resolved:false};
}
function reconcile(state,prs) {
  const linked=linkPullRequests(state,prs);
  const observed=reconcileGithub(linked.state,prs,{},'2026-11-07T09:20:00Z');
  const alerted=queueOwnerAlerts(observed);
  revalidateQueuedActions(alerted,new Map([[task.id,task]]));
  return alerted;
}

test('existing draft owner question produces one Muse notice, stops stale reminder, preserves original chat',()=>{
  const question='Approve the exact additional read-only audit files?';
  const first=reconcile(pending(),[newDraft(question)]);
  const rec=first.tasks.POS0a;
  assert.equal(rec.pr_number,398);
  assert.equal(rec.status,'blocked_needs_owner');
  assert.equal(rec.conversation_ref,conversation);
  assert.equal(decideNudge(rec,Date.parse('2026-11-07T10:00:00Z')).reason,'owner_decision_required');
  assert.equal(first.actions['POS0a:pre_pr_reminder:pre-pr:v1:start'].status,'cancelled_stale_head');
  const entries=Object.entries(first.owner_alerts);
  assert.equal(entries.length,1);
  const [id,notice]=entries[0];
  assert.equal(notice.delivery_owner,'muse');
  assert.equal(notice.kind,'owner_decision');
  assert.equal(notice.pr_number,398);
  assert.match(notice.question,/Approve the exact additional read-only audit files/);
  assert.match(notice.question,/ChatGPT chat: https:\/\/chatgpt.com\/g\/aicafe-project\/c\/session-abc/);
  assert.equal(signalFor(first,'s'.repeat(32)).pending_count,1);
  const again=reconcile(first,[newDraft(question)]);
  assert.deepEqual(again.owner_alerts,first.owner_alerts);
  assert.equal(signalFor(again,'s'.repeat(32)).pending_count,1);
  const submitted=acceptOwnerNoticeReceipt(again,{
    kind:'owner_notice',notice_id:id,notice_hash:notice.notice_hash,status:'submitted'
  },{authenticatedCourier:'muse'});
  assert.equal(signalFor(submitted,'s'.repeat(32)).pending_count,0);
  assert.equal(submitted.tasks.POS0a.status,'blocked_needs_owner');
});

test('a draft with no published owner question cannot invent an approval notification',()=>{
  const draft=reconcile(pending(),[newDraft(null)]);
  assert.equal(draft.tasks.POS0a.status,'draft_open');
  assert.equal(Object.keys(draft.owner_alerts).length,0);
  assert.equal(draft.actions['POS0a:pre_pr_reminder:pre-pr:v1:start'].status,'cancelled_stale_head');
  assert.equal(signalFor(draft,'s'.repeat(32)).pending_count,0);
});

test('editing and withdrawing a question cancels only unsent owner notices',()=>{
 const starting=reconcile(pending(),[newDraft('Approve first audit scope?')]);
 const first=Object.values(starting.owner_alerts).find(n=>n.status==='planned');
 assert.ok(first);
 const changed=reconcile(starting,[newDraft('Approve revised audit scope?')]);
 assert.equal(Object.values(changed.owner_alerts).filter(n=>n.status==='planned').length,1);
 assert.equal(Object.values(changed.owner_alerts).filter(n=>n.status==='cancelled_no_longer_needed').length,1);
 assert.match(Object.values(changed.owner_alerts).find(n=>n.status==='planned').question,/revised audit scope/);
 assert.equal(signalFor(changed,'s'.repeat(32)).pending_count,1);
 const withdrawn=reconcile(changed,[newDraft(null)]);
 assert.equal(Object.values(withdrawn.owner_alerts).filter(n=>n.status==='planned').length,0);
 assert.equal(signalFor(withdrawn,'s'.repeat(32)).pending_count,0);
 const restored=reconcile(withdrawn,[newDraft('Approve a new audit decision?')]);
 assert.equal(Object.values(restored.owner_alerts).filter(n=>n.status==='planned').length,1);
});
