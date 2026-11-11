import test from 'node:test';
import assert from 'node:assert/strict';
import {recordGithubEffects,recordPrWriterOwnerNotices} from './github-effects-v3.mjs';
const head='a'.repeat(40),other='b'.repeat(40),now='2026-11-11T10:00:00Z';
const state={version:1,tasks:{A:{task_id:'A',pr_number:440,head_sha:head},
 B:{task_id:'B',pr_number:441,head_sha:other}},actions:{}};
test('records per-PR GitHub outcomes without declaring false success',()=>{
 const next=recordGithubEffects(state,[{task_id:'A',operation:'MARK_READY',
  head_sha:head,status:'blocked',reason:'live_pr_changed',pr_number:440}],now);
 assert.equal(next.tasks.A.github_effects.MARK_READY.status,'blocked');
 assert.equal(next.tasks.A.github_effects.MARK_READY.reason,'live_pr_changed');
 assert.equal(next.tasks.A.draft,undefined);
 assert.equal(next.tasks.B.github_effects,undefined);
 assert.equal(state.tasks.A.github_effects,undefined);
});
test('identical blocked evidence is not re-written each dispatcher tick',()=>{
 const once=recordGithubEffects(state,[{task_id:'A',operation:'MERGE',head_sha:head,
  status:'blocked',reason:'codex_review_missing',pr_number:440}],now);
 assert.equal(recordGithubEffects(once,[{task_id:'A',operation:'MERGE',head_sha:head,
  status:'blocked',reason:'codex_review_missing',pr_number:440}],
  '2026-11-11T10:05:00Z'),null);
});
test('outcome on old head is ignored; new-head operation cannot inherit prior proof',()=>{
 assert.equal(recordGithubEffects(state,[{task_id:'A',operation:'MARK_READY',
  head_sha:other,status:'ready_for_review'}],now),null);
});
test('record changes and bounded history on later verified effect',()=>{
 let next=recordGithubEffects(state,[{task_id:'A',operation:'MARK_READY',
  head_sha:head,status:'blocked',reason:'pending_ci'}],now);
 next=recordGithubEffects(next,[{task_id:'A',operation:'MARK_READY',
  head_sha:head,status:'ready_for_review',pr_number:440}],
 '2026-11-11T10:15:00Z');
 assert.equal(next.tasks.A.github_effects.MARK_READY.status,'ready_for_review');
 assert.equal(next.tasks.A.github_effect_history.length,2);
 assert.equal(next.tasks.A.github_effect_history[1].previous_status,'blocked');
});


test('missing PR-writer credential queues one authenticated Muse owner notice, never a coding send',()=>{
 const base={...state,owner_alerts:{}};
 const failure={task_id:'A',operation:'CREATE_DRAFT_PR',status:'blocked',
   reason:'missing_pr_creator_install_token',head_sha:head};
 const once=recordPrWriterOwnerNotices(base,[failure]);
 const alerts=Object.values(once.owner_alerts);
 assert.equal(alerts.length,1);
 assert.equal(alerts[0].kind,'pr_writer_unavailable');
 assert.equal(alerts[0].delivery_owner,'muse');
 assert.equal(alerts[0].recipient,'owner');
 assert.equal(alerts[0].status,'planned');
 assert.equal(Object.keys(once.actions).length,0);
 assert.equal(once.tasks.A.pr_number,440);
 const again=recordPrWriterOwnerNotices(once,[failure]);
 assert.deepEqual(again.owner_alerts,once.owner_alerts);
});
test('PR writer permission denial gets distinct notice; verified PR appearance resolves both',()=>{
 let s={...state,owner_alerts:{}};
 const blocked=['missing_pr_creator_install_token','pr_creator_permission_denied']
   .map(reason=>({task_id:'A',operation:'CREATE_DRAFT_PR',status:'blocked',reason}));
 s=recordPrWriterOwnerNotices(s,blocked);
 assert.equal(Object.values(s.owner_alerts).length,2);
 s=recordPrWriterOwnerNotices(s,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'existing_pr_needs_link',pr_number:440}]);
 assert.ok(Object.values(s.owner_alerts).every(n=>n.status==='resolved'));
});
test('unrelated PR-writer errors never fabricate an owner credential incident',()=>{
 const s=recordPrWriterOwnerNotices({...state,owner_alerts:{}},[
  {task_id:'A',operation:'CREATE_DRAFT_PR',status:'blocked',reason:'branch_missing'},
  {task_id:'X',operation:'CREATE_DRAFT_PR',status:'blocked',
    reason:'missing_pr_creator_install_token'}]);
 assert.equal(Object.values(s.owner_alerts).length,0);
});


test('uncertain PR creation hold is sticky across unrelated observations and exact-head updates',()=>{
 const uncertain={task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'uncertain',reason:'PR_create_effect_unverified',head_sha:head};
 const first=recordGithubEffects(state,[uncertain],now);
 assert.equal(first.tasks.A.pr_creation_uncertain_hold.attempted_head_sha,head);
 const newer=recordGithubEffects(first,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'blocked',reason:'branch_missing',head_sha:head}],'2026-11-11T10:05:00Z');
 assert.deepEqual(newer.tasks.A.pr_creation_uncertain_hold,
   first.tasks.A.pr_creation_uncertain_hold);
 assert.equal(recordGithubEffects(first,[uncertain],'2026-11-11T10:10:00Z'),null);
});
test('late uncertain PR result from older head still latches the task branch',()=>{
 const rec={...state,tasks:{...state.tasks,A:{...state.tasks.A,head_sha:head}}};
 const first=recordGithubEffects(rec,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'uncertain',reason:'transport_unverified',head_sha:other}],now);
 assert.equal(first.tasks.A.pr_creation_uncertain_hold.attempted_head_sha,other);
});
test('verified PR discovery clears uncertainty only after matching PR is durably linked',()=>{
 const first=recordGithubEffects(state,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'uncertain',reason:'transport_unverified',head_sha:head}],now);
 const stale=recordGithubEffects(first,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'existing_pr_needs_link',pr_number:451,head_sha:head}],'2026-11-11T10:01:00Z');
 assert.ok(stale.tasks.A.pr_creation_uncertain_hold,
   'PR number 451 was not verified in the task record yet');
 const linked=structuredClone(stale);linked.tasks.A.pr_number=451;
 const confirmed=recordGithubEffects(linked,[{task_id:'A',operation:'CREATE_DRAFT_PR',
   status:'existing_pr_needs_link',pr_number:451,head_sha:head}],'2026-11-11T10:02:00Z');
 assert.equal(confirmed.tasks.A.pr_creation_uncertain_hold,undefined);
});
