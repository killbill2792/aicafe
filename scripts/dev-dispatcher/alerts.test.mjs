import test from 'node:test';
import assert from 'node:assert/strict';
import {queueOwnerAlerts,acceptOwnerNoticeReceipt,resolveObsoleteLedgerOverflowNotices} from './alerts.mjs';
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

test('only pre-fix, unsubmitted, run-bound ledger overflow notices retire after trusted success',()=>{
 const at='2026-11-12T01:30:00.000Z';
 const fixed='Dispatcher killbill2792/aicafe: Unexpected GitHub ledger response Needed: Muse notify owner; inspect failed dispatcher workflow';
 const make=(identity,question,status='planned',extras={})=>({
   kind:'dispatcher_emergency',identity,notice_hash:'hash-'+identity,
   status,created_at:'2026-11-12T00:00:00Z',
   question,delivery_owner:'muse',...extras
 });
 const source={version:1,tasks:{T:{approved:true}},actions:{a:{status:'submitted'}},
   owner_alerts:{
     affected:make('run:43123864935:failure',fixed),
     unrelated:make('run:43123864936:failure','Dispatcher killbill2792/aicafe: HTTP 500 Needed: Muse notify owner'),
     generic:make('run:43123864937:failure','Dispatcher killbill2792/aicafe: AI CAFE Development Dispatcher failed or was cancelled; GitHub API may be unavailable.'),
     different:make('trusted-dispatcher:failure',fixed),
     delivered:make('run:43123864938:failure',fixed,'submitted',{receipt:{courier:'muse'}}),
     claimed:make('run:43123864939:failure',fixed,'claimed'),
     receipt:make('run:43123864940:failure',fixed,'planned',{receipt:{courier:'muse'}}),
     owner_question:{kind:'owner_decision',status:'planned',question:fixed},
     forged:make('run:bad:failure',fixed),
     not_my_repo:make('run:43123864942:failure','Dispatcher another/repo: Unexpected GitHub ledger response Needed: inspect'),
     historical:make('run:43123864943:failure',fixed,'resolved')
   }};
 const saved=JSON.stringify(source);
 const done=resolveObsoleteLedgerOverflowNotices(source,{at});
 assert.equal(JSON.stringify(source),saved,'never mutate caller or signed ledger in place');
 assert.equal(done.owner_alerts.affected.status,'resolved');
 assert.equal(done.owner_alerts.affected.resolved_at,at);
 assert.equal(done.owner_alerts.affected.resolution_reason,'verified_github_ledger_blob_reader_recovered');
 assert.equal(done.owner_alerts.affected.delivery_owner,'muse');
 assert.equal(done.owner_alerts.affected.receipt,undefined,'no fabricated Muse delivery');
 for(const [key,notice] of Object.entries(source.owner_alerts)){
   if(key!=='affected')assert.deepEqual(done.owner_alerts[key],notice,key);
 }
 assert.deepEqual(done.tasks,source.tasks);
 assert.deepEqual(done.actions,source.actions);
 assert.equal(resolveObsoleteLedgerOverflowNotices(done,{at}),done,'idempotent');
});
test('legacy overflow resolution fails closed for invalid timestamp and missing notices',()=>{
 assert.throws(()=>resolveObsoleteLedgerOverflowNotices({owner_alerts:{}},{at:'bad'}),/timestamp/);
 const state={version:1,tasks:{},actions:{}};
 assert.equal(resolveObsoleteLedgerOverflowNotices(state),state);
});
