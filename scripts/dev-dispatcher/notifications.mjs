import {queueOwnerIssue,resolveOwnerIssueIdentity,noticeHash} from './alerts.mjs';
import {receiptFileForAction} from './receipt-recovery.mjs';
export function noticeOperationalIssues(state,{snapshot=[],scan=null,now=new Date().toISOString()}={}){
 let next=state;
 // CI-in-progress is expected after a new commit, not an owner incident.
 // Retire every unsent previous-head warning as soon as fresh GitHub facts
 // establish a replacement head, green checks, a linked chat, or a closed PR.
 const isLate=t=>Number.isFinite(Date.parse(t?.last_commit_at||''))&&
  Date.parse(now)-Date.parse(t.last_commit_at)>=20*60_000;
 for(const notice of Object.values(next.owner_alerts||{})){
  if(notice.status!=='planned'||!['ci_unavailable','ci_no_chat'].includes(notice.kind))continue;
  const t=next.tasks?.[notice.task_id];
  const same=t?.head_sha===notice.identity&&t?.pr_number===notice.pr_number;
  const stillBlocked=notice.kind==='ci_unavailable'
   ? t?.github_state==='open'&&same&&
     !['success','failure'].includes(t.ci_state)&&isLate(t)
   : t?.github_state==='open'&&same&&t.ci_state==='failure'&&!t.conversation_ref;
  if(!stillBlocked){
   notice.status='cancelled_no_longer_needed';
   notice.resolved_at=now;
  }
 }
 const send=(kind,task_id,pr_number,identity,message,needs)=>{next=queueOwnerIssue(next,
  {kind,task_id,pr_number,identity,message,needs});};
 if(scan?.complete===false)send('receipt_scan_incomplete',null,null,scan.scan_error||'incomplete',
  'Authenticated Muse receipt scan was incomplete: '+(scan.scan_error||'unknown error'),
  'Repair the private ledger receipt reader or courier permissions');
 // Current signed actions get a task/PR-specific notice instead of an
 // unhelpful duplicate generic file alert. Unknown files remain visible.
 const signedFiles=new Set(Object.entries(next.actions||{})
  .map(([id,a])=>receiptFileForAction(id,a)).filter(Boolean));
 const rejectedFiles=new Set((scan?.rejected||[]).map(r=>r.file||r.code));
 if(scan?.complete===true)for(const n of Object.values(next.owner_alerts||{})){
  if(n.kind==='receipt_rejected'&&n.status==='planned'&&
     (!rejectedFiles.has(n.identity)||signedFiles.has(n.identity)))
   next=resolveOwnerIssueIdentity(next,{kind:n.kind,task_id:n.task_id,
    pr_number:n.pr_number,identity:n.identity});
 }
 for(const r of scan?.rejected||[]){
  if(signedFiles.has(r.file))continue;
  send('receipt_rejected',null,null,r.file||r.code,
   'Muse receipt '+(r.file||'unknown')+' was rejected: '+r.code,
   'Muse: verify the same authenticated file identity; no new browser send');
 }
 // One owner-facing incident per ORIGINAL action, not per GitHub tick or PR
 // head. An accepted receipt is the only reason to announce restoration.
 for(const [actionId,feedback] of Object.entries(next.receipt_feedback||{})){
  const task=next.tasks?.[feedback.task_id];
  const pr=Number.isInteger(task?.pr_number)?task.pr_number:null;
  const subject=pr?'PR #'+pr:'Task '+feedback.task_id;
  if(feedback.status==='rejected'){
   send('handoff_receipt_blocked',feedback.task_id,pr,actionId,
    subject+' original Muse handoff is unverified ('+feedback.code+
    '). GitHub is holding further courier prompts to avoid duplicate work. No owner approval needed.',
    'Muse verifies the existing signed receipt and original chat without resending; GitHub automatically rechecks and reports recovery');
  }else if(feedback.status==='resolved'){
   next=resolveOwnerIssueIdentity(next,{kind:'handoff_receipt_blocked',
    task_id:feedback.task_id,pr_number:pr,identity:actionId});
   if(feedback.resolution==='verified_receipt'){
    send('handoff_receipt_restored',feedback.task_id,pr,actionId,
     subject+' original Muse receipt is now authenticated and the existing coding chat is registered. No duplicate browser send; work can continue automatically.',
     'No owner action is needed; GitHub continues normal CI/Codex/merge checks');
   }
  }
 }
 const missed=next.schedule_health?.missed_schedule;
 if(missed)send('missed_schedule',null,null,missed.last_schedule_at,
  'Backup cron gap exceeded 15 minutes ('+missed.gap_minutes+' minutes)',
  'Check Actions scheduling; repository_dispatch and delayed self-wake must continue operating');
 for(const [id,t] of Object.entries(next.tasks||{})){
  if(t.codex_fallback_requested_sha===t.head_sha&&
     t.codex_reviewed_sha===t.head_sha&&
     ['clean','findings'].includes(t.codex_state)){
   next=resolveOwnerIssueIdentity(next,{kind:'codex_auto_review_missed',
     task_id:id,pr_number:t.pr_number,identity:t.head_sha});
   send('codex_auto_review_received',id,t.pr_number,t.head_sha,
     'PR #'+t.pr_number+' Codex review was received on its verified head ('+t.codex_state+'). GitHub continues the existing merge and review gates.',
     'No owner action unless review findings require an owner decision');
  }
  if(t.github_state==='open' && t.ci_state!=='success' && t.ci_state!=='failure'&&
     isLate(t))
   send('ci_unavailable',id,t.pr_number,t.head_sha||'no_head',
    'PR #'+(t.pr_number||'?')+' CI results are missing or still running on '+(t.head_sha||'unknown head'),
    'Wait for all required checks or repair the missing check integration');
  if(t.github_state==='open'&&t.ci_state==='failure'&&!t.conversation_ref)
   send('ci_no_chat',id,t.pr_number,t.head_sha||'no_head',
    'PR #'+t.pr_number+' CI is red but no verified chat link can receive the repair prompt',
    'Register its ChatGPT URL with Muse');
  if(t.status==='merged'&&!t.integration_proof)
   send('proof_unavailable',id,t.pr_number,t.merge_sha||'missing_merge_sha',
    'PR #'+t.pr_number+' merged but required integration proof is not yet verified',
    'Confirm the exact merge SHA and successful Integration Proof job');
  if(t.stall_escalate)
   send('stall_owner_escalation',id,t.pr_number,t.head_sha||'missing_head',
    'PR #'+t.pr_number+' remains stuck after one Muse 20-minute nudge',
    'Owner: inspect the failed CI or assign the repair');
  if(t.protected_file_violation?.length)
   send('protected_file_blocked',id,t.pr_number,t.head_sha||'unknown_head',
    'PR #'+t.pr_number+' touches protected files: '+t.protected_file_violation.map(x=>x.file).join(', '),
    'Obtain verified protected-file owner approval without editing Lakshmi-owned paths');
  if(t.chat_recovery_blocker)
   send('chat_receipt_repair',id,t.pr_number,t.chat_recovery_blocker,
    'PR #'+t.pr_number+' chat receipt could not be verified: '+t.chat_recovery_blocker,
    'Muse: submit an authenticated current branch-to-chat receipt');
 }
 for(const [id,a] of Object.entries(next.actions||{}))
  if(['uncertain','failed','cancelled_invalid_receipt'].includes(a.status))
   send('courier_action_failed',a.task_id||null,next.tasks?.[a.task_id]?.pr_number||null,id,
    'Muse action '+id+' could not complete: '+a.status,
    'Verify a trusted browser delivery receipt before retrying');
 for(const [id,v] of Object.entries(next.owner_instruction_events||{}))
  if(!v.reviewed && !v.chat_registered)
   send('owner_instruction_received',v.target?.task_id||null,v.target?.pr_number||null,id,
    'Authenticated Muse delivered an owner instruction for '+JSON.stringify(v.target),
    'Review instruction in the private ledger; never execute free-form text automatically');
 return next;
}

// Best-effort fatal-path Muse alert: ledger CAS first, then immediate repository wake.
// Commit an incident once; a wake caused by the incident must not loop back
// into an identical ledger write and infinitely re-dispatch itself.
const onlyChange=(before,after)=>JSON.stringify(before)===JSON.stringify(after)?null:after;
export async function reportFatalDispatcherError({ledger,wake,sha='unknown',message}){
 const receipt=await ledger.transaction(state=>onlyChange(state,queueOwnerIssue(state,{
  kind:'dispatcher_uncaught',identity:sha+':'+message,
  message:'Dispatcher could not finish reconciliation on '+sha+': '+message,
  needs:'Owner: inspect the failed Actions job and repair the GitHub or ledger request'})));
 if(receipt.committed)await wake();
 return receipt;
}

// Outbound communication failures use the SAME private notice and existing
// repository_dispatch. One stable identity per repository prevents a wake storm
// while the signal is down. A later successful publish reports restoration.
export async function reportMuseSignalFailure({ledger,wake,repo,message}){
 const receipt=await ledger.transaction(state=>onlyChange(state,queueOwnerIssue(state,{
  kind:'muse_signal_failed',identity:repo,
  message:'GitHub could not publish the Muse wake signal for '+repo+': '+String(message).slice(0,180),
  needs:'GitHub fixes the outbound signal; private notices remain queued and unacknowledged'})));
 if(receipt.committed)await wake();
 return receipt;
}
export async function reportMuseSignalRestored({ledger,repo}){
 return ledger.transaction(state=>{
  const key='notice:'+noticeHash({kind:'muse_signal_failed',identity:repo});
  const failure=state.owner_alerts?.[key];
  if(!failure)return null;
  const cleared=resolveOwnerIssueIdentity(state,{kind:'muse_signal_failed',identity:repo});
  return onlyChange(state,queueOwnerIssue(cleared,{
   kind:'muse_signal_restored',identity:repo,
   message:'GitHub restored the Muse wake signal for '+repo+'; queued notices can be picked up automatically.',
   needs:'No owner action; Muse confirms actual owner-message delivery with authenticated receipts'}));
 });
}

// Dashboard and private queue are projections of the ONE ledger, not sources
// of truth. A failed write must still become a Muse-readable owner incident.
const projectionKinds=new Set(['owner_dashboard_publish_failed','private_queue_publish_failed']);
export async function reportProjectionFailure({ledger,kind,identity}){
 if(!projectionKinds.has(kind)||typeof identity!=='string'||!identity)
  throw Error('Unrecognized owner communication publication');
 return ledger.transaction(state=>onlyChange(state,queueOwnerIssue(state,{
  kind,identity,
  message:'GitHub could not publish '+(kind==='private_queue_publish_failed'
   ?'the private Muse owner queue':'the public-safe owner dashboard')+'.',
  needs:'GitHub retries on the next trusted reconciliation; the private ledger remains authoritative and the existing Muse notice stays pending'})));
}
export async function reportProjectionRestored({ledger,kind,identity}){
 if(!projectionKinds.has(kind)||typeof identity!=='string'||!identity)
  throw Error('Unrecognized owner communication publication');
 return ledger.transaction(state=>{
  const key='notice:'+noticeHash({kind,identity});
  if(!state.owner_alerts?.[key])return null;
  const cleared=resolveOwnerIssueIdentity(state,{kind,identity});
  return onlyChange(state,queueOwnerIssue(cleared,{
   kind:kind+'_restored',identity,
   message:'GitHub restored the '+(kind==='private_queue_publish_failed'
     ?'private Muse owner queue':'public-safe owner dashboard')+' publication.',
   needs:'No owner action; outstanding Muse messages still require authenticated delivery receipts'}));
 });
}
