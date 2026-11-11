import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {settings} from './settings.mjs';
import {queueOwnerAlerts} from './alerts.mjs';
import {advanceApprovedProposals} from './proposal-stage.mjs';
import {parseScopePlanComment,selectScopePlans,queueScopePlanReviews,
 acceptScopePlanDecisions,effectiveSignedQueue,queueScopePlanRecovery} from './scope-authority.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {acceptMuseOwnerReply} from './self-heal.mjs';
import {signalFor} from './signal.mjs';
import {dispatchFrontier} from './core.mjs';
import {revalidateQueuedActions,assignmentActionKey} from './authorization.mjs';
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
 assert.match(n.question,/Reply YES to approve the linked exact scope/);
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
test('untrusted, stale and malformed planning comments never authorize code',()=>{
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
  assert.equal(Object.keys(acceptScopePlanDecisions(replied,queue,valid).scope_authorizations||{}).length,0);
 }
 const wrong=acceptMuseOwnerReply(offered,{kind:'owner_reply',event_id:'wrong-notice',
   text:'yes',target:{task_id:taskId,notice_id:'notice:bad'}},{authenticatedCourier:'muse'});
 assert.equal(Object.keys(acceptScopePlanDecisions(wrong,queue,valid).scope_authorizations||{}).length,0);
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

test('a pending Muse scope-review decision survives GitHub issue comment rollover',()=>{
 const {submitted,comment}=fixture();
 const plan=selectScopePlans([comment],queue,submitted);
 const noticed=queueScopePlanReviews(submitted,queue,plan);
 const [noticeId,n]=Object.entries(noticed.owner_alerts).find(([_,x])=>
  x.kind==='scope_plan_review'&&x.task_id===taskId);
 assert.deepEqual(n.scope_plan,plan[taskId]);
 const pageShifted=selectScopePlans([],queue,noticed);
 assert.equal(pageShifted[taskId].plan_hash,plan[taskId].plan_hash);
 const yes=acceptMuseOwnerReply(noticed,{kind:'owner_reply',
   event_id:'yes-after-issue-rollover',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:24:00Z'},{authenticatedCourier:'muse'});
 const result=acceptScopePlanDecisions(yes,queue,selectScopePlans([],queue,yes));
 assert.equal(effectiveSignedQueue(queue,result,selectScopePlans([],queue,result))
   .tasks.find(t=>t.id===taskId).architecture_approval.approved,true);
});

test('Codex P1: latest corrected signed scope survives after two stored owner notices roll off issue page',()=>{
 const {submitted,comment}=fixture();
 const old=selectScopePlans([comment],queue,submitted);
 const firstNotices=queueScopePlanReviews(submitted,queue,old);
 const [firstId]=Object.entries(firstNotices.owner_alerts).find(([_,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId);
 const firstYes=acceptMuseOwnerReply(firstNotices,{kind:'owner_reply',
   event_id:'old-yes',text:'yes',target:{task_id:taskId,notice_id:firstId},
   submitted_at:'2026-11-11T09:16:00Z'},{authenticatedCourier:'muse'});
 const oldSigned=acceptScopePlanDecisions(firstYes,queue,old);
 assert.equal(oldSigned.owner_alerts[firstId].status,'submitted');
 const revisedData=JSON.parse(comment.body.match(/aicafe-scope-plan:v1 (\{.*\}) -->/)[1]);
 revisedData.edits=['lib/ai/supervisor/routines/revised.server.ts',
   'lib/ai/supervisor/routines/revised.test.ts'];
 revisedData.architecture+=' A revised, owner-visible scope replaces the previous candidate.';
 const newComment={...comment,id:comment.id+1,
   created_at:'2026-11-11T09:18:00Z',
   html_url:'https://github.com/'+settings.repo+'/issues/411#issuecomment-'+(comment.id+1),
   body:'<!-- aicafe-scope-plan:v1 '+JSON.stringify(revisedData)+' -->'};
 const revised=selectScopePlans([newComment],queue,oldSigned);
 assert.notEqual(revised[taskId].plan_hash,old[taskId].plan_hash);
 const changedNotices=queueScopePlanReviews(oldSigned,queue,revised);
 const [newNoticeId]=Object.entries(changedNotices.owner_alerts).find(([id,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId&&id!==firstId);
 const secondYes=acceptMuseOwnerReply(changedNotices,{kind:'owner_reply',
   event_id:'corrected-yes',text:'yes',
   target:{task_id:taskId,notice_id:newNoticeId},
   submitted_at:'2026-11-11T09:20:00Z'},{authenticatedCourier:'muse'});
 const correctedSigned=acceptScopePlanDecisions(secondYes,queue,revised);
 assert.equal(correctedSigned.owner_alerts[firstId].status,'submitted');
 assert.equal(correctedSigned.owner_alerts[newNoticeId].status,'submitted');
 assert.equal(correctedSigned.scope_authorizations[taskId].plan_hash,
   revised[taskId].plan_hash);
 // Neither plan is on GitHub's last page now. Ledger insertion order is OLD,
 // NEW, so selecting the first notice would revoke the corrected authorization.
 const restored=selectScopePlans([],queue,correctedSigned);
 assert.equal(restored[taskId].plan_hash,revised[taskId].plan_hash);
 const mixed=selectScopePlans([comment],queue,correctedSigned);
 assert.equal(mixed[taskId].plan_hash,revised[taskId].plan_hash);
 const task=effectiveSignedQueue(queue,correctedSigned,restored)
   .tasks.find(t=>t.id===taskId);
 assert.equal(task.architecture_approval.approved,true);
 assert.deepEqual(task.edits,revisedData.edits);
});

test('Codex P1: yes after no re-enters exact signed transition without repeating submitted coding',()=>{
 const {submitted,comment}=fixture();
 const plans=selectScopePlans([comment],queue,submitted);
 const notices=queueScopePlanReviews(submitted,queue,plans);
 const [noticeId]=Object.entries(notices.owner_alerts).find(([_,n])=>
   n.kind==='scope_plan_review'&&n.task_id===taskId);
 const firstYes=acceptMuseOwnerReply(notices,{kind:'owner_reply',
   event_id:'initial-exact-yes',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:16:00Z'},{authenticatedCourier:'muse'});
 const initialScope=acceptScopePlanDecisions(firstYes,queue,plans);
 const signed=effectiveSignedQueue(queue,initialScope,plans);
 revalidateQueuedActions(initialScope,new Map(signed.tasks.map(t=>[t.id,t])),signed);
 assert.equal(initialScope.tasks[taskId].status,'proposed');
 assert.equal(initialScope.tasks[taskId].approved,true);
 const noReply=acceptMuseOwnerReply(initialScope,{kind:'owner_reply',
   event_id:'revocation',text:'no',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:20:00Z'},{authenticatedCourier:'muse'});
 const revoked=acceptScopePlanDecisions(noReply,queue,plans);
 const unsigned=effectiveSignedQueue(queue,revoked,plans);
 revalidateQueuedActions(revoked,new Map(unsigned.tasks.map(t=>[t.id,t])),unsigned);
 assert.equal(revoked.tasks[taskId].status,'blocked_needs_owner');
 assert.equal(revoked.tasks[taskId].approved,false);
 const renewedReply=acceptMuseOwnerReply(revoked,{kind:'owner_reply',
   event_id:'renewed-exact-yes',text:'yes',
   target:{task_id:taskId,notice_id:noticeId},
   submitted_at:'2026-11-11T09:23:00Z'},{authenticatedCourier:'muse'});
 const renewed=acceptScopePlanDecisions(renewedReply,queue,plans);
 assert.equal(renewed.tasks[taskId].status,'scope_plan_sent');
 assert.equal(renewed.tasks[taskId].planning_approved,true);
 assert.equal(renewed.tasks[taskId].approved,false);
 const effective=effectiveSignedQueue(queue,renewed,plans);
 revalidateQueuedActions(renewed,new Map(effective.tasks.map(t=>[t.id,t])),effective);
 assert.equal(renewed.tasks[taskId].status,'proposed');
 assert.equal(renewed.tasks[taskId].approved,true);
 assert.equal(renewed.tasks[taskId].scope_plan_completed,true);
 assert.equal(renewed.tasks[taskId].conversation_ref,
   submitted.tasks[taskId].conversation_ref);
 assert.equal(dispatchFrontier(effective,renewed.tasks).some(a=>a.task_id===taskId),true);
 // A submitted coding action is historical proof of a browser send: never
 // issue that same coding prompt again just because a later YES was recorded.
 const alreadySent=structuredClone(renewed);
 alreadySent.actions['assign:'+taskId]={
   type:'begin_scoped_coding',task_id:taskId,status:'submitted',
   submitted_at:'2026-11-11T09:18:00Z',receipt:{courier:'muse'}};
 assert.equal(assignmentActionKey(alreadySent,taskId,effective),null);
});


test('GitHub scope parser accepts long structured comments, 26 files and real dynamic routes',()=>{
 const {submitted,comment}=fixture();
 const match=comment.body.match(/<!-- aicafe-scope-plan:v1 (.*) -->/);
 const data=JSON.parse(match[1]);
 data.edits=Array.from({length:26},(_,i)=>
   'app/[locale]/cafe/[threadId]/component-'+i+'.tsx');
 data.architecture='Actual source, ownership and tenant data: '+('All source changes remain linked to real code. '.repeat(130));
 data.acceptance_plan='Executable checks: '+('verify current-head behavior '.repeat(70));
 const multi={...comment,body:'Published and verified.\n<!-- aicafe-scope-plan:v1\n'+
   JSON.stringify(data,null,2)+'\n-->\nAwaiting signed authorization.'};
 const parsed=parseScopePlanComment(multi,queue,submitted);
 assert.ok(parsed);
 assert.equal(parsed.edits.length,26);
 assert.match(parsed.edits[0],/\[threadId\]/);
 const notes=queueScopePlanReviews(submitted,queue,{[taskId]:parsed});
 assert.equal(Object.values(notes.owner_alerts).some(n=>n.kind==='scope_plan_review'&&
  n.task_id===taskId),true);
});

test('shared implementation scope gets an integration notice rather than a rejection',()=>{
 const {submitted,comment}=fixture();
 const data=JSON.parse(comment.body.match(/<!-- aicafe-scope-plan:v1 (.*) -->/)[1]);
 data.edits=['lib/ai/agent/loop.server.ts'];
 const draft={...comment,body:'<!-- aicafe-scope-plan:v1 '+JSON.stringify(data)+' -->'};
 const parsed=parseScopePlanComment(draft,queue,submitted);
 const overlapQueue={...queue,tasks:queue.tasks.map(t=>t.id===taskId?t:{...t,
  ...(t.id==='9'?{exclusive_files:['lib/ai/agent/loop.server.ts'],
     architecture_approval:{approved:true},state:'architecture_approved'}:{})})};
 const notice=Object.values(queueScopePlanReviews(submitted,overlapQueue,
  {[taskId]:parsed}).owner_alerts).find(n=>n.kind==='scope_plan_review');
 assert.ok(notice);
 assert.match(notice.question,/Shared edit paths/);
 assert.equal(notice.scope_conflicts,undefined);
});


test('invalid published plan gets one signed correction in the original planning chat',()=>{
 const {submitted,comment}=fixture();
 const bad={...comment,body:comment.body.replace('trigger.test.ts','trigger.test.*')};
 const out=queueScopePlanRecovery(submitted,queue,[bad],{},{
  now:'2026-11-11T09:16:00Z'});
 const corrections=Object.values(out.actions).filter(a=>a.scope_recovery);
 assert.equal(corrections.length,1);
 assert.equal(corrections[0].type,'scope_plan_update');
 assert.match(corrections[0].delivery.prompt,/unsafe or a wildcard/);
 assert.equal(corrections[0].delivery.conversation_url,
  submitted.tasks[taskId].conversation_ref);
 assert.equal(corrections[0].delivery.approval_hash,submitted.tasks[taskId].approval_hash);
 assert.deepEqual(queueScopePlanRecovery(out,queue,[bad],{},{
  now:'2026-11-11T09:18:00Z'}),out);
 const valid=selectScopePlans([comment],queue,submitted);
 const recovered=queueScopePlanRecovery(out,queue,[comment],valid,{
  now:'2026-11-11T09:19:00Z'});
 assert.equal(Object.values(recovered.actions).find(a=>a.scope_recovery).status,
  'cancelled_no_longer_needed');
});

test('missing scope is a periodic Muse progress check, never a completion deadline',()=>{
 const {submitted}=fixture();
 const tooEarly=queueScopePlanRecovery(submitted,queue,[],{},{
  now:'2026-11-11T09:20:00Z'});
 assert.equal(Object.values(tooEarly.actions).filter(a=>a.scope_recovery).length,0);
 const due=queueScopePlanRecovery(tooEarly,queue,[],{},{
  now:'2026-11-11T09:50:00Z'});
 const check=Object.values(due.actions).find(a=>a.scope_recovery);
 assert.ok(check);
 assert.match(check.delivery.prompt,/Muse must inspect whether the existing chat is still generating/);
 assert.equal(check.status,'planned');
 assert.equal(Object.values(queueScopePlanRecovery(due,queue,[],{},{
  now:'2026-11-11T10:20:00Z'}).actions).filter(a=>a.scope_recovery).length,1);
});
