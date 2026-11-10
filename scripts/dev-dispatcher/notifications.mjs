import {queueOwnerIssue} from './alerts.mjs';
export function noticeOperationalIssues(state,{snapshot=[],scan=null}={}){
 let next=state;
 const send=(kind,task_id,pr_number,identity,message,needs)=>{next=queueOwnerIssue(next,
  {kind,task_id,pr_number,identity,message,needs});};
 if(scan?.complete===false)send('receipt_scan_incomplete',null,null,scan.scan_error||'incomplete',
  'Authenticated Muse receipt scan was incomplete: '+(scan.scan_error||'unknown error'),
  'Repair the private ledger receipt reader or courier permissions');
 for(const r of scan?.rejected||[])send('receipt_rejected',null,null,r.file||r.code,
  'Muse receipt '+(r.file||'unknown')+' was rejected: '+r.code,
  'Correct receipt GitHub actor, signature or action target');
 const missed=next.schedule_health?.missed_schedule;
 if(missed)send('missed_schedule',null,null,missed.last_schedule_at,
  'Backup cron gap exceeded 15 minutes ('+missed.gap_minutes+' minutes)',
  'Check Actions scheduling; repository_dispatch and delayed self-wake must continue operating');
 for(const [id,t] of Object.entries(next.tasks||{})){
  if(t.github_state==='open' && t.ci_state!=='success' && t.ci_state!=='failure')
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
export async function reportFatalDispatcherError({ledger,wake,sha='unknown',message}){
 const receipt=await ledger.transaction(state=>queueOwnerIssue(state,{
  kind:'dispatcher_uncaught',identity:sha+':'+message,
  message:'Dispatcher could not finish reconciliation on '+sha+': '+message,
  needs:'Owner: inspect the failed Actions job and repair the GitHub or ledger request'}));
 if(receipt.committed)await wake();
 return receipt;
}
