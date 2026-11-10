import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {approvalSignature,approvalMatches,createDelivery} from './delivery.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {applyReceipts} from './inbox.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex'); const task={id:'6',goal:'Resume an authorized loop',acceptance:['exact lease','safe retry'],
 exclusive_files:['lib/ai/loop.ts'],architecture_approval:{approved:true,owner_direction:'note A'},
 state:'architecture_approved',brief:'docs/plans/task.md'};
test('approval signature signs goal + scope + acceptance, not annotation notes',()=>{
 const a=approvalSignature(task); assert.equal(a,approvalSignature({...task,title:'new',notes:'changed',
  architecture_approval:{...task.architecture_approval,owner_direction:'note B'}})); assert.ok(approvalMatches(task,a)); assert.notEqual(approvalSignature({...task,goal:'change effects'}),a); assert.notEqual(approvalSignature({...task,exclusive_files:['lib/ai/wrong.ts']}),a); assert.notEqual(approvalSignature({...task,acceptance:['different']}),a); });
test('ChatGPT assignment and continuation request High and signed receipts record effort',()=>{
 const record={approved:true,agent:'chatgpt',approval_hash:approvalSignature(task),base_branch:'main'}; const d=createDelivery({task,record,action:'assign',actionId:'assign:6'}); assert.equal(d.effort,'high');assert.equal(d.approval_signature_version,3); assert.match(d.prompt,/thinking effort: High/); const state={tasks:{'6':{task_id:'6',approved:true,agent:'chatgpt',approval_hash:d.approval_hash}},
  actions:{'assign:6':{task_id:'6',type:'assign',status:'planned',delivery_owner:'muse',delivery:d}}}; const receipt={action_id:'assign:6',project_id:'aicafe',provider:'chatgpt',
  conversation_url:'https://chatgpt.com/c/real-1',prompt_hash:d.prompt_hash,effort:'high'};
 const done=acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'muse'}); assert.equal(done.actions['assign:6'].receipt.effort,'high'); assert.equal(done.tasks['6'].effort,'high'); assert.equal(done.tasks['6'].conversation_url,receipt.conversation_url); assert.throws(()=>acceptDeliveryReceipt(state,{...receipt,effort:'low'},{authenticatedCourier:'muse'}),/effort/); });
test('Muse stale-chat continuation atomically replaces task and PR index while ordinary URL swaps fail',()=>{
 const old='https://chatgpt.com/c/old-1',fresh='https://chatgpt.com/c/new-2',prompt='repair';
 const d={version:1,action_id:'work:x',task_id:'x',project:{id:'aicafe'},provider:'chatgpt',
  intent:'continue_existing_chat',conversation_url:old,prompt,prompt_hash:hash(prompt),
  approval_hash:'a'.repeat(64),effort:'high'}; const state={tasks:{x:{task_id:'x',pr_number:405,github_state:'merged',approved:true,
  conversation_ref:old,approval_hash:d.approval_hash}},actions:{'work:x':{task_id:'x',
  status:'planned',delivery_owner:'muse',type:'codex_comments',delivery:d}},
  pr_chat_links:{405:{task_id:'x',conversation_url:old}}}; const receipt={action_id:'work:x',prompt_hash:d.prompt_hash,provider:'chatgpt',project_id:'aicafe',
  conversation_url:fresh,continuation_of:old,continuation_reason:'stale_chat'}; assert.throws(()=>acceptDeliveryReceipt(state,{...receipt,continuation_of:'https://chatgpt.com/c/other'},{authenticatedCourier:'muse'}));
 assert.throws(()=>acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'dave'})); const result=acceptDeliveryReceipt(state,receipt,{authenticatedCourier:'muse'}); assert.equal(result.tasks.x.conversation_ref,fresh); assert.equal(result.tasks.x.conversation_url,fresh); assert.equal(result.pr_chat_links[405].conversation_url,fresh); assert.equal(result.actions['work:x'].receipt.continuation_of,old); });
test('Muse owner_reply arrives over existing receipt path, never as unauthenticated prose',()=>{
 const state={tasks:{x:{task_id:'x',pr_number:405}},actions:{}}; const r={kind:'owner_reply',event_id:'reply-101',target:{pr_number:405},text:'hold'}; const a=applyReceipts(state,[{receipt:r,actor:'muse-bot'}],{'muse-bot':'muse'}); assert.equal(a.tasks.x.owner_answer_text,'hold'); assert.deepEqual(applyReceipts(a,[{receipt:r,actor:'muse-bot'}],{'muse-bot':'muse'}),a); assert.throws(()=>applyReceipts(state,[{receipt:r,actor:'helper'}],{'helper':'dave'})); });
test('existing authenticated private receipt directory carries Muse continuation, then one write updates chat and PR link',async()=>{
 const {inspectReceipts}=await import('./inbox.mjs'); const old='https://chatgpt.com/c/old-777',fresh='https://chatgpt.com/c/new-888';
 const prompt='repair head',h=hash(prompt),act='work:POS0b'; const receipt={action_id:act,prompt_hash:h,provider:'chatgpt',project_id:'aicafe',
  conversation_url:fresh,continuation_of:old,continuation_reason:'stale_chat',effort:'high'}; const filename=hash(act+':'+h)+'.json',file='dispatcher/receipts/'+filename;
 const ledger={request:async path=>{
  if(path==='/contents/dispatcher/receipts?ref=main')return [{type:'file',name:filename,path:file}];
  if(path.startsWith('/commits?path='))return [{author:{login:'muse-actor'}}];
  if(path==='/contents/'+file+'?ref=main')return {content:Buffer.from(JSON.stringify(receipt)).toString('base64')}; throw Error('unexpected ledger path: '+path); }}; const scanned=await inspectReceipts({ledger,allowedActors:['muse-actor']}); assert.equal(scanned.complete,true);assert.equal(scanned.accepted.length,1); const d={version:1,action_id:act,task_id:'POS0b',project:{id:'aicafe'},
  provider:'chatgpt',intent:'continue_existing_chat',conversation_url:old,
  prompt,prompt_hash:h,approval_hash:'a'.repeat(64),effort:'high'}; const state={tasks:{POS0b:{task_id:'POS0b',approved:true,agent:'chatgpt',
  approval_hash:d.approval_hash,pr_number:405,github_state:'merged',conversation_ref:old}},
  actions:{[act]:{task_id:'POS0b',type:'codex_comments',status:'planned',
    delivery_owner:'muse',delivery:d}},pr_chat_links:{405:{conversation_url:old}}}; const after=applyReceipts(state,scanned.accepted,{'muse-actor':'muse'}); assert.equal(after.tasks.POS0b.conversation_ref,fresh); assert.equal(after.pr_chat_links['405'].conversation_url,fresh); assert.equal(after.actions[act].status,'submitted'); assert.equal(state.tasks.POS0b.conversation_ref,old); const denied=await inspectReceipts({ledger,allowedActors:['other-actor']}); assert.equal(denied.accepted.length,0); });
