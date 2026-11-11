import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {queueOwnerAlerts} from './alerts.mjs';
import {advanceApprovedProposals,proposalSourceHash} from './proposal-stage.mjs';
import {validateHandoff,pendingActions} from './bridge/bridge.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {revalidateQueuedActions} from './authorization.mjs';
import {dispatchFrontier} from './core.mjs';
import {approvalSignature,createDelivery} from './delivery.mjs';
import {signalFor} from './signal.mjs';

const queue=JSON.parse(readFileSync(new URL('../../docs/plans/universal-supervisor-queue.json',
 import.meta.url),'utf8'));
const proposedIds=['E2','7','9','10'];
const baseline=()=>({version:1,tasks:{
 '5':{status:'integrated_proven'},
 '6':{status:'integrated_proven'},
 POS0f:{status:'integrated_proven'}
},actions:{},owner_alerts:{}});

function withMuseYes(ids=proposedIds){
 const notices=queueOwnerAlerts(baseline(),{queue,now:'2026-11-11T09:05:25.783Z'});
 const accepted=structuredClone(notices);
 accepted.owner_proposal_replies={};
 for(const id of ids){
   const [noticeId,notice]=Object.entries(accepted.owner_alerts).find(([_,n])=>
     n.kind==='next_task_proposal'&&n.task_id===id);
   notice.status='submitted';
   notice.receipt={courier:'muse',notice_hash:notice.notice_hash,
     submitted_at:'2026-11-11T09:12:09Z'};
   accepted.owner_proposal_replies[id]={
     ['yes-'+id]:{courier:'muse',text:'yes',notice_id:noticeId,
       source_sha:notice.source_sha,at:'2026-11-11T09:12:09Z'}
   };
 }
 return accepted;
}
test('all historical and future Muse yes decisions advance to a real planning stage and action',()=>{
 const state=withMuseYes();
 const advanced=advanceApprovedProposals(state,queue,{now:'2026-11-11T09:20:00Z'});
 for(const id of proposedIds){
   const record=advanced.tasks[id];
   const actions=Object.entries(advanced.actions).filter(([_,a])=>a.task_id===id);
   assert.equal(record.status,'scope_planning',id);
   assert.equal(record.planning_approved,true,id);
   assert.equal(record.approved,false,id);
   assert.equal(actions.length,1,id);
   assert.equal(actions[0][1].type,'scope_plan',id);
   assert.equal(actions[0][1].status,'planned',id);
   assert.ok(validateHandoff({...actions[0][1],key:actions[0][0]},record),id);
   assert.match(actions[0][1].delivery.prompt,/DO NOT modify or commit any code/);
   assert.equal(advanced.actions['assign:'+id],undefined,id);
 }
 assert.equal(pendingActions(advanced).filter(a=>a.type==='scope_plan').length,4);
 assert.equal(signalFor(advanced,'s'.repeat(64)).pending_count>=4,true);
 assert.deepEqual(advanceApprovedProposals(advanced,queue),advanced);
 assert.equal(state.tasks['7'],undefined);
});
test('an authenticated planning receipt advances stage once but grants no code edits',()=>{
 const advanced=advanceApprovedProposals(withMuseYes(['7']),queue);
 const [key,a]=Object.entries(advanced.actions).find(([_,a])=>a.task_id==='7');
 const receipt={action_id:key,task_id:'7',prompt_hash:a.delivery.prompt_hash,
  approval_hash:a.delivery.approval_hash,project_id:a.delivery.project.id,
  provider:'chatgpt',conversation_url:'https://chatgpt.com/c/proposal-scope-7',
  status:'submitted'};
 assert.throws(()=>acceptDeliveryReceipt(advanced,receipt),/identity/);
 const delivered=acceptDeliveryReceipt(advanced,receipt,{authenticatedCourier:'muse'});
 assert.equal(delivered.tasks['7'].status,'scope_plan_sent');
 assert.equal(delivered.tasks['7'].scope_plan_completed,true);
 assert.equal(delivered.tasks['7'].approved,false);
 assert.equal(delivered.tasks['7'].conversation_ref,receipt.conversation_url);
 assert.equal(delivered.actions[key].status,'submitted');
 assert.throws(()=>acceptDeliveryReceipt(delivered,receipt,{authenticatedCourier:'muse'}));
 const after=revalidateQueuedActions(delivered,new Map(queue.tasks.map(t=>[t.id,t])),queue);
 assert.equal(after.tasks['7'].status,'scope_plan_sent');
 assert.equal(after.tasks['7'].approved,false);
 assert.equal(dispatchFrontier(queue,after.tasks).some(a=>a.task_id==='7'),false);
});
test('later exact signed files resume coding in the SAME planning conversation',()=>{
 const advanced=advanceApprovedProposals(withMuseYes(['7']),queue);
 const [key,a]=Object.entries(advanced.actions).find(([_,a])=>a.task_id==='7');
 const delivered=acceptDeliveryReceipt(advanced,{
  action_id:key,task_id:'7',prompt_hash:a.delivery.prompt_hash,
  project_id:a.delivery.project.id,provider:'chatgpt',
  conversation_url:'https://chatgpt.com/c/real-scope-chat',
 },{authenticatedCourier:'muse'});
 const signedTask={...queue.tasks.find(t=>t.id==='7'),state:'architecture_approved',
  architecture_approval:{approved:true},exclusive_files:[
    'lib/ai/supervisor/routines/scheduler.ts']};
 const signedQueue={...queue,tasks:queue.tasks.map(t=>t.id==='7'?signedTask:t)};
 const ready=revalidateQueuedActions(delivered,
  new Map(signedQueue.tasks.map(t=>[t.id,t])),signedQueue);
 assert.equal(ready.tasks['7'].status,'proposed');
 assert.equal(ready.tasks['7'].approved,true);
 assert.equal(ready.tasks['7'].approval_hash,approvalSignature(signedTask));
 const assignments=dispatchFrontier(signedQueue,ready.tasks);
 assert.equal(assignments.some(x=>x.task_id==='7'&&x.agent==='chatgpt'),true);
 const record={...ready.tasks['7'],status:'assigned',
  branch:'feat/aicafe-task-7',base_branch:'main',prerequisite_pr:null};
 const coding=createDelivery({task:signedTask,record,action:'begin_scoped_coding',
  actionId:'assign:7'});
 assert.equal(coding.intent,'continue_existing_chat');
 assert.equal(coding.conversation_url,'https://chatgpt.com/c/real-scope-chat');
 assert.match(coding.prompt,/Edits ONLY: lib\/ai\/supervisor\/routines\/scheduler.ts/);
 assert.equal(validateHandoff({key:'assign:7',type:'begin_scoped_coding',
   task_id:'7',status:'planned',delivery_owner:'muse',delivery:coding},record),true);
});
test('stale changed source, bad sender, wrong notice, no and duplicate yes fail closed',()=>{
 const original=withMuseYes(['7']);
 const changed={...queue,tasks:queue.tasks.map(t=>t.id==='7'?
  {...t,goal:t.goal+' changed'}:t)};
 assert.equal(advanceApprovedProposals(original,changed).actions['scope_plan:7'],undefined);
 const wrong=structuredClone(original);
 const id='7',noticeId=Object.keys(wrong.owner_alerts).find(k=>wrong.owner_alerts[k].task_id===id);
 wrong.owner_proposal_replies[id]['yes-7'].notice_id='notice:wrong';
 assert.equal(Object.keys(advanceApprovedProposals(wrong,queue).actions).length,0);
 const unauthenticated=structuredClone(original);
 unauthenticated.owner_proposal_replies[id]['yes-7'].courier='stranger';
 assert.equal(Object.keys(advanceApprovedProposals(unauthenticated,queue).actions).length,0);
 const no=structuredClone(original);
 no.owner_proposal_replies[id]['yes-7'].text='no';
 assert.equal(Object.keys(advanceApprovedProposals(no,queue).actions).length,0);
 const first=advanceApprovedProposals(original,queue);
 const changedAfter=advanceApprovedProposals(first,changed);
 assert.equal(changedAfter.tasks['7'].status,'blocked_needs_owner');
 assert.equal(Object.values(changedAfter.actions).filter(a=>a.status==='planned').length,0);
 assert.equal(first.owner_alerts[noticeId].kind,'next_task_proposal');
 assert.equal(proposalSourceHash(queue.tasks.find(t=>t.id==='7')),
   original.owner_alerts[noticeId].source_sha);
});

test('revised future proposal requires a NEW yes and resumes the verified old planning chat',()=>{
 const approved=advanceApprovedProposals(withMuseYes(['7']),queue);
 const [firstKey,first]=Object.entries(approved.actions).find(([_,a])=>a.task_id==='7');
 const receipt={action_id:firstKey,task_id:'7',prompt_hash:first.delivery.prompt_hash,
  project_id:first.delivery.project.id,provider:'chatgpt',
  conversation_url:'https://chatgpt.com/c/verified-existing-scope-chat'};
 const completed=acceptDeliveryReceipt(approved,receipt,{authenticatedCourier:'muse'});
 const revised={...queue,tasks:queue.tasks.map(t=>t.id==='7'?
  {...t,goal:t.goal+' with owner-requested refinement'}:t)};
 const withNotice=queueOwnerAlerts(completed,{queue:revised});
 const [newId,newNotice]=Object.entries(withNotice.owner_alerts).find(([id,n])=>
  n.kind==='next_task_proposal'&&n.task_id==='7'&&id!==
   completed.tasks['7'].proposal_notice_id);
 assert.ok(newId);
 assert.equal(newNotice.status,'planned');
 const held=advanceApprovedProposals(withNotice,revised);
 assert.equal(held.tasks['7'].status,'blocked_needs_owner');
 assert.equal(held.actions[firstKey].status,'submitted');
 assert.equal(Object.values(held.actions).filter(a=>a.status==='planned').length,0);
 const yes=structuredClone(held);
 yes.owner_alerts[newId].status='submitted';
 yes.owner_proposal_replies['7']['later-yes']={
  text:'yes',courier:'muse',notice_id:newId,source_sha:newNotice.source_sha,
  at:'2026-11-11T09:22:00Z'};
 const resumed=advanceApprovedProposals(yes,revised);
 const [key,action]=Object.entries(resumed.actions).find(([_,a])=>a.type==='scope_plan_update');
 assert.equal(action.type,'scope_plan_update');
 assert.equal(action.delivery.intent,'continue_existing_chat');
 assert.equal(action.delivery.conversation_url,receipt.conversation_url);
 assert.equal(validateHandoff({...action,key},resumed.tasks['7']),true);
 const sent=acceptDeliveryReceipt(resumed,{
  action_id:key,task_id:'7',prompt_hash:action.delivery.prompt_hash,
  project_id:action.delivery.project.id,provider:'chatgpt',
  conversation_url:receipt.conversation_url},
  {authenticatedCourier:'muse'});
 assert.equal(sent.tasks['7'].status,'scope_plan_sent');
 assert.equal(sent.tasks['7'].conversation_ref,receipt.conversation_url);
 assert.equal(Object.values(sent.actions).filter(a=>a.status==='submitted').length,2);
 assert.deepEqual(advanceApprovedProposals(sent,revised),sent);
});

test('stale prerequisite blocks unsigned planning and recovers the same unsubmitted action',()=>{
 const blocked=withMuseYes(['7']);
 blocked.tasks['6'].status='merged';
 assert.equal(advanceApprovedProposals(blocked,queue).tasks['7'],undefined);
 const started=advanceApprovedProposals(withMuseYes(['7']),queue);
 const [key,action]=Object.entries(started.actions).find(([_,a])=>a.task_id==='7');
 assert.equal(action.status,'planned');
 const stale=structuredClone(started);
 stale.tasks['6'].status='merged';
 const stopped=advanceApprovedProposals(stale,queue);
 assert.equal(stopped.tasks['7'].planning_eligible,false);
 assert.equal(stopped.actions[key].status,'cancelled_dependency_changed');
 assert.equal(pendingActions(stopped).filter(a=>a.task_id==='7').length,0);
 const recovery=structuredClone(stopped);
 recovery.tasks['6'].status='integrated_proven';
 const resumed=advanceApprovedProposals(recovery,queue);
 assert.equal(resumed.actions[key].status,'planned');
 assert.equal(resumed.tasks['7'].planning_eligible,true);
 assert.equal(Object.values(resumed.actions).filter(a=>a.task_id==='7').length,1);
 assert.equal(pendingActions(resumed).filter(a=>a.task_id==='7').length,1);
 assert.deepEqual(advanceApprovedProposals(resumed,queue),resumed);
});
