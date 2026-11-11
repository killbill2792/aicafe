import test from 'node:test';
import assert from 'node:assert/strict';
import {recordGithubEffects} from './github-effects-v3.mjs';
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
