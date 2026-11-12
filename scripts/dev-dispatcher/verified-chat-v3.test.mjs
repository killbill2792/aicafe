import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedCodingConversation} from './verified-chat-v3.mjs';
const hash='a'.repeat(64),id='task';
const first='https://chatgpt.com/c/original-123',second='https://chatgpt.com/c/continued-456';
const baseline={task_id:id,type:'assign',delivery_owner:'muse',status:'submitted',
  delivery:{provider:'chatgpt',intent:'start_new_chat',conversation_url:null,
    approval_hash:hash,prompt_hash:'b'.repeat(64)},
  receipt:{courier:'muse',prompt_hash:'b'.repeat(64),conversation_url:first}};
const continuation={task_id:id,type:'pre_pr_reminder',delivery_owner:'muse',status:'submitted',
  delivery:{provider:'chatgpt',intent:'continue_existing_chat',conversation_url:first,
    approval_hash:hash,prompt_hash:'c'.repeat(64)},
  receipt:{courier:'muse',prompt_hash:'c'.repeat(64),conversation_url:second,continuation_of:first}};
const state=(...items)=>({actions:Object.fromEntries(items.map((a,i)=>['action'+i,a]))});
test('a signed Muse assignment binds the original ChatGPT destination',()=>{
 assert.equal(verifiedCodingConversation(state(baseline),id,hash,first),true);
 assert.equal(verifiedCodingConversation(state(baseline),id,hash,second),false);
});
test('verified stale-chat continuation is reachable only through a signed receipt chain',()=>{
 assert.equal(verifiedCodingConversation(state(baseline,continuation),id,hash,second),true);
 assert.equal(verifiedCodingConversation(state(baseline,{
   ...continuation,receipt:{...continuation.receipt,continuation_of:undefined}
 }),id,hash,second),false);
});
test('scope change, changed prompt or courier fails closed',()=>{
 for(const altered of [
  {...baseline,delivery:{...baseline.delivery,approval_hash:'b'.repeat(64)}},
  {...baseline,receipt:{...baseline.receipt,prompt_hash:'c'.repeat(64)}},
  {...baseline,receipt:{...baseline.receipt,courier:'unknown'}},
  {...baseline,delivery_owner:'dave'},
  {...baseline,status:'planned'}
 ]){
  assert.equal(verifiedCodingConversation(state(altered),id,hash,first),false);
 }
 assert.equal(verifiedCodingConversation(state(baseline),id,'old-scope',first),false);
});
test('a random verified followup cannot initialize a new coding chat',()=>{
 assert.equal(verifiedCodingConversation(state(continuation),id,hash,second),false);
 assert.equal(verifiedCodingConversation(state(baseline,{
  ...continuation,delivery:{...continuation.delivery,conversation_url:'https://chatgpt.com/c/forged'},
  receipt:{...continuation.receipt,continuation_of:'https://chatgpt.com/c/forged'}
 }),id,hash,second),false);
});
test('approved scope-planning chat moved during begin-scoped-coding remains recoverable',()=>{
 const planned={...continuation,type:'begin_scoped_coding'};
 assert.equal(verifiedCodingConversation(state(planned),id,hash,second),true);
});
