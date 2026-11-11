import test from 'node:test';
import assert from 'node:assert/strict';
import {queueOwnerAlerts,acceptOwnerNoticeReceipt} from './alerts.mjs';
import {signalFor} from './signal.mjs';
const state={version:1,tasks:{'6':{agent:'chatgpt',pr_number:123,owner_question:'Approve widening file ownership?'},
 '7':{agent:'claude',pr_number:124,blocker:{kind:'usage_limit',confirmed:true,detail:'Session limit reached'}}},actions:{}};
test('owner notices are deduplicated and carry exact question and PR',()=>{
 const first=queueOwnerAlerts(state,{unmappedPrs:[222,223],now:'2026-11-06T10:00:00Z'});
 const again=queueOwnerAlerts(first,{unmappedPrs:[222,223],now:'2026-11-06T10:01:00Z'});
 assert.equal(Object.keys(first.owner_alerts).length,4);
 assert.deepEqual(first.owner_alerts,again.owner_alerts);
 assert.equal(Object.values(first.owner_alerts).some(n=>n.kind==='owner_decision'&&n.pr_number===123&&n.question.includes('Approve widening')),true);
 assert.equal(Object.values(first.owner_alerts).some(n=>n.kind==='claude_blocker'&&n.pr_number===124),true);
 assert.equal(state.owner_alerts,undefined);
});
test('only Muse receipt with exact notice hash may acknowledge owner message',()=>{
 const next=queueOwnerAlerts(state);
 const [id,entry]=Object.entries(next.owner_alerts)[0];
 const receipt={kind:'owner_notice',notice_id:id,notice_hash:entry.notice_hash,status:'submitted'};
 assert.throws(()=>acceptOwnerNoticeReceipt(next,receipt,{authenticatedCourier:'dave'}),/Only authenticated/);
 assert.throws(()=>acceptOwnerNoticeReceipt(next,{...receipt,notice_hash:'bad'},{authenticatedCourier:'muse'}),/Unapproved/);
 const done=acceptOwnerNoticeReceipt(next,receipt,{authenticatedCourier:'muse'});
 assert.equal(done.owner_alerts[id].status,'submitted');
 assert.throws(()=>acceptOwnerNoticeReceipt(done,receipt,{authenticatedCourier:'muse'}),/Unapproved/);
});
test('unconfirmed Claude problems never generate alerts',()=>{
 const state={version:1,tasks:{'9':{agent:'claude',blocker:{kind:'usage_limit',confirmed:false}}},actions:{}};
 assert.equal(Object.keys(queueOwnerAlerts(state).owner_alerts).length,0);
});

test('Muse receives one version-bound POS0a approval notice with exact existing ChatGPT chat link',()=>{
 const sha='a'.repeat(40),chat='https://chatgpt.com/g/aicafe-project/c/abc-def';
 const cfg={dispatch_rules:{
  architecture_foundation_proof_task:'POS0a',
  architecture_foundation_implementation_approval:{approved:false,merged_sha:null,owner_review_url:null},
 }};
 const initial={version:1,tasks:{POS0a:{agent:'chatgpt',pr_number:400,status:'integrated_proven',
  merge_sha:sha,conversation_ref:chat}},actions:{}};
 const first=queueOwnerAlerts(initial,{queue:cfg,now:'2026-11-07T00:00:00Z'});
 const [id,notice]=Object.entries(first.owner_alerts)[0];
 assert.equal(notice.kind,'architecture_approval');
 assert.equal(notice.delivery_owner,'muse');
 assert.equal(notice.question,'Your approval is needed. ChatGPT chat: '+chat);
 assert.equal(notice.source_sha,sha);
 assert.equal(signalFor(first,'s'.repeat(32)).pending_count,1);
 const again=queueOwnerAlerts(first,{queue:cfg,now:'2026-11-07T00:01:00Z'});
 assert.deepEqual(again.owner_alerts,first.owner_alerts);
 assert.equal(Object.keys(again.owner_alerts).length,1);
 const receipt={kind:'owner_notice',notice_id:id,notice_hash:notice.notice_hash,status:'submitted'};
 assert.throws(()=>acceptOwnerNoticeReceipt(first,receipt,{authenticatedCourier:'dave'}),/Only authenticated/);
 const submitted=acceptOwnerNoticeReceipt(first,receipt,{authenticatedCourier:'muse'});
 assert.equal(submitted.owner_alerts[id].status,'submitted');
 assert.equal(signalFor(submitted,'s'.repeat(32)).pending_count,0);
 // Audit approval and integration alone never approve its implementation contract.
 assert.equal(cfg.dispatch_rules.architecture_foundation_implementation_approval.approved,false);
});
test('architecture review notification waits for actual chat receipt and cancels after owner approval',()=>{
 const sha='b'.repeat(40),chat='https://chatgpt.com/c/a1-b2';
 const cfg={dispatch_rules:{architecture_foundation_proof_task:'POS0a',
  architecture_foundation_implementation_approval:{approved:false,merged_sha:null,owner_review_url:null}}};
 const initial={version:1,tasks:{POS0a:{agent:'chatgpt',pr_number:401,
  status:'integrated_proven',merge_sha:sha}},actions:{}};
 assert.equal(Object.keys(queueOwnerAlerts(initial,{queue:cfg}).owner_alerts).length,0);
 const withChat=queueOwnerAlerts({...initial,tasks:{POS0a:{...initial.tasks.POS0a,
  conversation_ref:chat}}},{queue:cfg});
 assert.equal(Object.keys(withChat.owner_alerts).length,1);
 const invalid={...initial,tasks:{POS0a:{...initial.tasks.POS0a,conversation_ref:'https://evil.example/c/1'}}};
 assert.equal(Object.keys(queueOwnerAlerts(invalid,{queue:cfg}).owner_alerts).length,0);
 const mergedUnproven={...initial,tasks:{POS0a:{...initial.tasks.POS0a,
  status:'merged',conversation_ref:chat}}};
 // A merged documentation audit must still request owner review until the exact signed gate is accepted.
 assert.equal(Object.keys(queueOwnerAlerts(mergedUnproven,{queue:cfg}).owner_alerts).length,1);
 const approved={...cfg,dispatch_rules:{...cfg.dispatch_rules,
  architecture_foundation_implementation_approval:{approved:true,merged_sha:sha,
   owner_review_url:'https://github.com/killbill2792/aicafe/pull/401#issuecomment-123'}}};
 const after=queueOwnerAlerts(withChat,{queue:approved});
 assert.equal(Object.values(after.owner_alerts)[0].status,'cancelled_no_longer_needed');
 assert.equal(signalFor(after,'s'.repeat(32)).pending_count,0);
 const revised=queueOwnerAlerts({...withChat,tasks:{POS0a:{...withChat.tasks.POS0a,
  merge_sha:'c'.repeat(40)}}},{queue:cfg});
 assert.equal(Object.values(revised.owner_alerts).filter(x=>x.status==='planned').length,1);
 assert.equal(Object.values(revised.owner_alerts).filter(x=>x.status==='cancelled_no_longer_needed').length,1);
});
test('existing task owner decision includes recorded ChatGPT link without inventing one',()=>{
 const chat='https://chatgpt.com/c/a1-b2';
 const pending={version:1,tasks:{'21':{agent:'chatgpt',pr_number:411,
  owner_question:'Approve exact file scope?',conversation_ref:chat}},actions:{}};
 const withLink=queueOwnerAlerts(pending);
 assert.match(Object.values(withLink.owner_alerts)[0].question,/Your approval is needed\. ChatGPT chat: https:\/\/chatgpt\.com\/c\/a1-b2/);
 const withoutLink=queueOwnerAlerts({...pending,tasks:{'21':{...pending.tasks['21'],conversation_ref:null}}});
 assert.doesNotMatch(Object.values(withoutLink.owner_alerts)[0].question,/https:\/\/chatgpt/);
});

test('owner question gains a chat link without a duplicate pending or submitted notice',()=>{
 const starting={version:1,tasks:{'31':{agent:'chatgpt',pr_number:444,
   owner_question:'Approve implementation scope?'}},actions:{}};
 const first=queueOwnerAlerts(starting);
 assert.equal(Object.values(first.owner_alerts).filter(x=>x.status==='planned').length,1);
 const withLink={...first,tasks:{'31':{...first.tasks['31'],
   conversation_ref:'https://chatgpt.com/c/aa-bb'}}};
 const enriched=queueOwnerAlerts(withLink);
 assert.equal(Object.values(enriched.owner_alerts).filter(x=>x.status==='planned').length,1);
 assert.equal(Object.values(enriched.owner_alerts).filter(x=>x.status==='cancelled_no_longer_needed').length,1);
 assert.equal(signalFor(enriched,'s'.repeat(32)).pending_count,1);
 const active=Object.entries(enriched.owner_alerts).find(([,n])=>n.status==='planned');
 assert.match(active[1].question,/ChatGPT chat: https:\/\/chatgpt\.com\/c\/aa-bb/);
 const done=acceptOwnerNoticeReceipt(enriched,{
   kind:'owner_notice',notice_id:active[0],notice_hash:active[1].notice_hash,status:'submitted'
 },{authenticatedCourier:'muse'});
 const reread=queueOwnerAlerts(done);
 assert.equal(Object.values(reread.owner_alerts).filter(x=>x.status==='planned').length,0);
 assert.equal(signalFor(reread,'s'.repeat(32)).pending_count,0);
 const originallySubmitted=acceptOwnerNoticeReceipt(first,{
   kind:'owner_notice',
   notice_id:Object.keys(first.owner_alerts)[0],
   notice_hash:Object.values(first.owner_alerts)[0].notice_hash,
   status:'submitted'
 },{authenticatedCourier:'muse'});
 const afterChat=queueOwnerAlerts({...originallySubmitted,
   tasks:{'31':{...originallySubmitted.tasks['31'],
     conversation_ref:'https://chatgpt.com/c/aa-bb'}}});
 assert.equal(Object.keys(afterChat.owner_alerts).length,1);
 assert.equal(Object.values(afterChat.owner_alerts)[0].status,'submitted');
});

test('Task 6 proven proposes Task 7 through Muse without a ledger task record',()=>{
 const queue={tasks:[
  {id:'7',title:'Routines',state:'proposed',depends_on:['6'],goal:'Prioritize work',
   scope_hint:'lib/ai/supervisor/routines/*',exclusive_files:[],
   acceptance:['Exactly once across retries'],can_start_stacked:true},
  {id:'8a',title:'Experiments',state:'proposed',depends_on:['7'],goal:'Parity',
   scope_hint:'experiment adapters',exclusive_files:[],acceptance:['No duplicates'],
   can_start_stacked:true}]};
 const base={version:1,tasks:{'6':{status:'integrated_proven'}},actions:{},owner_alerts:{}};
 const first=queueOwnerAlerts(base,{queue,now:'2026-11-11T09:00:00Z'});
 const found=Object.values(first.owner_alerts);
 assert.equal(found.length,1);
 assert.equal(found[0].kind,'next_task_proposal');
 assert.equal(found[0].task_id,'7');
 assert.equal(found[0].recipient,'owner');
 assert.equal(found[0].delivery_owner,'muse');
 assert.match(found[0].question,/Reply via Muse/);
 assert.equal(first.tasks['7'],undefined);
 assert.deepEqual(queueOwnerAlerts(first,{queue}).owner_alerts,first.owner_alerts);
 const opened={...first,tasks:{...first.tasks,'7':{status:'draft_open',
   github_state:'open',pr_number:512}}};
 const after=queueOwnerAlerts(opened,{queue});
 assert.equal(Object.values(after.owner_alerts).some(n=>
  n.kind==='next_task_proposal'&&n.task_id==='8a'),true);
});
test('proposed task scope revisions cancel unsent notices, preserve sent receipts',()=>{
 const task={id:'7',title:'Routines',state:'proposed',depends_on:['6'],
  goal:'Plan',scope_hint:'routines/*',exclusive_files:[],acceptance:['Once']};
 const state={version:1,tasks:{'6':{status:'integrated_proven'}},actions:{},owner_alerts:{}};
 const first=queueOwnerAlerts(state,{queue:{tasks:[task]}});
 const updated=queueOwnerAlerts(first,{queue:{tasks:[{...task,goal:'Revised plan'}]}});
 assert.equal(Object.values(updated.owner_alerts).filter(n=>n.status==='planned').length,1);
 assert.equal(Object.values(updated.owner_alerts).filter(n=>n.status==='cancelled_no_longer_needed').length,1);
 const [id,notice]=Object.entries(first.owner_alerts)[0];
 const acknowledged=acceptOwnerNoticeReceipt(first,{kind:'owner_notice',notice_id:id,
  notice_hash:notice.notice_hash,status:'submitted'},{authenticatedCourier:'muse'});
 const retained=queueOwnerAlerts(acknowledged,{queue:{tasks:[{...task,goal:'Revised plan'}]}});
 assert.equal(Object.values(retained.owner_alerts).filter(n=>n.status==='submitted').length,1);
 assert.equal(Object.values(retained.owner_alerts).filter(n=>n.status==='planned').length,1);
});

test('Muse proposal yes automatically becomes a one-time missing scope notice, never a coding assignment',()=>{
 const plan={tasks:['E2','7','9','10'].map(id=>({id,title:'Planned '+id,goal:'Implement '+id,
   state:'proposed',architecture_approval:null,exclusive_files:[],
   depends_on:['6'],brief:'docs/plans/brief.md#task-'+id,
   scope_hint:'lib/ai/supervisor/'+id+'/*',
   acceptance:['No unsafe effects','Correct tenant and retry behavior']}))};
 let state={version:1,tasks:{'6':{status:'integrated_proven'}},
   actions:{},owner_alerts:{}};
 state=queueOwnerAlerts(state,{queue:plan,now:'2026-11-11T09:11:00Z'});
 assert.equal(Object.values(state.owner_alerts).filter(n=>n.kind==='next_task_proposal').length,4);
 state.owner_proposal_replies={};
 for(const [key,notice] of Object.entries(state.owner_alerts)){
   state.owner_proposal_replies[notice.task_id]={
     ['yes-'+notice.task_id]:{courier:'muse',source_sha:notice.source_sha,
       notice_id:key,text:'yes',at:'2026-11-11T09:12:09Z'}
   };
 }
 const scoped=queueOwnerAlerts(state,{queue:plan,now:'2026-11-11T09:13:00Z'});
 const notices=Object.values(scoped.owner_alerts).filter(n=>n.kind==='next_task_scope');
 assert.equal(notices.length,4);
 assert.deepEqual(notices.map(n=>n.task_id).sort(),['10','7','9','E2'].sort());
 for(const n of notices){
   assert.equal(n.recipient,'owner');
   assert.equal(n.delivery_owner,'muse');
   assert.equal(n.status,'planned');
   assert.match(n.question,/ALREADY said yes/);
   assert.match(n.question,/write-file list is EMPTY/);
   assert.match(n.question,/THROUGH MUSE/);
 }
 assert.deepEqual(queueOwnerAlerts(scoped,{queue:plan}).owner_alerts,scoped.owner_alerts);
 assert.deepEqual(Object.keys(scoped.actions),[]);
 assert.equal(Object.keys(scoped.tasks).length,1);
});
test('stale or rejected Muse proposal answers never authorize a new scope',()=>{
 const task={id:'7',title:'Routines',state:'proposed',goal:'Build routines',
   scope_hint:'routines/*',exclusive_files:[],brief:'docs/plans/tasks.md#task-7',
   depends_on:[],acceptance:['One routine run']};
 const plan={tasks:[task]},base={version:1,tasks:{},actions:{},owner_alerts:{}};
 const issued=queueOwnerAlerts(base,{queue:plan});
 const [id,notice]=Object.entries(issued.owner_alerts)[0];
 issued.owner_proposal_replies={'7':{recent:{text:'no',courier:'muse',
   source_sha:notice.source_sha,notice_id:id,at:'2026-11-11T09:13:00Z'},
    early:{text:'yes',courier:'muse',source_sha:notice.source_sha,
      notice_id:id,at:'2026-11-11T09:12:00Z'}}};
 assert.equal(Object.values(queueOwnerAlerts(issued,{queue:plan}).owner_alerts)
   .filter(n=>n.kind==='next_task_scope').length,0);
 issued.owner_proposal_replies['7'].recent.text='yes';
 const changed=queueOwnerAlerts(issued,{queue:{tasks:[{...task,goal:'Revised plan'}]}});
 assert.equal(Object.values(changed.owner_alerts).filter(n=>n.kind==='next_task_scope').length,0);
 assert.equal(Object.values(changed.owner_alerts).filter(n=>n.kind==='next_task_proposal'&&n.status==='planned').length,1);
 const scope=queueOwnerAlerts(issued,{queue:plan});
 assert.equal(Object.values(scope.owner_alerts).filter(n=>n.kind==='next_task_scope'&&n.status==='planned').length,1);
 const approved={...task,state:'architecture_approved',architecture_approval:{approved:true},
   exclusive_files:['lib/ai/supervisor/routines/routines.server.ts']};
 const signed=queueOwnerAlerts(scope,{queue:{tasks:[approved]}});
 assert.equal(Object.values(signed.owner_alerts).filter(n=>n.kind==='next_task_scope'&&n.status==='planned').length,0);
});
