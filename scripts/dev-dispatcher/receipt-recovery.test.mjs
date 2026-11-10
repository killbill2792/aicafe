import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileReceiptFeedback,receiptFileForAction,wakeReceiptFeedback} from './receipt-recovery.mjs';
const hash='a'.repeat(64);
const action={task_id:'POS0e',type:'assign',delivery_owner:'muse',status:'cancelled_stale_head',
 delivery:{prompt_hash:hash}};
const state={version:1,tasks:{POS0e:{approved:true,github_state:'open',pr_number:404,
 branch:'feat/aicafe-task-POS0e'}},actions:{'assign:POS0e':action}};
const file=receiptFileForAction('assign:POS0e',action);
test('untrusted Git author reports one private repair tied to EXISTING action identity',()=>{
 const next=reconcileReceiptFeedback(state,{complete:true,rejected:[
  {file,code:'unattributed_git_actor'},
  {file:'f'.repeat(64)+'.json',code:'unattributed_git_actor'}]},'2026-11-09T20:00:00Z');
 assert.equal(next.receipt_feedback['assign:POS0e'].code,'unattributed_git_actor');
 assert.equal(Object.keys(next.receipt_feedback).length,1);
 assert.equal(state.receipt_feedback,undefined);
 assert.equal(next.actions['assign:POS0e'].status,'cancelled_stale_head');
 assert.equal(next.tasks.POS0e.conversation_ref,undefined);
});
test('stale assignment with no chat and no receipt remains visible without resending',()=>{
 const result=reconcileReceiptFeedback(state,{complete:true,rejected:[]},'2026-11-09T20:00:00Z');
 assert.equal(result.receipt_feedback['assign:POS0e'].code,'assignment_receipt_missing');
 const again=reconcileReceiptFeedback(result,{complete:true,rejected:[]},'2026-11-09T20:05:00Z');
 assert.equal(again.receipt_feedback['assign:POS0e'].first_seen_at,'2026-11-09T20:00:00Z');
 assert.equal(again.receipt_feedback['assign:POS0e'].wake_round,0);
 const once=wakeReceiptFeedback(again,Date.parse('2026-11-09T20:16:00Z'));
 assert.equal(once.receipt_feedback['assign:POS0e'].wake_round,1);
 wakeReceiptFeedback(once,Date.parse('2026-11-09T20:22:00Z'));
 assert.equal(once.receipt_feedback['assign:POS0e'].wake_round,1);
});
test('valid authenticated original receipt resolves rejection without approving merge',()=>{
 const rejected=reconcileReceiptFeedback(state,{complete:true,rejected:[{file,code:'unattributed_git_actor'}]},'2026-11-09T20:00:00Z');
 rejected.actions['assign:POS0e'].status='submitted';
 rejected.actions['assign:POS0e'].receipt={courier:'muse'};
 rejected.tasks.POS0e.conversation_ref='https://chatgpt.com/c/test-1';
 const next=reconcileReceiptFeedback(rejected,{complete:true,rejected:[]},'2026-11-09T20:30:00Z');
 assert.equal(next.receipt_feedback['assign:POS0e'].status,'resolved');
 assert.equal(next.tasks.POS0e.acceptance_proven,undefined);
 assert.equal(next.tasks.POS0e.status,undefined);
});
test('incomplete GitHub scan retains existing hold and does not invent trust',()=>{
 const initial=reconcileReceiptFeedback(state,{complete:true,rejected:[{file,code:'unattributed_git_actor'}]},'2026-11-09T20:00:00Z');
 const next=reconcileReceiptFeedback(initial,{complete:false,rejected:[],scan_error:'receipt_directory_unavailable'},'2026-11-09T20:03:00Z');
 assert.equal(next.receipt_feedback['assign:POS0e'].code,'unattributed_git_actor');
 assert.equal(next.receipt_scan.complete,false);
 assert.equal(next.receipt_scan.error,'receipt_directory_unavailable');
});
test('merged task or unknown receipt ID cannot revive task or create repair',()=>{
 const merged=structuredClone(state);merged.tasks.POS0e.github_state='merged';
 const result=reconcileReceiptFeedback(merged,{complete:true,rejected:[{file,code:'unattributed_git_actor'}]});
 assert.equal(Object.keys(result.receipt_feedback).length,0);
 assert.equal(receiptFileForAction('other',{delivery:{prompt_hash:'not-a-hash'}}),null);
});
