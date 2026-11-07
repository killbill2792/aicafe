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
test('every approved task prompt requires live merged-PR and integration evidence', () => {
  const d=createDelivery({task,record,action:'assign',actionId:'assign:6-proof'});
  assert.match(d.prompt,/PRIOR MERGED WORK/);
  assert.match(d.prompt,/actual merge commit SHAs/);
  assert.match(d.prompt,/executed CI\/acceptance\/integration run IDs and artifacts/);
  assert.match(d.prompt,/production release/);
  assert.match(d.prompt,/other dependencies/);
  assert.match(d.prompt,/existing paths/);
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

test('both independent and dependent authorized tasks open a draft early',()=>{
 const stacked=createDelivery({task,record:{...record,base_branch:'feat/upstream',prerequisite_pr:393},action:'assign',actionId:'stacked:6'});
 assert.equal(stacked.base_branch,'feat/upstream');
 assert.match(stacked.prompt,/OPEN A DRAFT PR PROMPTLY/);
 assert.match(stacked.prompt,/not main/);
 assert.doesNotMatch(stacked.prompt,/Finish implementation and its acceptance evidence BEFORE opening the PR/);
 const independent=createDelivery({task,record:{...record,base_branch:'main'},action:'assign',actionId:'independent:6'});
 assert.match(independent.prompt,/INDEPENDENT TASK/);
 assert.match(independent.prompt,/OPEN A DRAFT PR PROMPTLY/);
 assert.doesNotMatch(independent.prompt,/before opening a READY FOR REVIEW/);
 assert.match(stacked.prompt,/Do not wait for that dependency to merge/);
 assert.match(stacked.prompt,/Other dependencies remain merge blockers/);
});

test('every coding agent receives exact current authority, three skill files, shared-progress lock and Codex lifecycle', () => {
 for (const who of ['chatgpt','claude']) {
  const d=createDelivery({task,record:{...record,agent:who},action:'assign',actionId:'assign:6-'+who});
  const prompt=d.prompt;
  for(const required of [
   'AGENTS.md','PROGRESS.md','docs/rules/skills.md',
   'docs/plans/universal-supervisor-queue.json',
   'docs/plans/universal-supervisor-agent-operations.md',
   'docs/plans/universal-supervisor-delivery-queue-2026-11.md',
   'aicafe-pr-lifecycle/SKILL.md','aicafe-dependency-check/SKILL.md',
   'aicafe-proof-gate/SKILL.md','PRIOR MERGED WORK','actual merge commit SHAs',
   'same','PROGRESS.md','DO NOT create a background monitoring loop',
   'needs-owner-decision','aicafe-owner-question',
   'Vercel preview deployments/builds'
  ]) assert.ok(prompt.toLowerCase().includes(required.toLowerCase()), required);
  assert.match(prompt,/final applicable head is reviewed clean/);
  assert.match(prompt,/resolved threads/);
  assert.match(prompt,/request a fresh Codex review/);
  assert.match(prompt,/NEVER edit PROGRESS.md/);
  assert.doesNotMatch(prompt,/Muse|browser tabs|courier receipts/i);
  assert.ok(prompt.length<12000);
 }
});
test('same-chat follow-up owns pre-PR/draft/CI repair without replacing task or sending delivery machinery',()=>{
 const url='https://chatgpt.com/c/abc-123';
 for(const action of ['pre_pr_reminder','continue_pr','repair_ci','repair_review']){
  const rec={...record,conversation_ref:url,pr_number:action==='pre_pr_reminder'?null:401,
    branch:'feat/approved',draft:true,head_sha:'abc123',ci_state:'pending',codex_state:'pending'};
  const d=createDelivery({task,record:rec,action,actionId:action+':6'});
  assert.equal(d.conversation_url,url);
  assert.equal(d.intent,'continue_existing_chat');
  assert.match(d.prompt,/Continue from where you left off in THIS SAME chat/);
  assert.match(d.prompt,/If PR is missing, open its draft now/);
  assert.match(d.prompt,/final-head Codex review/);
  assert.match(d.prompt,/DO NOT create a background monitoring loop/);
  assert.doesNotMatch(d.prompt,/Muse|courier receipts/i);
 }
});
