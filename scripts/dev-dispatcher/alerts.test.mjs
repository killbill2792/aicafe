import test from 'node:test';
import assert from 'node:assert/strict';
import {queueOwnerAlerts,acceptOwnerNoticeReceipt} from './alerts.mjs';
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
