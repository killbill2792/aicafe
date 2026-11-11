import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {settings} from './settings.mjs';
import {receiptFilename} from './receipt-identity.mjs';
import {inspectReceipts,applyReceipts} from './inbox.mjs';
import {acceptDeliveryReceipt} from './receipt.mjs';
import {reconcileReceiptFeedback} from './receipt-recovery.mjs';
import {noticeOperationalIssues,reportFatalDispatcherError,reportMuseSignalFailure,reportMuseSignalRestored,reportProjectionFailure,reportProjectionRestored} from './notifications.mjs';
import {acceptOwnerNoticeReceipt,queueOwnerIssue} from './alerts.mjs';
import {signalFor} from './signal.mjs';
import {renderOwnerView} from './owner-view.mjs';
import {renderPrivateQueue} from './private-owner-view.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const taskId='sample-dispatch';
const approval='a'.repeat(64);
const prompt='One signed task for a project-specific dispatcher';
const actionId='assign:'+taskId+':approval-'+approval;
const branch=settings.naming.branch_prefix+taskId;
const chat='https://chatgpt.com/c/original-verified-chat';
const pr=5301;
const delivery={action_id:actionId,task_id:taskId,provider:'chatgpt',
  project:{id:settings.chatgpt.project_id,name:settings.chatgpt.project_name},
  intent:'start_new_chat',prompt,prompt_hash:hash(prompt),approval_hash:approval};
const receipt={action_id:actionId,task_id:taskId,branch,provider:'chatgpt',
  project:{id:settings.chatgpt.project_id,name:settings.chatgpt.project_name},
  prompt_hash:hash(prompt),approval_hash:approval,conversation_url:chat,
  submitted_by:'muse',submitted_at:'2026-11-11T04:35:00Z'};
const original=()=>({version:1,updated_at:'2026-11-11T04:35:00Z',
  tasks:{[taskId]:{task_id:taskId,approved:true,approval_hash:approval,
    status:'draft_open',ci_state:'success',github_state:'open',pr_number:pr,
    branch,head_sha:'a'.repeat(40),conversation_ref:null}},
  actions:{[actionId]:{type:'assign',task_id:taskId,
    status:'cancelled_stale_head',delivery_owner:'muse',delivery:structuredClone(delivery)}},
  owner_alerts:{},receipt_feedback:{},pr_chat_links:{}});
const scanFor=(rec=receipt,{actor='trusted-muse',name=receiptFilename(rec)}={})=>{
 const path=settings.ledger.receipts_path+'/'+name;
 return {request:async url=>{
  if(url==='/contents/'+settings.ledger.receipts_path+'?ref=main')
   return [{type:'file',name,path}];
  if(url.startsWith('/commits?path='))return [{author:{login:actor}}];
  if(url==='/contents/'+path+'?ref=main')
   return {content:Buffer.from(JSON.stringify(rec)).toString('base64')};
  throw Error('Unexpected GitHub request '+url);
 }};
};
const incident=state=>Object.values(state.owner_alerts||{})
  .filter(n=>n.kind==='handoff_receipt_blocked');
const restoration=state=>Object.values(state.owner_alerts||{})
  .filter(n=>n.kind==='handoff_receipt_restored');
test('real GitHub inbox actor + v1 filename recover a stale hash-bound assignment without a resend',async()=>{
 const scanned=await inspectReceipts({ledger:scanFor(),allowedActors:['trusted-muse']});
 assert.equal(scanned.complete,true); assert.equal(scanned.accepted.length,1);
 const blocked=reconcileReceiptFeedback(original(),scanned,'2026-11-11T04:36:00Z');
 assert.equal(blocked.receipt_feedback[actionId].code,'assignment_receipt_missing');
 const raised=noticeOperationalIssues(blocked,{scan:scanned});
 assert.equal(incident(raised).length,1); assert.equal(incident(raised)[0].recipient,'owner'); assert.equal(incident(raised)[0].pr_number,pr); assert.match(incident(raised)[0].owner_message,/no owner approval needed/i); assert.equal(incident(raised)[0].status,'planned');
 assert.match(renderOwnerView(raised,{repo:settings.repo}),/notification\(s\) awaiting authenticated Muse acknowledgement/); assert.match(renderPrivateQueue(raised),/Muse must still deliver every eligible/); assert.ok(signalFor(raised,'s'.repeat(32)).pending_count>=2);
 // Muse speaks to the owner, then its independently authenticated notice
 // receipt acknowledges the original message. Planned != delivered.
 const notice=incident(raised)[0];
 const noticeId='notice:'+notice.notice_hash;
 const informed=acceptOwnerNoticeReceipt(raised,{kind:'owner_notice',
  notice_id:noticeId,notice_hash:notice.notice_hash,status:'submitted'},
  {authenticatedCourier:'muse'});
 assert.equal(informed.owner_alerts[noticeId].status,'submitted');
 const recovered=applyReceipts(informed,scanned.accepted,{'trusted-muse':'muse'});
 assert.equal(recovered.actions[actionId].status,'submitted'); assert.equal(recovered.actions[actionId].recovered_original_chat_after_pr,true); assert.equal(recovered.tasks[taskId].conversation_ref,chat); assert.equal(recovered.branch_chat_links[branch].conversation_url,chat);
 assert.equal(recovered.pr_chat_links[String(pr)].conversation_url,chat);
 assert.deepEqual(applyReceipts(recovered,scanned.accepted,
   {'trusted-muse':'muse'}),recovered);
 const resolved=reconcileReceiptFeedback(recovered,scanned,'2026-11-11T04:37:00Z');
 assert.equal(resolved.receipt_feedback[actionId].status,'resolved'); assert.equal(resolved.receipt_feedback[actionId].resolution,'verified_receipt');
 const closed=noticeOperationalIssues(resolved,{scan:scanned});
 assert.equal(restoration(closed).length,1); assert.equal(restoration(closed)[0].status,'planned'); assert.match(restoration(closed)[0].question,/original Muse receipt is now authenticated/);
 assert.equal(incident(closed)[0].status,'resolved'); assert.equal(incident(closed)[0].receipt.courier,'muse'); // signed history retained
 assert.equal(Object.keys(noticeOperationalIssues(closed,{scan:scanned}).owner_alerts).length,
   Object.keys(closed.owner_alerts).length); // no alert storm
});
test('original legacy assignment still recovers; mismatched approval cannot masquerade as a new one',()=>{
 const legacy=original();
 const oldId='assign:'+taskId;
 legacy.actions={[oldId]:{...legacy.actions[actionId],
   delivery:{...delivery,action_id:oldId}}};
 const oldReceipt={...receipt,action_id:oldId};
 const recovered=applyReceipts(legacy,[{receipt:oldReceipt,actor:'trusted-muse'}],
   {'trusted-muse':'muse'});
 assert.equal(recovered.tasks[taskId].conversation_ref,chat); assert.equal(recovered.actions[oldId].status,'submitted');
 const other=original();
 other.tasks[taskId].approval_hash='b'.repeat(64);
 assert.throws(()=>acceptDeliveryReceipt(other,receipt,{authenticatedCourier:'muse'}));
});
test('wrong actor, receipt filename, project, branch, approval and revoked owner scope cannot register chat',async()=>{
 const invalidActor=await inspectReceipts({ledger:scanFor(receipt,{actor:'unapproved'}),
   allowedActors:['trusted-muse']});
 assert.equal(invalidActor.accepted.length,0); assert.equal(invalidActor.rejected[0].code,'unapproved_git_actor');
 const badName=await inspectReceipts({ledger:scanFor(receipt,{name:'f'.repeat(64)+'.json'}),
   allowedActors:['trusted-muse']});
 assert.equal(badName.accepted.length,0); assert.equal(badName.rejected[0].code,'invalid_receipt_identity');
 for(const patch of [
   {project:{id:'another-project'}},{provider:'claude'},
   {approval_hash:'b'.repeat(64)},{branch:'feat/wrong'},
   {conversation_url:'https://other.invalid/c/new'}]){
  const denied=structuredClone(original());
  assert.throws(()=>acceptDeliveryReceipt(denied,{...receipt,...patch},
    {authenticatedCourier:'muse'}));
  assert.equal(denied.tasks[taskId].conversation_ref,null);
 }
 const revoked=original();revoked.tasks[taskId].approved=false;
 assert.throws(()=>acceptDeliveryReceipt(revoked,receipt,{authenticatedCourier:'muse'}));
 const wrongAction=original();
 wrongAction.actions[actionId].delivery.approval_hash='b'.repeat(64);
 assert.throws(()=>acceptDeliveryReceipt(wrongAction,receipt,{authenticatedCourier:'muse'}));
 const noSecond=original();noSecond.tasks[taskId].conversation_ref='https://chatgpt.com/c/other';
 assert.throws(()=>acceptDeliveryReceipt(noSecond,receipt,{authenticatedCourier:'muse'}));
});
test('a stale continuation is audited only; closure cannot falsely claim verified recovery',()=>{
 const s=original();
 s.actions[actionId].type='repair_ci';
 s.actions[actionId].delivery.intent='continue_existing_chat';
 s.actions[actionId].delivery.conversation_url=chat;
 const old=applyReceipts(s,[{receipt,actor:'trusted-muse'}],{'trusted-muse':'muse'});
 assert.equal(old.actions[actionId].status,'cancelled_stale_head'); assert.equal(old.tasks[taskId].conversation_ref,null);
 const unverified=reconcileReceiptFeedback(original(),{complete:true,accepted:[],rejected:[]});
 const closed=structuredClone(unverified);
 closed.tasks[taskId].github_state='closed';
 const resolved=reconcileReceiptFeedback(closed,{complete:true,accepted:[],rejected:[]});
 assert.equal(resolved.receipt_feedback[actionId].resolution,'no_longer_active'); assert.equal(restoration(noticeOperationalIssues(resolved,{scan:{complete:true}})).length,0);
});
test('generic invalid receipt alerts resolve only after a complete clean scan',()=>{
 const file='f'.repeat(64)+'.json',bad={complete:true,rejected:[{file,code:'invalid_receipt_identity'}]};
 const raised=noticeOperationalIssues(original(),{scan:bad});
 assert.equal(Object.values(raised.owner_alerts).filter(n=>n.kind==='receipt_rejected').length,1);
 const incomplete=noticeOperationalIssues(raised,{scan:{complete:false,scan_error:'temporary'}});
 assert.equal(Object.values(incomplete.owner_alerts).find(n=>n.kind==='receipt_rejected').status,'planned');
 const clean=noticeOperationalIssues(incomplete,{scan:{complete:true,rejected:[]}});
 assert.equal(Object.values(clean.owner_alerts).find(n=>n.kind==='receipt_rejected').status,'resolved');
});
test('fatal dispatcher failure persists an owner notice and requests the existing wake',async()=>{
 let woke=0,saved;
 const ledger={transaction:async change=>{
  saved=change(original());return {committed:true,state:saved};
 }};
 await reportFatalDispatcherError({ledger,wake:async()=>{woke++;},
  sha:'a'.repeat(40),message:'GitHub ledger unavailable'});
 assert.equal(woke,1); assert.equal(Object.values(saved.owner_alerts).filter(n=>n.kind==='dispatcher_uncaught').length,1); assert.equal(Object.values(saved.owner_alerts)[0].delivery_owner,'muse');
});
test('outbound Muse signal failure wakes once, stays visible, then announces verified restoration once',async()=>{
 let state=original(),writes=0,wakes=0;
 const ledger={transaction:async fn=>{
  const updated=fn(state);
  if(updated===null)return {committed:false,state};
  state=updated;writes++;
  return {committed:true,state};
 }};
 const args={ledger,repo:settings.repo,message:'Public signal write returned 503',
  wake:async()=>{wakes++;}};
 await reportMuseSignalFailure(args);
 await reportMuseSignalFailure({...args,message:'Different transient API error'});
 assert.equal(writes,1); assert.equal(wakes,1); assert.equal(Object.values(state.owner_alerts).filter(n=>n.kind==='muse_signal_failed').length,1);
 assert.match(Object.values(state.owner_alerts)[0].question,/could not publish the Muse wake signal/i); assert.equal(Object.values(state.owner_alerts)[0].status,'planned'); assert.ok(signalFor(state,'s'.repeat(32)).pending_count>=1);
 await reportMuseSignalRestored({ledger,repo:settings.repo});
 assert.equal(Object.values(state.owner_alerts).find(n=>n.kind==='muse_signal_failed').status,'resolved'); assert.equal(Object.values(state.owner_alerts).find(n=>n.kind==='muse_signal_restored').status,'planned');
 const writesAfter= writes;
 await reportMuseSignalRestored({ledger,repo:settings.repo});
 assert.equal(writes,writesAfter); // a recovered signal cannot wake indefinitely
});
test('dashboard and private Muse queue publication failures notify once and close on recovery',async()=>{
 let state=original(),writes=0;
 const ledger={transaction:async fn=>{
  const after=fn(state);
  if(after===null)return {committed:false,state};
  state=after;writes++;
  return {committed:true,state};
 }};
 for(const [kind,identity] of [
   ['owner_dashboard_publish_failed',String(settings.owner.dashboard_issue)],
   ['private_queue_publish_failed',settings.ledger.owner_view_path]
 ]){
  await reportProjectionFailure({ledger,kind,identity});
  const afterFirst=writes;
  await reportProjectionFailure({ledger,kind,identity});
  assert.equal(writes,afterFirst,'no repeated writes for the same error'); assert.equal(Object.values(state.owner_alerts).find(n=>n.kind===kind).status,'planned');
  await reportProjectionRestored({ledger,kind,identity});
  const afterRestore=writes;
  await reportProjectionRestored({ledger,kind,identity});
  assert.equal(writes,afterRestore,'no repeated recovery notice'); assert.equal(Object.values(state.owner_alerts).find(n=>n.kind===kind).status,'resolved'); assert.equal(Object.values(state.owner_alerts).find(n=>n.kind===kind+'_restored').status,'planned');
 }
 await assert.rejects(reportProjectionFailure({
  ledger,kind:'new_unapproved_alert_kind',identity:'x'}),/Unrecognized/);
 assert.equal(Object.values(state.owner_alerts).length,4); assert.ok(signalFor(state,'s'.repeat(32)).pending_count>=2);
});
test('unacknowledged Codex Ready transition becomes one OWNER Muse notice, not a duplicate Codex request',async()=>{
 const {queueOwnerAlerts}=await import('./alerts.mjs');
 const s=original();
 const head=s.tasks[taskId].head_sha;
 Object.assign(s.tasks[taskId],{
  codex_referee_sha:head,codex_review_requested_sha:head,
  codex_reviewed_sha:null,codex_state:'pending',draft:false,
  ready_transition_at:'2026-11-11T05:07:59Z'
 });
 // Legacy referee-only notices must be promoted without creating a second
 // notice or claiming that Muse actually delivered it.
 const once=queueOwnerAlerts(s);
 const a=Object.values(once.owner_alerts).find(n=>n.kind==='codex_watchdog');
 assert.equal(a.status,'planned'); assert.equal(a.recipient,'owner'); assert.match(a.owner_message,/Codex did not acknowledge/); assert.match(a.owner_message,/automatic-review trigger settings/);
 a.recipient='referee';
 const twice=queueOwnerAlerts(once);
 const notices=Object.values(twice.owner_alerts).filter(n=>n.kind==='codex_watchdog');
 assert.equal(notices.length,1); assert.equal(notices[0].recipient,'owner'); assert.equal(notices[0].status,'planned'); assert.equal(twice.actions[actionId].status,'cancelled_stale_head');
});
test('GitHub primary quota exhaustion is an explicit terminal error, not a credential retry storm',async()=>{
 const {GitHubFacts,githubFailure}=await import('./github.mjs');
 const {GitHubLedger}=await import('./ledger.mjs');
 const make=()=>new Response(JSON.stringify({message:'API rate limit exceeded'}),{
   status:403,headers:{'x-ratelimit-remaining':'0',
    'x-ratelimit-reset':'1794376577','x-github-request-id':'quota-123'}});
 let calls=0;
 const gh=new GitHubFacts({repo:settings.repo,token:'fake-secret',fetchFn:async()=>{calls++;return make();}});
 await assert.rejects(gh.request('/pulls'),e=>e.code==='RATE_LIMIT'&&
   typeof e.reset_at==='string'&&e.message.includes('x-ratelimit-remaining=0'));
 assert.equal(calls,1);
 const ledger=new GitHubLedger({repo:settings.ledger.repo,token:'fake-secret',
  fetchFn:async()=>{calls++;return make();}});
 await assert.rejects(ledger.load(),e=>e.code==='RATE_LIMIT'&&
   typeof e.reset_at==='string');
 assert.equal(calls,2);
 const nonQuota=await githubFailure(new Response(JSON.stringify({message:'Resource not accessible by integration'}),{status:403}),'GitHub','fake-secret');
 assert.notEqual(nonQuota.code,'RATE_LIMIT');
});
test('Codex review that arrives after the single fallback closes the incident and tells Muse once',()=>{
 const state=original();
 const t=state.tasks[taskId];
 t.codex_fallback_requested_sha=t.head_sha;
 t.codex_reviewed_sha=t.head_sha;
 t.codex_state='clean';
 const incident=queueOwnerIssue(state,{kind:'codex_auto_review_missed',
   task_id:taskId,pr_number:pr,identity:t.head_sha,
   message:'Automatic Codex review was missing',needs:'GitHub requested once'});
 const closed=noticeOperationalIssues(incident,{scan:{complete:true,rejected:[]}});
 const missed=Object.values(closed.owner_alerts).filter(n=>n.kind==='codex_auto_review_missed');
 const restored=Object.values(closed.owner_alerts).filter(n=>n.kind==='codex_auto_review_received');
 assert.equal(missed.length,1); assert.equal(missed[0].status,'resolved'); assert.equal(restored.length,1); assert.equal(restored[0].delivery_owner,'muse'); assert.equal(restored[0].recipient,'owner'); assert.match(restored[0].question,/verified head/);
 const again=noticeOperationalIssues(closed,{scan:{complete:true,rejected:[]}});
 assert.deepEqual(Object.keys(again.owner_alerts),Object.keys(closed.owner_alerts));
});
test('new commits do not flood Muse with CI-in-progress alerts; obsolete notifications retire',()=>{
 const time='2026-11-11T05:40:00Z';
 const originalState=original();
 originalState.tasks[taskId].ci_state='pending';
 originalState.tasks[taskId].last_commit_at='2026-11-11T05:39:00Z';
 let fresh=noticeOperationalIssues(originalState,{now:time});
 assert.equal(Object.values(fresh.owner_alerts).filter(n=>n.kind==='ci_unavailable').length,0);
 fresh=noticeOperationalIssues(fresh,{now:'2026-11-11T06:01:00Z'});
 let ci=Object.values(fresh.owner_alerts).filter(n=>n.kind==='ci_unavailable');
 assert.equal(ci.length,1);assert.equal(ci[0].status,'planned');
 const older=structuredClone(fresh);older.tasks[taskId].head_sha='b'.repeat(40);
 older.tasks[taskId].last_commit_at='2026-11-11T06:01:00Z';
 const changed=noticeOperationalIssues(older,{now:'2026-11-11T06:02:00Z'});
 ci=Object.values(changed.owner_alerts).filter(n=>n.kind==='ci_unavailable');
 assert.equal(ci.length,1);assert.equal(ci[0].status,'cancelled_no_longer_needed');
 changed.tasks[taskId].ci_state='success';
 const green=noticeOperationalIssues(changed,{now:'2026-11-11T06:25:00Z'});
 assert.equal(Object.values(green.owner_alerts).filter(n=>n.kind==='ci_unavailable'&&n.status==='planned').length,0);
});
test('acknowledged Muse/publication incidents recover and recur without losing prior proof',async()=>{
 for(const channel of ['signal','projection']){
  let state=original(),wakes=0;
  const ledger={transaction:async fn=>{
   const next=fn(state);
   if(next===null)return {committed:false,state};
   state=next;return {committed:true,state};
  }};
  const identity=channel==='signal'?settings.repo:'dashboard';
  const kind=channel==='signal'?'muse_signal_failed':'owner_dashboard_publish_failed';
  const restoredKind=channel==='signal'?'muse_signal_restored':kind+'_restored';
  const fail=()=>channel==='signal'
   ?reportMuseSignalFailure({ledger,repo:settings.repo,message:'Cannot publish',wake:async()=>{wakes++;}})
   :reportProjectionFailure({ledger,kind,identity});
  const restore=()=>channel==='signal'
   ?reportMuseSignalRestored({ledger,repo:settings.repo})
   :reportProjectionRestored({ledger,kind,identity});
  await fail();
  const [firstId,first]=Object.entries(state.owner_alerts).find(([,n])=>n.kind===kind);
  state=acceptOwnerNoticeReceipt(state,{kind:'owner_notice',notice_id:firstId,
   notice_hash:first.notice_hash,status:'submitted'},{authenticatedCourier:'muse'});
  await restore();
  assert.equal(state.owner_alerts[firstId].status,'resolved'); assert.equal(state.owner_alerts[firstId].receipt.courier,'muse'); assert.equal(Object.values(state.owner_alerts).filter(n=>n.kind===restoredKind).length,1);
  await fail();
  const notices=Object.entries(state.owner_alerts).filter(([,n])=>n.kind===kind);
  assert.equal(notices.length,2); assert.notEqual(notices[0][0],notices[1][0]); assert.equal(notices[1][1].status,'planned'); assert.ok(signalFor(state,'s'.repeat(32)).pending_count>=1);
  await fail();
  assert.equal(Object.values(state.owner_alerts).filter(n=>n.kind===kind).length,2);
  await restore();
  assert.equal(state.owner_alerts[notices[1][0]].status,'resolved'); assert.equal(Object.values(state.owner_alerts).filter(n=>n.kind===restoredKind).length,2); assert.equal(Object.values(state.owner_alerts).find(n=>n.kind===restoredKind).status,'resolved');
  assert.equal(state.owner_alerts[firstId].receipt.courier,'muse');
  if(channel==='signal')assert.equal(wakes,2);
 }
});
