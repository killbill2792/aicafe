import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {settings} from './settings.mjs';
import {queueOwnerAlerts} from './alerts.mjs';
import {advanceApprovedProposals} from './proposal-stage.mjs';
import {parseScopePlanComment,selectScopePlans,queueScopePlanReviews,
 acceptScopePlanDecisions,effectiveSignedQueue} from './scope-authority.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {acceptMuseOwnerReply} from './self-heal.mjs';
import {signalFor} from './signal.mjs';
import {dispatchFrontier} from './core.mjs';
import {revalidateQueuedActions} from './authorization.mjs';
import {approvalSignature,createDelivery} from './delivery.mjs';
const queue=JSON.parse(readFileSync(new URL('../../docs/plans/universal-supervisor-queue.json',import.meta.url),'utf8'));
const taskId='7',source=queue.tasks.find(t=>t.id===taskId);
const validFiles=['lib/ai/supervisor/routines/trigger.server.ts',
 'lib/ai/supervisor/routines/trigger.test.ts'];
function fixture(){
 const start={version:1,tasks:{'5':{status:'integrated_proven'},
   '6':{status:'integrated_proven'},POS0f:{status:'integrated_proven'}},
   actions:{},owner_alerts:{}};
 const offered=queueOwnerAlerts(start,{queue});
 const [id,n]=Object.entries(offered.owner_alerts).find(([_,n])=>
    n.kind==='next_task_proposal'&&n.task_id===taskId);
 n.status='submitted';
 offered.owner_proposal_replies={
   [taskId]:{'yes-proposal':{text:'yes',notice_id:id,source_sha:n.source_sha,
     courier:'muse',at:'2026-11-11T09:10:00Z'}}};
 const next=advanceApprovedProposals(offered,queue,{now:'2026-11-11T09:11:00Z'});
 const [actionId,action]=Object.entries(next.actions).find(([_,a])=>a.task_id===taskId);
 const submitted=acceptDeliveryReceipt(next,{
   action_id:actionId,task_id:taskId,
   prompt_hash:action.delivery.prompt_hash,approval_hash:action.delivery.approval_hash,
   project_id:action.delivery.project.id,provider:'chatgpt',
   conversation_url:'https://chatgpt.com/c/verified-planner-7',
   status:'submitted',submitted_at:'2026-11-11T09:12:00Z'
 },{authenticatedCourier:'muse'});
 const data={task_id:taskId,action_id:actionId,
   proposal_source_sha:submitted.tasks[taskId].proposal_source_sha,
   edits:validFiles,uses:['lib/ai/supervisor/runs/worker.server.ts'],
   architecture:'Read existing owner commitments by tenant and occurrence key, preserve the current worker lease, store due-once state and route decisions through the current Supervisor reader with café isolation.',
   acceptance_plan:'Exercise once per occurrence, DST and revoked-owner cases with exact task tests and no duplicate effects.'};
 const comment={id:12345678,user:{login:settings.owner.login},
   author_association:'OWNER',created_at:'2026-11-11T09:15:00Z',
   html_url:'https://github.com/'+settings.repo+'/issues/411#issuecomment-12345678',
   body:'<!-- aicafe-scope-plan:v1 '+JSON.stringify(data)+' -->'};
 return {submitted,actionId,comment};
}
test('real authenticated yes -> planning receipt -> GitHub plan -> Muse exact-scope notice -> signed assignment',()=>{
 const {submitted,comment}=fixture();
 const plans=selectScopePlans([comment],queue,submitted);
 assert.deepEqual(plans[taskId].edits,validFiles);
 const offered=queueScopePlanReviews(submitted,queue,plans);
 const reviewEntry=Object.entries(offered.owner_alerts).find(([_,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId);
 assert.ok(reviewEntry);
 const [noticeId,n]=reviewEntry;
 assert.match(n.question,/Reply YES to approve THESE exact files/);
 assert.equal(signalFor(offered,'s'.repeat(64)).pending_count>0,true);
 assert.equal(offered.scope_authorizations,undefined);
 assert.equal(effectiveSignedQueue(queue,offered,plans).tasks.find(t=>t.id===taskId).state,'proposed');
 const responded=acceptMuseOwnerReply(offered,{kind:'owner_reply',
   event_id:'approve-scoped-task-7',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:16:00Z'},{authenticatedCourier:'muse'});
 const authorized=acceptScopePlanDecisions(responded,queue,plans);
 assert.equal(authorized.scope_authorizations[taskId].owner_event_id,'approve-scoped-task-7');
 const effective=effectiveSignedQueue(queue,authorized,plans);
 assert.equal(effective.tasks.find(t=>t.id===taskId).architecture_approval.approved,true);
 assert.deepEqual(effective.tasks.find(t=>t.id===taskId).edits,validFiles);
 const ready=revalidateQueuedActions(authorized,
   new Map(effective.tasks.map(t=>[t.id,t])),effective);
 assert.equal(ready.tasks[taskId].approved,true);
 assert.equal(ready.tasks[taskId].scope_plan_completed,true);
 assert.equal(ready.tasks[taskId].status,'proposed');
 const frontier=dispatchFrontier(effective,ready.tasks);
 assert.equal(frontier.some(x=>x.task_id===taskId),true);
 const task=effective.tasks.find(t=>t.id===taskId);
 const record={...ready.tasks[taskId],status:'assigned',
   branch:settings.naming.branch_prefix+taskId,base_branch:'main'};
 const coding=createDelivery({task,record,action:'begin_scoped_coding',actionId:'assign:'+taskId});
 assert.equal(coding.intent,'continue_existing_chat');
 assert.equal(coding.conversation_url,submitted.tasks[taskId].conversation_ref);
 assert.deepEqual(acceptScopePlanDecisions(authorized,queue,plans),authorized);
 assert.deepEqual(queueScopePlanReviews(offered,queue,plans),offered);
});
test('untrusted, stale, malformed and overlapping planning comments never authorize code',()=>{
 const {submitted,comment}=fixture();
 const variants=[
  {...comment,user:{login:'stranger'}},
  {...comment,author_association:'NONE'},
  {...comment,created_at:'2026-11-11T09:11:00Z'},
  {...comment,body:comment.body.replace('verified-planner','other')},
  {...comment,body:comment.body.replace('trigger.test.ts','trigger.test.*')},
  {...comment,body:comment.body.replace('lib/ai/supervisor/routines/trigger.server.ts','lib/ai/agent/history.ts')}
 ];
 assert.equal(parseScopePlanComment(variants[0],queue,submitted),null);
 assert.equal(parseScopePlanComment(variants[1],queue,submitted),null);
 assert.equal(parseScopePlanComment(variants[2],queue,submitted),null);
 assert.equal(parseScopePlanComment(variants[4],queue,submitted),null);
 const valid=selectScopePlans([comment],queue,submitted);
 const offered=queueScopePlanReviews(submitted,queue,valid);
 const [noticeId]=Object.entries(offered.owner_alerts).find(([_,n])=>n.kind==='scope_plan_review');
 for(const response of ['no','change files']){
  const replied=acceptMuseOwnerReply(offered,{kind:'owner_reply',
    event_id:'e-'+response.replace(' ','-'),text:response,
    target:{task_id:taskId,notice_id:noticeId}},{authenticatedCourier:'muse'});
  assert.equal(acceptScopePlanDecisions(replied,queue,valid).scope_authorizations,undefined);
 }
 const wrong=acceptMuseOwnerReply(offered,{kind:'owner_reply',event_id:'wrong-notice',
   text:'yes',target:{task_id:taskId,notice_id:'notice:bad'}},{authenticatedCourier:'muse'});
 assert.equal(acceptScopePlanDecisions(wrong,queue,valid).scope_authorizations,undefined);
 const changedQueue={...queue,tasks:queue.tasks.map(t=>t.id===taskId?
   {...t,goal:t.goal+' revised'}:t)};
 assert.deepEqual(selectScopePlans([comment],changedQueue,submitted),{});
});

test('exact owner-signed scope remains authorized after old issue comments leave the fetch window',()=>{
 const {submitted,comment}=fixture();
 const plans=selectScopePlans([comment],queue,submitted);
 const notices=queueScopePlanReviews(submitted,queue,plans);
 const [noticeId]=Object.entries(notices.owner_alerts).find(([_,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId);
 const replied=acceptMuseOwnerReply(notices,{kind:'owner_reply',
   event_id:'persist-yes',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:20:00Z'},{authenticatedCourier:'muse'});
 const authorized=acceptScopePlanDecisions(replied,queue,plans);
 assert.ok(authorized.scope_authorizations[taskId]);
 const fromLedger=selectScopePlans([],queue,authorized);
 assert.equal(fromLedger[taskId].plan_hash,plans[taskId].plan_hash);
 assert.equal(effectiveSignedQueue(queue,authorized,fromLedger).tasks.find(t=>
   t.id===taskId).architecture_approval.approved,true);
 const shifted=Array.from({length:99},(_,i)=>({id:i+1,user:{login:'other'},
   author_association:'NONE',body:'not a scope proposal'}));
 assert.equal(selectScopePlans([...shifted,comment],queue,submitted)[taskId].comment_id,
   comment.id);
});

test('latest authenticated Muse no revokes an exact scope before code merge',()=>{
 const {submitted,comment}=fixture();
 const plans=selectScopePlans([comment],queue,submitted);
 const noticed=queueScopePlanReviews(submitted,queue,plans);
 const [noticeId,notice]=Object.entries(noticed.owner_alerts).find(([_,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId);
 assert.match(notice.question,/Full plan: https:\/\/github.com/);
 const first=acceptMuseOwnerReply(noticed,{kind:'owner_reply',
   event_id:'yes-scoped',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:20:00Z'},{authenticatedCourier:'muse'});
 const signed=acceptScopePlanDecisions(first,queue,plans);
 const next=acceptMuseOwnerReply(signed,{kind:'owner_reply',
   event_id:'later-no-scoped',text:'no',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:22:00Z'},{authenticatedCourier:'muse'});
 const revoked=acceptScopePlanDecisions(next,queue,plans);
 assert.equal(revoked.scope_authorizations[taskId],undefined);
 assert.equal(revoked.tasks[taskId].approved,false);
 assert.equal(effectiveSignedQueue(queue,revoked,plans).tasks.find(t=>t.id===taskId).state,
   'proposed');
 assert.equal(revoked.tasks[taskId].scope_revoked_event_id,'later-no-scoped');
 const rerun=acceptScopePlanDecisions(revoked,queue,plans);
 assert.deepEqual(rerun,revoked);
});

test('an uncertain scope-planning courier attempt cannot become a signed plan',()=>{
 const {submitted,comment,actionId}=fixture();
 const attempted=structuredClone(submitted);
 attempted.actions[actionId].status='uncertain';
 assert.equal(parseScopePlanComment(comment,queue,attempted),null);
 assert.deepEqual(selectScopePlans([comment],queue,attempted),{});
});
