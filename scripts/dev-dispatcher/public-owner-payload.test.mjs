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

test('proposed scope is explicitly visible and never represented as an approval',()=>{
 const state=fixture();
 state.lifecycle_v3.rows['9'].approval={status:'NOT_APPROVED',plan_state:'proposed'};
 const view=projectPublicOwnerView(state);
 const row=view.tasks.find(x=>x.id==='9');
 assert.equal(row.outcome,'Proposed — owner scope needed');
 assert.equal(row.approval,'NOT_APPROVED');
 assert.equal(row.plan_state,'proposed');
 assert.equal(row.pr.number,null);
});

test('verified owner control and Muse command outcome appear on original task row',()=>{
 const f=fixture();
 f.owner_controls={revision:2,per_task:{'9':{
   dispatch_priority:90,pause_new_dispatch:true,note:'PRIVATE OWNER NOTE SECRET'}},
   monitoring:{stall_minutes:10}};
 f.owner_instruction_events={
   earlier:{target:{task_id:'9'},status:'REQUESTED',
     reason:'recovery_queued_for_github_gates',at:'2026-11-12T03:00:00Z',
     text:'PRIVATE OLDER MESSAGE SECRET'},
   latest:{target:{task_id:'9'},status:'APPLIED',
     reason:'owner_control_saved',at:'2026-11-12T03:06:00Z',
     text:'PRIVATE LATEST OWNER MESSAGE SECRET'}};
 const x=projectPublicOwnerView(f,{now:'2026-11-12T03:10:00Z'});
 const row=x.tasks.find(t=>t.id==='9');
 assert.equal(row.owner_control.priority,90);
 assert.equal(row.owner_control.paused,true);
 assert.equal(row.owner_control.note_present,true);
 assert.equal(row.owner_control.last_command_status,'APPLIED');
 assert.equal(row.owner_control.last_command_reason,'owner_control_saved');
 assert.equal(row.owner_control.last_command_at,'2026-11-12T03:06:00.000Z');
 const publicJson=JSON.stringify(x);
 assert.doesNotMatch(publicJson,/PRIVATE|SECRET|text|owner_instruction_events/);
});
test('only validated owner event status and reason are projected',()=>{
 const f=fixture();
 f.owner_instruction_events={
   malicious:{target:{task_id:'9'},status:'SUCCESS I APPROVED ALL',
     reason:'injected_owner_text PRIVATE',text:'my secrets',
     at:'2026-11-12T03:00:00Z'}};
 const row=projectPublicOwnerView(f).tasks.find(t=>t.id==='9');
 assert.equal(row.owner_control.last_command_status,null);
 assert.equal(row.owner_control.last_command_reason,null);
 assert.equal(row.owner_control.priority,null);
 assert.equal(row.owner_control.note_present,false);
});
