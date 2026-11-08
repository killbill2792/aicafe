import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
 assert.match(stacked.prompt,/not main/i);
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

test('approved task-specific queue skills and exact brief anchor are delivered unchanged',()=>{
 const custom={...task,id:'POS0a',brief:'docs/plans/universal-supervisor-task-briefs.md#task-pos0a',
  skills:['aicafe-pr-lifecycle','supabase','vitest','pr','supabase']};
 const d=createDelivery({task:custom,record,action:'assign',actionId:'assign:POS0a-skills'});
 assert.match(d.prompt,/TASK-SPECIFIC SKILLS from the approved queue/);
 assert.match(d.prompt,/\["aicafe-pr-lifecycle","supabase","vitest","pr"\]/);
 assert.match(d.prompt,/docs\/plans\/universal-supervisor-task-briefs\.md#task-pos0a/);
 assert.doesNotMatch(d.prompt,/#task-POS0a/);
 assert.match(d.prompt,/document any unavailable entry rather than inventing skill instructions/);
});

test('POS0 data contributors receive the mandatory source classification and proof before coding', () => {
  const posTask={...task,id:'POS0e',title:'Current-reader foundation',goal:'retire diagnostic readers',
    brief:'docs/plans/universal-supervisor-task-briefs.md#task-pos0e',
    acceptance:['current object and no diagnostic contamination']};
  for (const agent of ['chatgpt','claude']) {
    const d=createDelivery({task:posTask,record:{...record,agent},action:'assign',actionId:'pos0-source-'+agent});
    for (const required of ['POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING',
      'docs/rules/pos-data.md','toast_raw_records','toast_raw_changes',
      'toast_raw_samples','LEGACY_DIAGNOSTIC_ONLY','source_authority_checked: yes',
      'describe_data','query_data','diagnostic-only values never influence live results']) {
      assert.ok(d.prompt.includes(required),required);
    }
    assert.ok(d.prompt.indexOf('POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING') <
      d.prompt.indexOf('OPEN THE DRAFT PR PROMPTLY'));
  }
  const nonPos=createDelivery({task,record,action:'assign',actionId:'independent-6-source'});
  assert.doesNotMatch(nonPos.prompt,/POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING/);
});

test('POS0a-f agent receives exact approved/defective/unapproved contract in order', () => {
 const queue=JSON.parse(readFileSync(new URL('../../docs/plans/universal-supervisor-queue.json',import.meta.url),'utf8'));
 assert.equal(queue.dispatch_rules.architecture_foundation_implementation_approval.approved,false);
 assert.equal(queue.dispatch_rules.pos_d4_contract.implementation_approved,false);
 assert.equal(queue.dispatch_rules.pos_d4_contract.future_order_recovery.dispatchable,false);
 assert.ok(!queue.tasks.some(t=>t.id==='POS0-order-recovery'));
 assert.deepEqual(queue.dispatch_rules.pos_d4_contract.must_preserve_merged_prs,[189,203,264,297]);
 assert.equal(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.future_implementation_approved,false);
 assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.pending_reminders,/two per owner\/experiment/);
 assert.ok(queue.tasks.find(t=>t.id==='POS0d').acceptance.some(s=>s.includes('Toast-first Menu')));
 assert.ok(queue.tasks.find(t=>t.id==='8a').acceptance.some(s=>s.includes('First pending reminder')));
 assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.measurement_clock_rule,/N consecutive rolling windows of 24 elapsed hours/);
 for(const id of ['POS0a','POS0b','POS0c','POS0d','POS0e','POS0f']){
  const real=queue.tasks.find(t=>t.id===id);
  assert.ok(real,id);
  if(id==='POS0a'){
   assert.equal(real.architecture_approval?.approved,true,'POS0a documentation audit already authorized');
   assert.doesNotThrow(()=>createDelivery({task:real,record,action:'assign',actionId:'approved:'+id}));
  }else{
   assert.notEqual(real.architecture_approval?.approved,true,id+' must remain unauthorized');
   assert.throws(()=>createDelivery({task:real,record,action:'assign',actionId:'unapproved:'+id}));
  }
  const mockApproved={...task,id,title:real.title,goal:real.goal,brief:real.brief,skills:real.skills,
    acceptance:real.acceptance,exclusive_files:real.exclusive_files.length?real.exclusive_files:['docs/rules/tests.md']};
  for(const agent of ['chatgpt','claude']){
   // Simulate eventual explicitly approved task WITHOUT modifying machine authorization.
   const d=createDelivery({task:mockApproved,record:{...record,agent},action:'assign',actionId:'handoff:'+id+':'+agent});
   assert.equal(d.intent,'start_new_chat');
   assert.match(d.prompt,/TASK ACCEPTANCE \(signed\): Read EVERY task\.acceptance entry/);
   assert.equal(d.prompt.includes(JSON.stringify(real.acceptance)),false,'full signed acceptance must not be duplicated in browser prompt');
   assert.ok(d.prompt.length<12000,id+' '+agent+' assignment: '+d.prompt.length);
   // A saved conversation and changed base add more text than first assignment.
   const follow={...record,agent,
     conversation_ref:agent==='claude'?'https://claude.ai/chat/test-pos0-aicafe':'https://chatgpt.com/c/test-pos0-aicafe',
     pr_number:400,branch:'feat/aicafe-task-POS0a',base_branch:'feat/prerequisite-foundation',
     prerequisite_pr:398,head_sha:'0123456789abcdef0123456789abcdef01234567',
     ci_state:'in_progress',codex_state:'review_fixing',base_current:false,review_base_current:false};
   const resumed=createDelivery({task:mockApproved,record:follow,action:'continue_pr',actionId:'handoff-follow:'+id+':'+agent});
   assert.equal(resumed.intent,'continue_existing_chat');
   assert.ok(resumed.prompt.length<12000,id+' '+agent+' continuation: '+resumed.prompt.length);
   const block=d.prompt.slice(d.prompt.indexOf('POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING'));
   const required=[
    '(1) current main AGENTS.md',
    '(2) binding docs/rules/pos-data.md',
    '(3) docs/plans/toast-standard-api-coverage-matrix.md',
    '(4) THIS exact docs/plans/universal-supervisor-task-briefs.md task anchor AND docs/plans/universal-supervisor-queue.json',
    '(5) inspect real existing code',
    '(6) docs/rules/tests.md executable acceptance'
   ];
   let previous=-1;
   for(const part of required){const at=block.indexOf(part);assert.ok(at>previous,id+' missing/unordered: '+part);previous=at;}
   for(const fact of ['D1-D4A/D4B/D4C PRINCIPLES approved only','architecture_foundation_implementation_approval.approved','false means STOP',
     'non-order toast_records_for','cv_cash/cv_inventory/cv_kitchen/cv_dining_options',
     'seen_run_id','SQL day import','liveArchive.server.ts','menu full fetch twice','POS0e','POS0b','POS0c','POS0d','POS0f',
     'NO separately owner-approved implementation PR','PR #398 is draft','source_authority_checked: yes',
      'D4A Approach B','D4B lossless SQL','POS0-order-recovery','#189','#203','#264','#297',
      '10-minute coordinator','15-minute live-order','99 good plus one DB-failing order',
      'processing stages received/raw_saved/parsed_validated/canonical_promoted/metric_reconciled',
      'scoped cafe+restaurant+Toast order GUID','NO existing status column','full current-day ordersBulk',
      'no-GUID or failed row/page write','Clear issues ONLY after durable save',
      'D4C menu lifecycle','provider INACTIVE','same GUID republish','Empty/partial/wrong-version/unauthorized/missing-reference/zero-sales',
      'MENU/EXPERIMENT SPEC HANDOFF','specs/0001-d4c-toast-menu-authority-and-owner-review.md',
      'specs/0002-pos-change-verified-experiment-activation.md','Toast-first connected catalog',
      'UNPUBLISHED Owner review','Option A','manual_done','~+2h','MAX TWO','rolling 24h','final cafe-close extension',
     'diagnostic snapshots','roll back','rollback']){
     if(fact==='roll back')continue;
     assert.ok(block.includes(fact),id+' missing '+fact);
   }
   assert.match(d.prompt,/No new system|Do not create competing system/);
   assert.ok(d.prompt.indexOf('POS0 SOURCE AUTHORITY PREFLIGHT BEFORE CODING')<d.prompt.indexOf('OPEN THE DRAFT PR PROMPTLY'));
  }
 }
});
