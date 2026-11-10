import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchWakeEvent} from './self-heal.mjs';
import {queueOwnerAlerts} from './alerts.mjs';
test('CI and Integration Proof completions and Codex review/comment wake same reconciler',()=>{
 assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Integration Proof',runCompleted:true}),true);
 assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Pull Request Baseline',runCompleted:true}),true);
 assert.equal(dispatchWakeEvent({name:'workflow_run',runName:'AI CAFE Integration Proof',runCompleted:false}),false);
 assert.equal(dispatchWakeEvent({name:'issue_comment',pr:true,actor:'chatgpt-codex-connector[bot]'}),true);
 assert.equal(dispatchWakeEvent({name:'pull_request_review',actor:'codex[bot]'}),true);
 assert.equal(dispatchWakeEvent({name:'issue_comment',pr:true,actor:'attacker',relation:'NONE'}),false);
});
test('only owner-level decisions route via Muse to owner; referee receives other notices',()=>{
 const state={tasks:{
  x:{task_id:'x',pr_number:422,approved:false,status:'blocked_needs_owner',
   sensitive_owner_block:true,owner_directive:'go_live'},
  y:{task_id:'y',agent:'claude',blocker:{confirmed:true,kind:'usage_limit',detail:'quota'}}
 },actions:{}};
 const result=queueOwnerAlerts(state,{unmappedPrs:[999]});
 const notices=Object.values(result.owner_alerts);
 assert.equal(notices.find(n=>n.kind==='go_live').recipient,'owner');
 assert.equal(notices.find(n=>n.kind==='approval_hash').recipient,'owner');
 assert.match(notices.find(n=>n.kind==='go_live').question,/pull\/422/);
 assert.equal(notices.find(n=>n.kind==='claude_blocker').recipient,'referee');
 assert.equal(notices.find(n=>n.kind==='unmapped_pr').recipient,'referee');
 assert.ok(notices.every(n=>n.delivery_owner==='muse'));
});
