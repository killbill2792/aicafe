import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchWakeEvent} from './self-heal.mjs';
import {queueOwnerAlerts} from './alerts.mjs';
test('CI and Integration Proof completions and Codex review/comment wake same reconciler',()=>{
 assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Integration Proof',runCompleted:true}),true); assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Pull Request Baseline',runCompleted:true}),true); assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Integration Proof',runCompleted:false}),false); assert.equal(dispatchWakeEvent({name:'issue_comment',pr:true,actor:'chatgpt-codex-connector[bot]'}),true); assert.equal(dispatchWakeEvent({name:'pull_request_review',actor:'codex[bot]'}),true);
 assert.equal(dispatchWakeEvent({name:'issue_comment',pr:true,actor:'attacker',relation:'NONE'}),false); });
test('only owner-level decisions route via Muse to owner; referee receives other notices',()=>{
 const state={tasks:{
  x:{task_id:'x',pr_number:422,approved:false,status:'blocked_needs_owner',
   sensitive_owner_block:true,owner_directive:'go_live'},
  y:{task_id:'y',agent:'claude',blocker:{confirmed:true,kind:'usage_limit',detail:'quota'}} },actions:{}}; const result=queueOwnerAlerts(state,{unmappedPrs:[999]}); const notices=Object.values(result.owner_alerts); assert.equal(notices.find(n=>n.kind==='go_live').recipient,'owner'); assert.equal(notices.find(n=>n.kind==='approval_hash').recipient,'owner'); assert.match(notices.find(n=>n.kind==='go_live').question,/pull\/422/); assert.equal(notices.find(n=>n.kind==='claude_blocker').recipient,'referee'); assert.equal(notices.find(n=>n.kind==='unmapped_pr').recipient,'referee');
 assert.ok(notices.every(n=>n.delivery_owner==='muse')); });
test('previously submitted owner approval gains a link without a duplicate notice',()=>{
 const previous={kind:'owner_decision',task_id:'x',pr_number:422,question:'Approve exact scope?',
  notice_hash:'a'.repeat(64),status:'submitted',delivery_owner:'muse',receipt:{courier:'muse'}}; const id='notice:'+previous.notice_hash; const before={tasks:{},actions:{},owner_alerts:{[id]:previous}}; const after=queueOwnerAlerts(before); assert.equal(Object.keys(after.owner_alerts).length,1); assert.equal(after.owner_alerts[id].recipient,'owner'); assert.match(after.owner_alerts[id].owner_message,/github.com\/killbill2792\/aicafe\/pull\/422/); assert.equal(after.owner_alerts[id].status,'submitted'); assert.equal(before.owner_alerts[id].recipient,undefined); });
