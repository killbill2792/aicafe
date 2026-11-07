import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectReceipts, applyReceipts } from './inbox.mjs';
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
