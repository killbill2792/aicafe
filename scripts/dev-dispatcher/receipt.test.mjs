import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { acceptDeliveryReceipt } from './receipt.mjs';
import { applyReceipts } from './inbox.mjs';
const prompt='implement approved task';
const prompt_hash=createHash('sha256').update(prompt).digest('hex');
const d={action_id:'assign:6',task_id:'6',project:{id:'aicafe',name:'AI CAFE'},
 provider:'chatgpt',intent:'start_new_chat',prompt,prompt_hash,approval_hash:'a'.repeat(64)};
const state={tasks:{'6':{approved:true,agent:'chatgpt',approval_hash:d.approval_hash}},
 actions:{'assign:6':{status:'planned',delivery_owner:'muse',task_id:'6',delivery:d}}};
const receipt={action_id:'assign:6',prompt_hash,conversation_url:'https://chatgpt.com/c/abc-123',provider:'chatgpt',project_id:'aicafe'};
test('only authenticated matching receipt advances queue',()=>{
 assert.throws(()=>acceptDeliveryReceipt(state,receipt),/identity/);
 const next=acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'muse'});
 assert.equal(next.actions['assign:6'].status,'submitted');
 assert.equal(next.tasks['6'].conversation_ref,receipt.conversation_url);
 assert.equal(state.actions['assign:6'].status,'planned');
 assert.throws(()=>acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'dave'}),/does not own/);
 const missing=structuredClone(state);delete missing.actions['assign:6'].delivery_owner;
 assert.throws(()=>acceptDeliveryReceipt(missing,receipt,{authenticatedCourier:'muse'}),/does not own/);
 assert.throws(()=>acceptDeliveryReceipt(next,receipt,{authenticatedCourier:'dave'}),/not currently/);
});
test('wrong hash, provider, project, URL and revoked task fail closed',()=>{
 for(const patch of [{prompt_hash:'f'.repeat(64)},{provider:'claude'},{project_id:'other'},
 {conversation_url:'https://evil.example/c/abc'}]){
 assert.throws(()=>acceptDeliveryReceipt(state,{...receipt,...patch},{authenticatedCourier:'muse'}));
 }
 assert.throws(()=>acceptDeliveryReceipt({...state,tasks:{'6':{...state.tasks['6'],approved:false}}},receipt,{authenticatedCourier:'muse'}));
});
test('follow-up receipt must match existing conversation',()=>{
 const existing='https://chatgpt.com/c/existing-123';
 const follow={tasks:{'6':{...state.tasks['6'],conversation_ref:existing}},
 actions:{'fix:6':{status:'planned',delivery_owner:'muse',task_id:'6',delivery:{...d,action_id:'fix:6',intent:'continue_existing_chat',conversation_url:existing}}}};
 assert.throws(()=>acceptDeliveryReceipt(follow,{...receipt,action_id:'fix:6'},{authenticatedCourier:'muse'}));
 assert.equal(acceptDeliveryReceipt(follow,{...receipt,action_id:'fix:6',conversation_url:existing},{authenticatedCourier:'muse'}).actions['fix:6'].status,'submitted');
});

test('existing Muse nested project envelope is accepted and records the same chat once',()=>{
 const nested={...receipt,project:{id:'aicafe',name:'AI CAFE'}};
 delete nested.project_id;
 const next=acceptDeliveryReceipt(state,nested,{authenticatedCourier:'muse'});
 assert.equal(next.actions['assign:6'].status,'submitted');
 assert.equal(next.tasks['6'].conversation_ref,receipt.conversation_url);
 assert.throws(()=>acceptDeliveryReceipt(next,nested,{authenticatedCourier:'muse'}),/not currently/);
});
test('receipt project identity is fail-closed if missing, conflicting or malformed',()=>{
 for(const changes of [
  {project_id:'other',project:{id:'aicafe'}},
  {project_id:'aicafe',project:{id:'other'}},
  {project_id:'aicafe',project:{id:null}},
  {project_id:'aicafe',project:'aicafe'},
  {project_id:'aicafe',project:null},
  {project_id:3},
  {project:{name:'AI CAFE'}},
  {project:null},
  {project:'aicafe'},
 ]) assert.throws(()=>acceptDeliveryReceipt(state,{...receipt,...changes},{authenticatedCourier:'muse'}),/Receipt project\/provider mismatch/);
 const missing={...receipt};delete missing.project_id;
 assert.throws(()=>acceptDeliveryReceipt(state,missing,{authenticatedCourier:'muse'}),/Receipt project\/provider mismatch/);
 const both={...receipt,project:{id:'aicafe',name:'AI CAFE'}};
 assert.equal(acceptDeliveryReceipt(state,both,{authenticatedCourier:'muse'}).actions['assign:6'].status,'submitted');
 assert.throws(()=>acceptDeliveryReceipt(state,{...both,prompt_hash:'f'.repeat(64)},{authenticatedCourier:'muse'}),/Receipt does not match/);
 assert.throws(()=>acceptDeliveryReceipt(state,{...both,conversation_url:'https://evil.example/c/fake'},{authenticatedCourier:'muse'}),/Receipt does not match/);
 assert.throws(()=>acceptDeliveryReceipt(state,both,{authenticatedCourier:'dave'}),/does not own/);
});

test('late original Muse receipt restores the exact chat after the PR cancels assignment',()=>{
 const late={...structuredClone(state),
   tasks:{'6':{...state.tasks['6'],task_id:'6',github_state:'open',
     pr_number:405,branch:'feat/aicafe-task-6',conversation_ref:null}},
   actions:{'assign:6':{...state.actions['assign:6'],
     type:'assign',status:'cancelled_stale_head'}}};
 const envelope={...receipt,approval_hash:d.approval_hash,project:{id:'aicafe',name:'AI CAFE'}};
 delete envelope.project_id;
 const next=applyReceipts(late,[{receipt:envelope,actor:'courier-id'}],
   {'courier-id':'muse'});
 assert.equal(next.tasks['6'].conversation_ref,receipt.conversation_url);
 assert.equal(next.actions['assign:6'].status,'submitted');
 assert.equal(next.actions['assign:6'].recovered_original_chat_after_pr,true);
 assert.equal(late.actions['assign:6'].status,'cancelled_stale_head');
 assert.deepEqual(applyReceipts(next,[{receipt:envelope,actor:'courier-id'}],
   {'courier-id':'muse'}),next);
 // PR-head cancellation may restore identity, but never revive stale
 // follow-up prompts, revoked tasks, wrong branches or invalid chat URLs.
 const follow=structuredClone(late);
 follow.actions['assign:6'].type='continue_pr';
 assert.deepEqual(applyReceipts(follow,[{receipt:envelope,actor:'courier-id'}],
   {'courier-id':'muse'}),follow);
 for(const changed of [
   {branch:'feat/aicafe-task-another'},
   {github_state:'closed'},
   {approved:false},
   {conversation_ref:'https://chatgpt.com/c/other'},
 ]) {
   const wrong=structuredClone(late);
   Object.assign(wrong.tasks['6'],changed);
   assert.throws(()=>acceptDeliveryReceipt(wrong,envelope,{authenticatedCourier:'muse'}));
 }
 const placeholder={...envelope,conversation_url:
   'https://chatgpt.com/g/g-p-aicafe/c/local-chatgpt%3Aplaceholder'};
 assert.throws(()=>acceptDeliveryReceipt(late,placeholder,{authenticatedCourier:'muse'}));
 assert.throws(()=>acceptDeliveryReceipt(late,envelope,{authenticatedCourier:'dave'}));
});

test('superseded continuation receipt is audited but never revives old-head work',()=>{
 const url='https://chatgpt.com/c/existing-123';
 const stale={tasks:{'6':{approved:true,approval_hash:d.approval_hash,head_sha:'new',
   conversation_ref:url,last_submission_at:'2026-11-09T20:00:00Z',submission_state:'idle'}},
   actions:{'fix:6':{status:'cancelled_stale_head',type:'repair_ci',delivery_owner:'muse',
     task_id:'6',head_sha:'old',delivery:{...d,action_id:'fix:6',
       intent:'continue_existing_chat',conversation_url:url}}}};
 const submitted={...receipt,action_id:'fix:6',conversation_url:url,
   submitted_at:'2026-11-09T19:59:00Z'};
 const audit=applyReceipts(stale,[{actor:'muse-app[bot]',receipt:submitted}],
   {'muse-app[bot]':'muse'});
 assert.equal(audit.actions['fix:6'].status,'cancelled_stale_head');
 assert.equal(audit.actions['fix:6'].superseded_receipt.submitted_at,submitted.submitted_at);
 assert.equal(audit.tasks['6'].last_submission_at,'2026-11-09T20:00:00Z');
 assert.equal(audit.tasks['6'].submission_state,'idle');
 assert.equal(applyReceipts(audit,[{actor:'muse-app[bot]',receipt:submitted}],
   {'muse-app[bot]':'muse'}).actions['fix:6'].status,'cancelled_stale_head');
 assert.throws(()=>acceptDeliveryReceipt(stale,{...submitted,prompt_hash:'bad'},
   {authenticatedCourier:'muse'}),/Receipt does not match/);
 assert.throws(()=>acceptDeliveryReceipt(stale,submitted,{authenticatedCourier:'dave'}),
   /does not own/);
});

test('same-cycle PR head change is reconciled before accepting an old repair receipt',async()=>{
 const {reconcileGithub}=await import('./core.mjs');
 const url='https://chatgpt.com/c/existing-123';
 const waiting={tasks:{'6':{task_id:'6',approved:true,agent:'chatgpt',
   status:'draft_open',pr_number:101,github_state:'open',head_sha:'old',
   approval_hash:d.approval_hash,conversation_ref:url,submission_state:'idle'}},
   actions:{'fix:6':{status:'planned',type:'repair_ci',head_sha:'old',
     task_id:'6',delivery_owner:'muse',delivery:{...d,action_id:'fix:6',
       intent:'continue_existing_chat',conversation_url:url}}}};
 const observed=[{pr_number:101,head_sha:'new',draft:true,base_sha:'base',
   github_owner_question:null,last_commit_at:'2026-11-09T20:00:00Z'}];
 const invalidated=reconcileGithub(waiting,observed);
 assert.equal(invalidated.actions['fix:6'].status,'cancelled_stale_head');
 const delivered=applyReceipts(invalidated,[{actor:'muse-app[bot]',
   receipt:{...receipt,action_id:'fix:6',conversation_url:url}}],
   {'muse-app[bot]':'muse'});
 assert.equal(delivered.actions['fix:6'].status,'cancelled_stale_head');
 assert.ok(delivered.actions['fix:6'].superseded_receipt);
 assert.equal(delivered.tasks['6'].submission_state,'idle');
});
