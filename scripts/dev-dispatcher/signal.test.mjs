import test from 'node:test';
import assert from 'node:assert/strict';
import { signalFor } from './signal.mjs';
import { wakePendingActions } from './core.mjs';
import { noticeHash } from './alerts.mjs';
import { createHash } from 'node:crypto';
const prompt = 'approved task';
const hash = createHash('sha256').update(prompt).digest('hex');
const delivery = { version: 1, action_id: 'assign:6', project: {id:'aicafe',name:'AI CAFE'},
  provider:'chatgpt', task_id:'6', intent:'start_new_chat', conversation_url:null,
  base_branch:'main', prompt, prompt_hash:hash, approval_hash:'a'.repeat(64) };
const task = { approved:true, agent:'chatgpt', approval_hash:'a'.repeat(64) };
const state = {version:1,tasks:{'6':task},actions:{'assign:6':{task_id:'6',type:'assign',status:'planned',delivery_owner:'muse',delivery}}};
test('signal exposes no IDs or prompts, and remains unchanged for CI churn',()=>{
 const secret='secret'.repeat(8);
 const a=signalFor(state,secret);
 assert.equal(a.pending_count,1);
 assert.doesNotMatch(JSON.stringify(a),/assign:6|approved task|aicafe/);
 const changed=structuredClone(state);changed.tasks['6'].ci_state='failure';
 assert.deepEqual(signalFor(changed,secret),a);
 changed.actions['assign:6'].status='submitted';
 assert.equal(signalFor(changed,secret).pending_count,0);
 assert.notEqual(signalFor(changed,secret).fingerprint,a.fingerprint);
});
test('malformed handoffs are excluded from public pending count',()=>{
 const changed=structuredClone(state);changed.actions['assign:6'].delivery.prompt_hash='f'.repeat(64);
 assert.equal(signalFor(changed,'secret'.repeat(8)).pending_count,0);
 const wrong=structuredClone(state);wrong.actions['assign:6'].delivery_owner='dave';
 assert.equal(signalFor(wrong,'secret'.repeat(8)).pending_count,0);
 const missing=structuredClone(state);delete missing.actions['assign:6'].delivery_owner;
 assert.equal(signalFor(missing,'secret'.repeat(8)).pending_count,0);
});

test('owner notices wake Muse without exposing the question or PR ID',()=>{
 const secret='secret'.repeat(8);
 const withOwner=structuredClone(state);
 const entry={kind:'unmapped_pr',task_id:null,pr_number:987,question:'Which task is PR 987?',status:'planned',delivery_owner:'muse'};
 entry.notice_hash=noticeHash(entry);
 withOwner.owner_alerts={'notice:one':entry};
 const signaled=signalFor(withOwner,secret);
 assert.equal(signaled.pending_count,2);
 assert.doesNotMatch(JSON.stringify(signaled),/987|Which task|notice:one/);
 const stale=structuredClone(withOwner);stale.owner_alerts['notice:one'].status='submitted';
 assert.equal(signalFor(stale,secret).pending_count,1);
});

test('overdue planned Muse delivery creates a private-ledger wake without resending',()=>{
 const secret='secret'.repeat(8);
 const base=structuredClone(state);
 base.actions['assign:6'].created_at='2026-11-09T19:00:00Z';
 const now=Date.parse('2026-11-09T19:16:00Z');
 const initial=signalFor(base,secret);
 wakePendingActions(base,now);
 assert.equal(base.actions['assign:6'].status,'planned');
 assert.equal(base.actions['assign:6'].wake_round,1);
 const repeated=signalFor(base,secret);
 assert.notEqual(repeated.fingerprint,initial.fingerprint);
 assert.equal(repeated.pending_count,1);
 assert.doesNotMatch(JSON.stringify(repeated),/assign:6|aicafe/);
 wakePendingActions(base,now+600000);
 assert.equal(base.actions['assign:6'].wake_round,1);
 wakePendingActions(base,now+900000);
 assert.equal(base.actions['assign:6'].wake_round,2);
 const superseded=structuredClone(base);
 superseded.actions['assign:6'].status='cancelled_stale_head';
 wakePendingActions(superseded,now+3600000);
 assert.equal(superseded.actions['assign:6'].wake_round,2);
 assert.equal(signalFor(superseded,secret).pending_count,0);
});
