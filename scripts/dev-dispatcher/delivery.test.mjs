import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelivery, validConversationUrl } from './delivery.mjs';
const task = { id: '6', title: 'Durable worker', goal: 'resume safely',
  brief: 'docs/plans/universal-supervisor-task-briefs.md#task-6',
  architecture_approval: { approved: true }, state: 'ready', exclusive_files: ['lib/ai/supervisor/runs/x.ts'] };
const record = { approved: true, agent: 'chatgpt' };
test('creates approved new-project chat handoff without code', () => {
  const d = createDelivery({ task, record, action: 'assign', actionId: 'assign:6' });
  assert.equal(d.intent, 'start_new_chat');
  assert.equal(d.conversation_url, null);
  assert.match(d.prompt, /Durable worker/);
  assert.match(d.prompt, /AGENTS\.md/);
});
test('refuses a task without owner approval and ownership', () => {
  assert.throws(() => createDelivery({ task: {...task, architecture_approval: null}, record, action: 'assign', actionId:'a' }));
  assert.throws(() => createDelivery({ task: {...task, exclusive_files: []}, record, action: 'assign', actionId:'a' }));
});
test('follow-up requires and preserves exact allowed chat URL', () => {
  const url = 'https://chatgpt.com/c/abcd-1234';
  const d = createDelivery({ task, record: {...record, conversation_ref:url, pr_number:389}, action: 'repair_ci', actionId: 'repair:6' });
  assert.equal(d.conversation_url, url); assert.equal(d.intent, 'continue_existing_chat');
  assert.match(d.prompt, /repair_ci/);
  assert.throws(() => createDelivery({ task, record, action: 'repair_ci', actionId:'bad' }));
});
test('URL policy rejects alternate host, port, query, fragments and paths', () => {
  for (const url of ['https://chatgpt.com.evil/c/abc', 'http://chatgpt.com/c/abc', 'https://chatgpt.com:9999/c/abc', 'https://chatgpt.com/c/abc?q=1', 'https://chatgpt.com/'])
    assert.equal(validConversationUrl('chatgpt', url), false, url);
  assert.equal(validConversationUrl('claude','https://claude.ai/chat/abc-123'),true);
});

test('dependent assignment opens draft immediately on prerequisite branch, independent is ready',()=>{
 const stacked=createDelivery({task,record:{...record,base_branch:'feat/upstream',prerequisite_pr:393},action:'assign',actionId:'stacked:6'});
 assert.equal(stacked.base_branch,'feat/upstream');
 assert.match(stacked.prompt,/OPEN A DRAFT PR IMMEDIATELY/);
 assert.match(stacked.prompt,/not main/);
 assert.doesNotMatch(stacked.prompt,/Finish implementation and its acceptance evidence BEFORE opening the PR/);
 const independent=createDelivery({task,record:{...record,base_branch:'main'},action:'assign',actionId:'independent:6'});
 assert.match(independent.prompt,/INDEPENDENT TASK/);
 assert.match(independent.prompt,/READY FOR REVIEW/);
});
