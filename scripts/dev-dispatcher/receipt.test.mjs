import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { acceptDeliveryReceipt } from './receipt.mjs';
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
