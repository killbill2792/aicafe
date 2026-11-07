import test from 'node:test';
import assert from 'node:assert/strict';
import { signalFor } from './signal.mjs';
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
