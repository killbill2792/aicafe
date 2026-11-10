import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDelivery,validConversationUrl,approvalSignature,promptHash} from './delivery.mjs';

const task={id:'6',title:'Durable worker',goal:'resume safely',
  brief:'docs/plans/universal-supervisor-task-briefs.md#task-6',
  architecture_approval:{approved:true},state:'ready',
  exclusive_files:['lib/ai/supervisor/runs/x.ts'],depends_on:[],acceptance:['one real proof']};
const record={approved:true,agent:'chatgpt'};
const url='https://chatgpt.com/c/abcd-1234';
const queue=JSON.parse(readFileSync(new URL('../../docs/plans/universal-supervisor-queue.json',import.meta.url),'utf8'));

test('assignment is a linked step-specific early draft, not a full copied rulebook',()=>{
  const d=createDelivery({task,record,action:'assign',actionId:'assign:6'});
  assert.equal(d.intent,'start_new_chat');
  assert.equal(d.conversation_url,null);
  assert.match(d.prompt,/Open EARLY DRAFT now/);
  assert.match(d.prompt,/blob\/main\/AGENTS\.md/);
  assert.match(d.prompt,/blob\/main\/PROGRESS\.md/);
  assert.match(d.prompt,/aicafe-pr-lifecycle\/SKILL\.md/);
  assert.match(d.prompt,/aicafe-dependency-check\/SKILL\.md/);
  assert.match(d.prompt,/aicafe-proof-gate\/SKILL\.md/);
  assert.match(d.prompt,/docs\/plans\/universal-supervisor-queue\.json/);
  assert.match(d.prompt,/task-6/);
  assert.match(d.prompt,/acceptance tests from signed queue/);
  assert.match(d.prompt,/comment dispositions/);
  assert.match(d.prompt,/<!-- aicafe-coder-done -->/);
  assert.match(d.prompt,/owner questions/);
  assert.match(d.prompt,/exact-head CI\/Codex/);
  assert.doesNotMatch(d.prompt,/Muse|courier receipts|whole rulebook/i);
  assert.ok(Buffer.byteLength(d.prompt,'utf8')<=2048);
  assert.equal(d.prompt_hash,promptHash(d.prompt));
});

test('independent and dependent authorized tasks open their draft immediately on exact base',()=>{
  const independent=createDelivery({task,record:{...record,base_branch:'main'},
    action:'assign',actionId:'independent'});
  const stacked=createDelivery({task,record:{...record,base_branch:'feat/parent',
    prerequisite_pr:398},action:'assign',actionId:'stacked'});
  assert.match(independent.prompt,/PR base main/);
  assert.match(stacked.prompt,/PR base feat\/parent \(parent PR #398\)/);
  assert.match(stacked.prompt,/Work\/commit\/test while parent is open/);
  assert.match(independent.prompt,/one final-head Codex review/);
  assert.match(stacked.prompt,/NO rebase or Codex until parent merged/);
  assert.doesNotMatch(stacked.prompt,/blocked until .* merges/i);
  assert.equal(stacked.base_branch,'feat/parent');
});

test('unapproved, empty scope, changed signature, unsafe links and unknown actions fail closed',()=>{
  assert.throws(()=>createDelivery({task:{...task,architecture_approval:null},
    record,action:'assign',actionId:'invalid'}));
  assert.throws(()=>createDelivery({task:{...task,exclusive_files:[]},
    record,action:'assign',actionId:'invalid'}));
  assert.throws(()=>createDelivery({task,record:{...record,approval_hash:'bad'},
    action:'assign',actionId:'invalid'}),/scope changed/);
  assert.throws(()=>createDelivery({task,record,action:'unknown',actionId:'invalid'}));
  assert.throws(()=>createDelivery({task:{...task,brief:'../outside.md'},
    record,action:'assign',actionId:'invalid'}),/Invalid task brief/);
  assert.throws(()=>createDelivery({task,record,action:'ci_failed',actionId:'no-chat'}),/saved conversation/);
  const signed=approvalSignature(task);
  assert.equal(signed.length,64);
  assert.equal(approvalSignature({...task,uses:['lib/used.mjs']}),signed===null?null:approvalSignature({...task,uses:['lib/used.mjs']}));
  assert.notEqual(approvalSignature({...task,edits:task.exclusive_files,uses:['lib/used.mjs']}),signed);
});

test('same-chat followups are short, state-specific, and never pretend to deliver',()=>{
  const cases=[
    ['pre_pr_reminder',/Open the authorized early draft PR/],
    ['continue_pr',/Continue this SAME PR\/chat/],
    ['repair_ci',/Diagnose the failing job/],
    ['repair_review',/Read unresolved review threads/],
    ['codex_comments',/codex_comments: Resolve these unresolved Codex threads/],
    ['ci_failed',/ci_failed:/],
    ['parent_merged',/parent_merged: Verified parent merge/],
    ['owner_answered',/owner_answered: Authenticated GitHub owner answer/],
    ['idle_continue',/idle_continue: Continue this SAME PR\/chat/]
  ];
  for(const [action,pattern] of cases){
    const d=createDelivery({task,record:{...record,conversation_ref:url,pr_number:400,
      base_branch:'main',owner_answer_text:'Use the original safe implementation',
      parent_merged_sha:'a'.repeat(40),ci_failure_job:'required baseline',
      ci_failure_url:'https://github.com/example/a/actions/runs/44',
      unresolved_codex_comments:[{body:'Keep null guard',url:'https://github.com/example/a/pull/400#discussion_r1'}]},
      action,actionId:action+':6'});
    assert.equal(d.intent,'continue_existing_chat');
    assert.equal(d.conversation_url,url);
    assert.match(d.prompt,pattern,action);
    assert.ok(Buffer.byteLength(d.prompt,'utf8')<=2048,action);
    assert.doesNotMatch(d.prompt,/Muse|courier receipts/i);
    if(action==='ci_failed')assert.match(d.prompt,/required baseline/);
    if(action==='codex_comments')assert.match(d.prompt,/Keep null guard/);
    if(action==='owner_answered')assert.match(d.prompt,/original safe implementation/);
  }
});

test('planning/brainstorm use one-question Superpowers design and explicit merge order with diagrams',()=>{
  for(const action of ['plan','brainstorm']){
    const d=createDelivery({task,record:{...record,conversation_ref:url},
      action,actionId:action});
    assert.match(d.prompt,/one question at a time/i);
    assert.match(d.prompt,/design/i);
    assert.match(d.prompt,/merge order/i);
    assert.match(d.prompt,/Mermaid diagrams/);
    assert.ok(Buffer.byteLength(d.prompt,'utf8')<=2048);
  }
});

test('URL validation is strict for both chat providers and never expands recipient scope',()=>{
  for(const bad of ['https://chatgpt.com.evil/c/abc','http://chatgpt.com/c/abc',
    'https://chatgpt.com:9999/c/abc','https://chatgpt.com/c/abc?q=1',
    'https://chatgpt.com/','https://evil.com/c/123'])
    assert.equal(validConversationUrl('chatgpt',bad),false,bad);
  assert.equal(validConversationUrl('chatgpt',url),true);
  assert.equal(validConversationUrl('claude','https://claude.ai/chat/abc-123'),true);
});

test('POS0 signed queue remains the authority for every source/privacy/proof rule, not prompt text',()=>{
  const rules=readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8');
  assert.equal(queue.dispatch_rules.architecture_foundation_implementation_approval.approved,true);
  assert.equal(queue.dispatch_rules.priority_gate_task,'POS0f');
  assert.match(queue.dispatch_rules.architecture_foundation_note,/TWO DISTINCT GATES/);
  assert.match(queue.dispatch_rules.architecture_foundation_note,/POS0e FIRST implements\/tests/);
  const byId=Object.fromEntries(queue.tasks.map(t=>[t.id,t]));
  assert.deepEqual(byId.POS0e.depends_on,['POS0a']);
  assert.deepEqual(byId.POS0f.depends_on,['POS0e','POS0b','POS0c','POS0d']);
  assert.equal(byId.POS0a.architecture_approval.approved,true);
  assert.match(byId.POS0a.goal,/READ-ONLY official GET\/nested-field/);
  assert.ok(byId.POS0a.acceptance.some(s=>s.includes('READER_MISSING/NOT_TESTED')));
  assert.ok(byId.POS0e.acceptance.some(s=>s.includes('Final migrated disposable Supabase')));
  assert.ok(byId.POS0f.acceptance.some(s=>s.includes('CI asserts complete chain Toast-shaped input')));
  assert.ok(byId.POS0f.acceptance.some(s=>s.includes('registered Supervisor')));
  for(const id of ['POS0b','POS0c','POS0d']){
    const t=byId[id];
    assert.deepEqual(t.depends_on,['POS0a','POS0e']);
    assert.equal(t.architecture_approval.approved,true);
    assert.ok(t.acceptance.some(s=>s.includes('writer→current-object→describe_data→query_data→normal one-agent Supervisor answer')));
  }
  assert.match(queue.dispatch_rules.pos_source_authority.ordered_first_read[2],/PR #398 concise POS0a handoff FIRST/);
  assert.match(queue.dispatch_rules.pos_source_authority.owner_hold,/OWNER CODING RELEASED IN EXACT QUEUE SCOPES/);
  assert.equal(queue.dispatch_rules.pos_d4_contract.implementation_approved,false);
  assert.equal(queue.dispatch_rules.pos_d4_contract.future_order_recovery.dispatchable,false);
  assert.equal(queue.tasks.some(t=>t.id==='POS0-order-recovery'),false);
  assert.deepEqual(queue.dispatch_rules.pos_d4_contract.must_preserve_merged_prs,[189,203,264,297]);
  assert.equal(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.future_implementation_approved,false);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.pending_reminders,/two per owner\/experiment/);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.connected_menu,/ONE live authenticated complete restaurant\/version-consistent Toast published catalog/);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.manual_owner_draft,/NO local Add Item\/unpublished draft product/);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.historical_rule,/historical Option B evidence-first APPROVED/);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.measurement_clock_rule,/N consecutive rolling windows of 24 elapsed hours/);
  assert.match(queue.dispatch_rules.pos_d4_contract.toast_first_catalog_and_experiment_approved.unrequested_price_change_observation,/DAILY insight on EACH day 1-7/);
  for(const word of ['toast_raw_records','toast_raw_changes','toast_raw_samples',
    'LEGACY_DIAGNOSTIC_ONLY','seen_run_id','describe_data','query_data',
    'liveArchive.server.ts','source_authority_checked: yes'])
    assert.ok(rules.includes(word),word+' required in source authority');
});

test('all authorized POS0 prompts are small and require linked preflight instead of bulky copied facts',()=>{
  for(const id of ['POS0a','POS0b','POS0c','POS0d','POS0e','POS0f']){
    const t=queue.tasks.find(t=>t.id===id);
    assert.equal(t.architecture_approval?.approved,true);
    const d=createDelivery({task:t,record,action:'assign',actionId:'approved:'+id});
    assert.match(d.prompt,/POS0 preflight/);
    assert.match(d.prompt,/docs\/rules\/pos-data\.md/);
    assert.match(d.prompt,/#398 handoff/);
    assert.match(d.prompt,/source-authority order/);
    assert.match(d.prompt,/signed coding scope required/);
    assert.match(d.prompt,/Signed queue/);
    assert.ok(Buffer.byteLength(d.prompt,'utf8')<=2048,id+': '+Buffer.byteLength(d.prompt,'utf8'));
    assert.equal(d.prompt.includes(JSON.stringify(t.acceptance)),false);
    assert.throws(()=>createDelivery({task:{...t,architecture_approval:null},record,
      action:'assign',actionId:'revoked:'+id}));
  }
});


test('POS0e Codex follow-up with three maximum excerpts is delivered even past 2 KB', () => {
  const pos0e = queue.tasks.find(t => t.id === 'POS0e');
  const comments = Array.from({ length: 3 }, (_, i) => ({
    body: ('Codex finding ' + i + ' ').padEnd(400, 'x'),
    url: 'https://github.com/killbill2792/aicafe/pull/404#discussion_r' + '9'.repeat(150)
  }));
  const result = createDelivery({
    task: pos0e,
    record: { approved: true, agent: 'chatgpt', pr_number: 404,
      conversation_ref: url, unresolved_codex_comments: comments },
    action: 'codex_comments', actionId: 'codex_comments:POS0e:head'
  });
  assert.equal(result.task_id, 'POS0e');
  assert.equal(result.intent, 'continue_existing_chat');
  assert.ok(Buffer.byteLength(result.prompt, 'utf8') > 2048,
    'exercise the former 2 KB hard-failure case');
  assert.equal(result.prompt_hash, promptHash(result.prompt));
  assert.equal((result.prompt.match(/Codex finding/g) || []).length, 3);
});

test('oversize prompts warn past 4096 bytes but still return without leaking prompt text', () => {
  const longScope = Array.from({ length: 8 }, (_, i) =>
    'lib/' + 'long-safe-path-'.repeat(45) + i + '.mjs');
  const expanded = { ...task, exclusive_files: longScope };
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const result = createDelivery({ task: expanded, record, action: 'assign',
      actionId: 'long-scope' });
    assert.ok(Buffer.byteLength(result.prompt, 'utf8') > 4096);
    assert.equal(result.prompt_hash, promptHash(result.prompt));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /4096 bytes/);
    assert.doesNotMatch(warnings[0], /long-safe-path/);
  } finally {
    console.warn = original;
  }
});
