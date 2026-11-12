import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPublicOwnerView} from './public-owner-payload.mjs';

const fixture=()=>({
 version:1,updated_at:'2026-11-12T03:05:00Z',
 schedule_health:{last_schedule_at:'2026-11-12T03:00:00Z'},
 tasks:{POS0e:{status:'integrated_proven'},'9':{approved:true}},
 actions:{
  a:{task_id:'9',delivery_owner:'muse',status:'planned',type:'continue_existing_chat',
   delivery:{prompt:'PRIVATE CODING PROMPT NO PUBLISH',approval_hash:'secret-hash'}},
  b:{task_id:'9',delivery_owner:'muse',status:'submitted',
   delivery:{prompt:'OTHER PRIVATE PROMPT'}},
  c:{task_id:'POS0e',status:'planned',delivery_owner:'other'}
 },
 owner_alerts:{
  a:{task_id:'9',status:'planned',delivery_owner:'muse',kind:'owner_decision',
   question:'PRIVATE OWNER QUESTION NO PUBLISH'},
  b:{task_id:'POS0e',status:'submitted',delivery_owner:'muse',
   owner_message:'PRIVATE MESSAGE NO PUBLISH',kind:'owner_decision'}
 },
 lifecycle_v3:{rows:{
  POS0e:{product_id:'AI_CAFE',title:'Verified integration',current_stage:'TASK_COMPLETE',
   approval:{status:'APPROVED',plan_state:'architecture_approved'},
   pr:{number:404,state:'MERGED',head_sha:'a'.repeat(40),last_updated_at:'2026-11-11T17:00:00Z'},
   coding:{branch:'feat/aicafe-task-POS0e',last_commit_sha:'a'.repeat(40),
     last_commit_at:'2026-11-11T14:00:00Z'},
   ci:{status:'GREEN',finished_at:'2026-11-11T18:00:00Z',
     last_checked_at:'2026-11-11T18:01:00Z'},
   codex:{status:'NOT_RECEIVED',request_status:'NOT_CONFIRMED',
     requested_at:null,review_at:null},
   acceptance:{status:'SUBMITTED_UNVERIFIED'},
   remaining_dependencies:[],
   merge:{eligible:false,blockers:[],merge_sha:'b'.repeat(40)},
   integration:{status:'PROVEN',proof_run_id:42787328264,
     proof_verified_at:'2026-11-11T19:00:00Z'},
   dispatch:{delivered:'YES',latest_delivery_receipt_at:'2026-11-11T13:00:00Z'},
   monitor:{next_actor:'MUSE',next_action:'UNLOCK_ELIGIBLE_WORK'}
  },
  '9':{product_id:'AI_CAFE',title:'Rolling thread memory',current_stage:'APPROVED',
   pr:{number:null,state:'MISSING'},
   coding:{last_commit_at:null},
   ci:{status:'NOT_RUN'},
   codex:{status:'NOT_RECEIVED',request_status:'NOT_ELIGIBLE'},
   acceptance:{status:'MISSING'},remaining_dependencies:['POS0e'],
   merge:{eligible:false,blockers:['pr_not_open']},
   integration:{status:'NOT_APPLICABLE'},
   dispatch:{delivered:'UNKNOWN'},
   monitor:{next_actor:'MUSE',next_action:'DELIVER_OR_RECOVER_PROMPT',
     next_reason:'no_verified_submission',
     incidents:[{question:'PRIVATE ALERT SECRET'}]}
  }
 }}
});
test('single public status snapshot has exact commit, CI and Codex timestamps and no phantom PR',()=>{
 const x=projectPublicOwnerView(fixture(),{now:'2026-11-12T03:10:00Z'});
 assert.equal(x.version,2);
 assert.equal(x.tasks.length,2);
 const e=x.tasks.find(r=>r.id==='POS0e');
 assert.equal(e.outcome,'Integrated and proven');
 assert.equal(e.codex.status,'NOT_RECEIVED');
 assert.equal(e.acceptance,'SUBMITTED_UNVERIFIED');
 assert.equal(e.coding.last_commit_at,'2026-11-11T14:00:00.000Z');
 assert.equal(e.integration.proof_run_id,42787328264);
 const nine=x.tasks.find(r=>r.id==='9');
 assert.equal(nine.pr.number,null);
 assert.equal(nine.pr.url,null);
 assert.equal(nine.muse.pending_actions,1);
 assert.deepEqual(nine.muse.action_types,['continue_existing_chat']);
 assert.equal(nine.muse.pending_owner_notices,1);
 assert.deepEqual(nine.muse.notice_kinds,['owner_decision']);
 assert.deepEqual(nine.merge.blockers,['pr_not_open']);
 assert.deepEqual(nine.dependencies,['POS0e']);
 assert.equal(x.last_schedule_at,'2026-11-12T03:00:00.000Z');
 assert.equal(x.owner_notices_pending,1);
});
test('never publishes raw private ledger, receipt, owner question, prompt or chat URL',()=>{
 const data=fixture();
 data.tasks['9'].conversation_ref='https://chatgpt.com/c/PRIVATE-CONVERSATION';
 data.actions.a.owner_reply_text='YES APPROVE ALL PRIVATE';
 data.lifecycle_v3.rows['9'].dispatch.verified_chat_url='https://chatgpt.com/c/PRIVATE';
 data.lifecycle_v3.rows['9'].monitor.incidents.push({question:'SECRET'});
 const out=JSON.stringify(projectPublicOwnerView(data));
 assert.doesNotMatch(out,/PRIVATE|SECRET|APPROVE ALL|chatgpt\.com|approval_hash|owner_reply|prompt/);
 assert.doesNotMatch(out,/"actions"\s*:/);
});
test('invalid snapshots fail closed rather than publishing arbitrary private input',()=>{
 assert.throws(()=>projectPublicOwnerView({version:1,tasks:{},actions:{}}),
   /lifecycle snapshot unavailable/i);
 assert.throws(()=>projectPublicOwnerView(fixture(),{now:'not-a-date'}),/Invalid snapshot time/);
 const f=fixture();
 f.lifecycle_v3.rows['9'].merge.blockers=['pr_not_open','owner question PRIVATE','a'.repeat(120)];
 f.lifecycle_v3.rows['9'].monitor.next_reason='PRIVATE SECRET sent to GitHub';
 const result=projectPublicOwnerView(f);
 assert.deepEqual(result.tasks.find(r=>r.id==='9').merge.blockers,['pr_not_open']);
 assert.equal(result.tasks.find(r=>r.id==='9').next.reason,null);
});
