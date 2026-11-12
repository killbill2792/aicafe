import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectReceipts, inspectReceipts, applyReceipts, applyReceiptsSafely } from './inbox.mjs';
import { queueOwnerAlerts } from './alerts.mjs';
import {receiptFilename} from './receipt-identity.mjs';
const hash = s=>createHash('sha256').update(s).digest('hex');
const receipt={action_id:'assign:6',prompt_hash:hash('approved'),conversation_url:'https://chatgpt.com/c/abc-123',project_id:'aicafe',provider:'chatgpt'};
const path='dispatcher/receipts/'+hash(receipt.action_id+':'+receipt.prompt_hash)+'.json';
test('only allowed GitHub commit actors enter inbox',async()=>{
 const ledger={request:async p=>{
  if(p==='/contents/dispatcher/receipts?ref=main')return [{name:path.split('/').at(-1),path,type:'file'}];
  if(p.startsWith('/commits?'))return [{author:{login:'muse-app[bot]'}}];
  if(p.startsWith('/contents/'))return {content:Buffer.from(JSON.stringify(receipt)).toString('base64')};
 }};
 assert.equal((await collectReceipts({ledger,allowedActors:['owner']})).length,0);
 assert.equal((await collectReceipts({ledger,allowedActors:['muse-app[bot]']})).length,1);
});
test('receipt ingestion is idempotent and verifies courier role',()=>{
 const state={tasks:{'6':{approved:true,approval_hash:'a'.repeat(64)}},actions:{'assign:6':{
  task_id:'6',status:'planned',delivery_owner:'muse',delivery:{...receipt,version:1,task_id:'6',
  project:{id:'aicafe'},intent:'start_new_chat',conversation_url:null,
  prompt:'approved',approval_hash:'a'.repeat(64)}}}};
 const inbox=[{receipt,actor:'muse-app[bot]'}];
 const first=applyReceipts(state,inbox,{'muse-app[bot]':'muse'});
 assert.equal(first.actions['assign:6'].status,'submitted');
 assert.throws(()=>applyReceipts(state,[{receipt,actor:'dave-app[bot]'}],{'dave-app[bot]':'dave'}),/does not own/);
 assert.equal(applyReceipts(first,inbox,{'muse-app[bot]':'muse'}).actions['assign:6'].status,'submitted');
});

test('owner notice inbox uses the same allowlist but only Muse may acknowledge',()=>{
 const first=queueOwnerAlerts({version:1,tasks:{},actions:{}},{unmappedPrs:[91]});
 const [notice_id,notice]=Object.entries(first.owner_alerts)[0];
 const message={kind:'owner_notice',notice_id,notice_hash:notice.notice_hash,status:'submitted'};
 const muse=applyReceipts(first,[{receipt:message,actor:'muse-app[bot]'}],{'muse-app[bot]':'muse'});
 assert.equal(muse.owner_alerts[notice_id].status,'submitted');
 assert.throws(()=>applyReceipts(first,[{receipt:message,actor:'dave-app[bot]'}],{'dave-app[bot]':'dave'}),/Only authenticated Muse/);
});

test('corrected nested project receipt is collected and acknowledged without a PR',async()=>{
 const nested={action_id:receipt.action_id,prompt_hash:receipt.prompt_hash,
  provider:'chatgpt',project:{id:'aicafe',name:'AI CAFE'},
  conversation_url:receipt.conversation_url,submitted_at:'2026-11-07T05:57:00Z'};
 const filename=hash(nested.action_id+':'+nested.prompt_hash)+'.json';
 const target='dispatcher/receipts/'+filename;
 const ledger={request:async p=>{
  if(p==='/contents/dispatcher/receipts?ref=main')return [{name:filename,path:target,type:'file'}];
  if(p.startsWith('/commits?'))return [{author:{login:'approved-owner'}}];
  if(p===`/contents/${target}?ref=main`)
   return {content:Buffer.from(JSON.stringify(nested)).toString('base64')};
  throw new Error('Unexpected ledger request: '+p);
 }};
 const inbox=await collectReceipts({ledger,allowedActors:['approved-owner']});
 assert.equal(inbox.length,1);
 const state={tasks:{'6':{approved:true,approval_hash:'a'.repeat(64),status:'assigned'}},
  actions:{'assign:6':{task_id:'6',status:'planned',delivery_owner:'muse',
   delivery:{...receipt,task_id:'6',action_id:'assign:6',prompt:'approved',
    prompt_hash:hash('approved'),approval_hash:'a'.repeat(64),
    project:{id:'aicafe'},intent:'start_new_chat',conversation_url:null}}}};
 const saved=applyReceipts(state,inbox,{'approved-owner':'muse'});
 assert.equal(saved.actions['assign:6'].status,'submitted');
 assert.equal(saved.tasks['6'].conversation_ref,receipt.conversation_url);
 assert.equal(saved.tasks['6'].last_submission_at,nested.submitted_at);
 assert.equal(applyReceipts(saved,inbox,{'approved-owner':'muse'}).actions['assign:6'].status,'submitted');
 assert.equal(state.actions['assign:6'].status,'planned');
});


test('unattributed Git author reports a rejection while another valid receipt remains available',async()=>{
 const invalidId='assign:POS0e',validId=receipt.action_id;
 const fileA=hash(invalidId+':'+receipt.prompt_hash)+'.json';
 const fileB=hash(validId+':'+receipt.prompt_hash)+'.json';
 const ledger={request:async p=>{
  if(p==='/contents/dispatcher/receipts?ref=main')return [
   {type:'file',name:fileA,path:'dispatcher/receipts/'+fileA},
   {type:'file',name:fileB,path:'dispatcher/receipts/'+fileB}];
  if(p.startsWith('/commits?'))return [{author:{login:
    p.includes(fileA)?null:'approved-owner'}}];
  if(p.startsWith('/contents/'))return {
    content:Buffer.from(JSON.stringify(receipt)).toString('base64')};
  throw Error('Unexpected '+p);
 }};
 const scan=await inspectReceipts({ledger,allowedActors:['approved-owner']});
 assert.equal(scan.complete,true);
 assert.deepEqual(scan.rejected,[{file:fileA,code:'unattributed_git_actor'}]);
 assert.equal(scan.accepted.length,1);
 assert.equal(scan.accepted[0].actor,'approved-owner');
});
test('malformed authorized receipt cannot abort later valid delivery',()=>{
 const s={tasks:{'6':{approved:true,approval_hash:'a'.repeat(64)}},
 actions:{'assign:6':{task_id:'6',status:'planned',delivery_owner:'muse',
 delivery:{...receipt,task_id:'6',action_id:'assign:6',prompt:'approved',
 prompt_hash:hash('approved'),approval_hash:'a'.repeat(64),
 project:{id:'aicafe'},intent:'start_new_chat',conversation_url:null}}}};
 const good={action_id:'assign:6',prompt_hash:hash('approved'),
  conversation_url:'https://chatgpt.com/c/abc-123',project_id:'aicafe',provider:'chatgpt'};
 const invalid={...good,conversation_url:'https://evil.example/c/invalid'};
 const result=applyReceiptsSafely(s,[
  {receipt:invalid,actor:'approved-owner',file:'b'.repeat(64)+'.json'},
  {receipt:good,actor:'approved-owner',file:'a'.repeat(64)+'.json'}
 ],{'approved-owner':'muse'});
 assert.equal(result.rejected.length,1);
 assert.equal(result.rejected[0].code,'receipt_validation_failed');
 assert.equal(result.state.actions['assign:6'].status,'submitted');
 assert.equal(s.actions['assign:6'].status,'planned');
});
test('directory failure never claims a complete receipt scan',async()=>{
 const scan=await inspectReceipts({ledger:{request:async()=>{throw Error('HTTP 429');}},
  allowedActors:['approved-owner']});
 assert.equal(scan.complete,false);
 assert.equal(scan.scan_error,'receipt_directory_unavailable');
 assert.deepEqual(scan.accepted,[]);
});

test('previously reconciled Git blob receipts skip repeat attribution and content reads',async()=>{
 const name=path.split('/').at(-1),sha='f'.repeat(40);
 let reads=0;
 const ledger={request:async key=>{
  reads++;
  if(key==='/contents/dispatcher/receipts?ref=main')
    return [{type:'file',name,path,sha}];
  if(key.startsWith('/commits?'))return [{author:{login:'muse-app[bot]'}}];
  if(key==='/contents/'+path+'?ref=main')
    return {content:Buffer.from(JSON.stringify(receipt)).toString('base64')};
  throw Error(key);
 }};
 const first=await inspectReceipts({ledger,allowedActors:['muse-app[bot]']});
 assert.equal(first.accepted.length,1);
 assert.equal(first.accepted[0].sha,sha);
 assert.equal(reads,3);
 const repeat=await inspectReceipts({ledger,allowedActors:['muse-app[bot]'],
   processed:{[name]:sha}});
 assert.equal(repeat.accepted.length,0);
 assert.equal(repeat.complete,true);
 assert.equal(reads,4); // directory listing only
 const replaced=await inspectReceipts({ledger,allowedActors:['muse-app[bot]'],
   processed:{[name]:'a'.repeat(40)}});
 assert.equal(replaced.accepted.length,1);
 assert.equal(reads,7);
});
test('invalid receipt is never checkpointed merely because it has a timestamp',async()=>{
 const name=path.split('/').at(-1),sha='f'.repeat(40);
 let reads=0;
 const ledger={request:async key=>{
  reads++;
  if(key==='/contents/dispatcher/receipts?ref=main')
    return [{type:'file',name,path,sha}];
  if(key.startsWith('/commits?'))return [{author:{login:'stranger'}}];
  throw Error('Unauthorized receipt content read');
 }};
 const result=await inspectReceipts({ledger,allowedActors:['muse-app[bot]']});
 assert.deepEqual(result.rejected,[{file:name,code:'unapproved_git_actor'}]);
 assert.equal(reads,2);
});

test('verified Muse owner instruction applies exactly once through the existing inbox',()=>{
 const initial={version:1,tasks:{'9':{approved:true}},actions:{}};
 const command={kind:'owner_instruction',event_id:'owner_speech_1',
   target:{task_id:'9'},text:'Set Task 9 priority to 90',
   submitted_at:new Date().toISOString()};
 const input={receipt:command,actor:'known-muse'};
 const first=applyReceipts(initial,[input],{'known-muse':'muse'});
 assert.equal(first.owner_controls.per_task['9'].dispatch_priority,90);
 assert.equal(first.owner_instruction_events.owner_speech_1.status,'APPLIED');
 assert.equal(first.owner_controls.revision,1);
 const repeat=applyReceipts(first,[input],{'known-muse':'muse'});
 assert.deepEqual(repeat,first,'same GitHub receipt never applies twice');
 assert.equal(initial.owner_controls,undefined);
});
test('owner words in an untrusted Git commit never grant owner edit authority',()=>{
 const initial={version:1,tasks:{'9':{approved:true}},actions:{}};
 const command={kind:'owner_instruction',event_id:'owner_speech_2',
   target:{task_id:'9'},text:'Owner said set Task 9 priority to 95',
   submitted_at:new Date().toISOString()};
 const other=applyReceipts(initial,[{receipt:command,actor:'stranger'}],
   {'known-muse':'muse'});
 assert.equal(other.owner_controls,undefined);
 const ownerDirect={...command,event_id:'owner_speech_3'};
 assert.throws(()=>applyReceipts(initial,[{receipt:ownerDirect,actor:'owner-account'}],
   {'owner-account':'owner'}),/Unverified owner instruction/);
 const invalid=applyReceiptsSafely(initial,[{receipt:command,actor:'other-courier',
   file:'a'.repeat(64)+'.json'}],{'other-courier':'dave'});
 assert.equal(invalid.rejected.length,1);
 assert.equal(invalid.state.owner_controls,undefined);
});
test('unsupported Muse command records an explicit blocking outcome, never a false delivery',()=>{
 const initial={version:1,tasks:{'9':{approved:true,ci_state:'failure'}},actions:{}};
 const input={receipt:{kind:'owner_instruction',event_id:'owner_speech_4',
   target:{task_id:'9'},text:'Mark CI green for Task 9'},
   actor:'known-muse'};
 const result=applyReceipts(initial,[input],{'known-muse':'muse'});
 assert.equal(result.owner_instruction_events.owner_speech_4.status,'BLOCKED');
 assert.equal(result.owner_instruction_events.owner_speech_4.reason,'unsupported_owner_command');
 assert.equal(result.tasks['9'].ci_state,'failure');
});

test('full private Git receipt scan to owner control uses actor, filename and original words',async()=>{
 const utterance={kind:'owner_instruction',event_id:'owner_muse_full_1',
   target:{task_id:'9'},text:'Set Task 9 priority to 90',
   submitted_at:new Date().toISOString()};
 const name=receiptFilename(utterance),file='dispatcher/receipts/'+name;
 const ledger={request:async key=>{
   if(key==='/contents/dispatcher/receipts?ref=main')
     return [{name,path:file,type:'file',sha:'f'.repeat(40)}];
   if(key.startsWith('/commits?'))return [{author:{login:'authorized-muse'}}];
   if(key==='/contents/'+file+'?ref=main')
     return {content:Buffer.from(JSON.stringify(utterance)).toString('base64')};
   throw Error('Unrecognized GitHub read '+key);
 }};
 const scanned=await inspectReceipts({ledger,allowedActors:['authorized-muse']});
 assert.equal(scanned.complete,true);
 assert.equal(scanned.accepted.length,1);
 const s=applyReceipts({version:1,tasks:{'9':{approved:true}},actions:{}},
   scanned.accepted,{'authorized-muse':'muse'});
 assert.equal(s.owner_controls.per_task['9'].dispatch_priority,90);
 assert.equal(s.owner_instruction_events.owner_muse_full_1.status,'APPLIED');
 const denied=await inspectReceipts({ledger,allowedActors:['different-github-actor']});
 assert.equal(denied.accepted.length,0);
 assert.equal(denied.rejected[0].code,'unapproved_git_actor');
});

test('P1: newer pause wins over older resume irrespective of hashed receipt order',()=>{
 const now=new Date().toISOString();
 const before=new Date(Date.now()-60_000).toISOString();
 const older={kind:'owner_instruction',event_id:'resume_older',
   target:{task_id:'9'},text:'Resume Task 9',submitted_at:before};
 const newer={kind:'owner_instruction',event_id:'pause_newer',
   target:{task_id:'9'},text:'Pause Task 9',submitted_at:now};
 const initial={version:1,tasks:{'9':{approved:true}},actions:{}};
 const reversed=[{receipt:newer,actor:'known-muse'},
   {receipt:older,actor:'known-muse'}];
 const ordered=applyReceiptsSafely(initial,reversed,{'known-muse':'muse'});
 assert.equal(ordered.rejected.length,0);
 assert.equal(ordered.state.owner_controls.per_task['9'].pause_new_dispatch,true);
 assert.equal(ordered.state.owner_controls.muse_watermarks['9:pause_new_dispatch'].event_id,
   'pause_newer');
 const delayed=applyReceiptsSafely(ordered.state,[{
   receipt:{...older,event_id:'resend_old_new_id'},actor:'known-muse'
 }],{'known-muse':'muse'});
 assert.equal(delayed.state.owner_controls.per_task['9'].pause_new_dispatch,true);
 assert.equal(delayed.state.owner_instruction_events.resend_old_new_id.reason,
   'superseded_by_newer_owner_instruction');
 assert.equal(delayed.state.owner_controls.revision,2);
 const direct=applyReceipts(initial,reversed,{'known-muse':'muse'});
 assert.equal(direct.owner_controls.per_task['9'].pause_new_dispatch,true);
});
test('P1: owner priority uses per-field watermark, not global last instruction age',()=>{
 const now=new Date().toISOString();
 const earlier=new Date(Date.now()-120_000).toISOString();
 const start={version:1,tasks:{'9':{approved:true}},actions:{}};
 const inbox=[
  {receipt:{kind:'owner_instruction',event_id:'new_priority',
    target:{task_id:'9'},text:'Set Task 9 priority to 90',submitted_at:now},actor:'muse'},
  {receipt:{kind:'owner_instruction',event_id:'old_priority',
    target:{task_id:'9'},text:'Set Task 9 priority to 10',submitted_at:earlier},actor:'muse'}
 ];
 const state=applyReceipts(start,inbox,{muse:'muse'});
 assert.equal(state.owner_controls.per_task['9'].dispatch_priority,90);
 assert.equal(state.owner_instruction_events.old_priority.status,'APPLIED');
 assert.equal(state.owner_instruction_events.new_priority.status,'APPLIED');
 const replay=applyReceipts(state,[{receipt:{...inbox[1].receipt,event_id:'old_late'},
   actor:'muse'}],{muse:'muse'});
 assert.equal(replay.owner_controls.per_task['9'].dispatch_priority,90);
 assert.equal(replay.owner_instruction_events.old_late.reason,
   'superseded_by_newer_owner_instruction');
});

test('P1: equal-clock conflicting pause and resume conservatively keeps pause',()=>{
 const t=new Date().toISOString();
 for(const reverse of [false,true]){
   const pause={receipt:{kind:'owner_instruction',event_id:'aaa_pause',
     target:{task_id:'9'},text:'Pause Task 9',submitted_at:t},actor:'muse'};
   const resume={receipt:{kind:'owner_instruction',event_id:'zzz_resume',
     target:{task_id:'9'},text:'Resume Task 9',submitted_at:t},actor:'muse'};
   const s=applyReceipts({version:1,tasks:{'9':{approved:true}},actions:{}},
     reverse?[resume,pause]:[pause,resume],{muse:'muse'});
   assert.equal(s.owner_controls.per_task['9'].pause_new_dispatch,true);
   assert.equal(s.owner_instruction_events.zzz_resume.reason,
     'ambiguous_equal_time_owner_instruction');
 }
});
