// Dispatcher v3: one deterministic, read-only interpretation of existing signed facts.
// This is a PROJECTION of the original private ledger, never a second authority.
// No model output, inactivity guess, or self-reported coder_done proves completion.
import {overlappingPredecessorIds,mergeGate} from './core.mjs';
import {verifiedCodingConversation} from './verified-chat-v3.mjs';

export const V3_VERSION = 3;
export const TRI = Object.freeze({YES:'YES',NO:'NO',PENDING:'PENDING',FAILED:'FAILED',UNKNOWN:'UNKNOWN',STALE:'STALE'});
const SHA=/^[a-f0-9]{40}$/;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const age=(at,now)=>time(at)===null?null:Math.max(0,Math.floor((now-time(at))/60000));
const knownSha=v=>typeof v==='string'&&SHA.test(v);
const prOpen=r=>r?.github_state==='open'&&Number.isInteger(r.pr_number);
const green=r=>r?.ci_state==='success'&&knownSha(r.head_sha);
const cleaned=r=>r?.codex_state==='clean'&&r.codex_reviewed_sha===r.head_sha&&knownSha(r.head_sha);
const isMerged=r=>knownSha(r?.merge_sha)&&['merged','integrated_proven','released_proven'].includes(r?.status)
  &&r.github_state==='merged';
const proofGood=r=>isMerged(r)&&r.integration_proof?.conclusion==='success'
  &&r.integration_proof?.merged_sha===r.merge_sha
  &&r.integration_proof?.main_sha===r.merge_sha
  &&Array.isArray(r.integration_proof?.required_scenarios)
  &&r.integration_proof.required_scenarios.length>0
  &&r.integration_proof.required_scenarios.every(s=>s.result==='passed')
  &&['integrated_proven','released_proven'].includes(r.status);

export function taskLifecycle(task,record={},state={},queue={},now=new Date().toISOString()){
  const clock=time(now);
  if(clock===null)throw Error('Invalid observation clock');
  const r=record||{},id=task?.id||r.task_id;
  if(typeof id!=='string'||!id)throw Error('Task identity required');
  const tasks=state.tasks||{},actions=Object.entries(state.actions||{})
    .filter(([,a])=>a.task_id===id).map(([key,a])=>({key,...a}));
  const notices=Object.values(state.owner_alerts||{}).filter(n=>n.task_id===id);
  const awaiting=actions.filter(a=>['planned','claimed','uncertain','needs_login'].includes(a.status));
  const approved=typeof r.approved==='boolean'?r.approved:task?.architecture_approval?.approved===true;
  const head=knownSha(r.head_sha)?r.head_sha:null;
  const parents=[...new Set([...(task?.depends_on||[]),...overlappingPredecessorIds(task,queue)])];
  const remainingParents=parents.filter(p=>!isMerged(tasks[p]));
  const authorized=approved&&!r.repo_mismatch&&!r.sensitive_owner_block&&
    !(r.protected_file_violation?.length)&&r.scope_mismatch!==true;
  const ci=r.ci_state==='success'?'GREEN':r.ci_state==='failure'?'FAILED':
    r.ci_state==='pending'?'PENDING':r.ci_state==='skipped'?'SKIPPED':
    r.ci_state==='unknown'?'UNKNOWN':r.ci_state?'UNKNOWN':'NOT_RUN';
  const codex=cleaned(r)?'CLEAN':r.codex_state==='findings'&&r.codex_reviewed_sha===head?'FINDINGS':
    r.codex_in_progress_sha===head?'IN_PROGRESS':
    r.codex_reviewed_sha&&r.codex_reviewed_sha!==head?'STALE':
    r.codex_state==='pending'?'PENDING':
    r.codex_state==='unknown'?'UNKNOWN':
    !head?'NOT_ELIGIBLE':'NOT_RECEIVED';
  // Ready transitions EXPECT an automatic review. This is not proof that a
  // request was acknowledged by Codex. Only a real request/reaction is proof.
  const autoExpected=!!r.ready_transition_at&&r.codex_review_requested_sha===head;
  const reviewRequest=cleaned(r)||r.codex_in_progress_sha===head||
    r.codex_fallback_requested_sha===head?'CONFIRMED':
    autoExpected?'AUTO_EXPECTED_UNCONFIRMED':
    r.codex_review_requested_sha===head?'RECORDED_UNVERIFIED':
    head&&prOpen(r)&&r.draft===false?'NOT_CONFIRMED':'NOT_ELIGIBLE';
  const acceptance= r.acceptance_proven===true&&r.acceptance_evidence?.head_sha===head
    ?'VERIFIED':r.acceptance_evidence?'SUBMITTED_UNVERIFIED':
    task?.acceptance?.length?'MISSING':'NOT_REQUIRED';
  // Reuse the same six-condition gate as the actual GitHub merge effect.
  // Additional infrastructure/owner and branch holds can only narrow it.
  // Never advertise owner-only infrastructure work as auto-merge-ready.
  const ownerHold=!!(r.sensitive_owner_block||r.protected_file_violation?.length);
  const coreGate=mergeGate(r,parents.map(p=>tasks[p]||{status:'unknown'}));
  const blocked=[...coreGate.reasons];
  if(!approved)blocked.push('task_not_approved');
  if(!authorized&&!ownerHold&&!r.repo_mismatch)blocked.push('scope_mismatch');
  if(r.dispatcher_only)blocked.push('owner_merge_required');
  if(r.adhoc&&r.base_branch!=='main')blocked.push('adhoc_parent_base_not_main');
  if(!prOpen(r))blocked.push('pr_not_open');
  if(r.base_current===false)blocked.push('branch_base_outdated');
  if(r.review_base_current===false)blocked.push('review_base_outdated');
  const mergeBlockers=[...new Set(blocked)];
  const mergeEligible=prOpen(r)&&authorized&&coreGate.eligible&&mergeBlockers.length===0;
  const integrated=proofGood(r);
  const codeSubmitted=prOpen(r)||isMerged(r);
  const deliveryVerified=verifiedCodingConversation(state,id,r.approval_hash,r.conversation_ref);
  const suspectIdle=prOpen(r)&&r.draft===true&&ci!=='PENDING'&&
    age(r.last_commit_at||r.last_github_activity,clock)>=10&&
    r.stall_count>0&&!isMerged(r);
  const milestones=Object.freeze({
    approved:approved?'YES':'NO',
    delivered:deliveryVerified?'YES':awaiting.length?'PENDING':r.conversation_ref?'UNKNOWN':'NO',
    code_submitted:codeSubmitted?'YES':r.branch?'PENDING':'UNKNOWN',
    pr_ready:prOpen(r)?r.draft===false?'YES':'NO':'UNKNOWN',
    ci_green:ci==='GREEN'?'YES':ci==='FAILED'?'FAILED':ci==='PENDING'?'PENDING':'UNKNOWN',
    codex_clean:codex==='CLEAN'?'YES':codex==='FINDINGS'?'FAILED':codex==='STALE'?'STALE':'UNKNOWN',
    merge_ready:mergeEligible?'YES':isMerged(r)?'ALREADY_MERGED':'NO',
    merged:isMerged(r)?'YES':prOpen(r)?'NO':'UNKNOWN',
    integration_proven:integrated?'YES':isMerged(r)?'PENDING':'UNKNOWN',
    task_complete:integrated?'YES':isMerged(r)?'NO':'NO'
  });
  const stage=integrated?'TASK_COMPLETE':isMerged(r)?'INTEGRATION_PENDING':
    mergeEligible?'MERGE_READY':prOpen(r)&&r.draft===false?'VERIFYING':
    codeSubmitted?'CODE_SUBMITTED':deliveryVerified?'DELIVERED':
    approved?'APPROVED':'NOT_APPROVED';
  let action='NONE',actor='NONE',reason='verified_current';
  const planAction=(a,who,why)=>{action=a;actor=who;reason=why;};
  if(!approved)planAction('OWNER_REVIEW_PLAN','OWNER','authorization_not_verified');
  else if(!authorized)planAction('OWNER_REVIEW_MISMATCH','MUSE','approved_scope_or_privileged_hold');
  else if(integrated)planAction('UNLOCK_ELIGIBLE_WORK','MUSE','integration_proven');
  else if(isMerged(r))planAction('VERIFY_INTEGRATION','GITHUB','merged_not_integrated');
  else if(!codeSubmitted){
    if(!deliveryVerified)planAction('DELIVER_OR_RECOVER_PROMPT','MUSE','no_verified_submission');
    else if(r.github_effects?.CREATE_DRAFT_PR?.reason==='missing_pr_creator_install_token')
      planAction('ESCALATE_MISSING_GITHUB_PR_WRITER','MUSE','verified_delivery_but_pr_writer_unavailable');
    else if(r.github_effects?.CREATE_DRAFT_PR?.reason==='pr_creator_permission_denied')
      planAction('ESCALATE_GITHUB_PR_WRITE_PERMISSION','MUSE','signed_pr_write_denied');
    else planAction('VERIFY_BRANCH_AND_PR','GITHUB','no_pr_evidence');
  }else if(ci==='FAILED'){
    if(r.ci_failure_kind==='startup_failure')planAction('RETRY_VERIFIED_CI_STARTUP','GITHUB','runner_startup_failure');
    else planAction('REPAIR_CI_IN_ORIGINAL_CHAT','MUSE','required_check_failed');
  }else if(ci!=='GREEN')planAction('OBSERVE_CI','GITHUB','ci_missing_or_pending');
  else if(r.base_current===false)planAction('UPDATE_BRANCH_IF_SAFE','GITHUB','outdated_base');
  else if(r.draft!==false){
    if(remainingParents.length)planAction('WAIT_FOR_PARENT_MERGE','GITHUB','coding_parallel_review_ordered');
    else planAction('MARK_PR_READY','GITHUB','green_authorized_draft');
  }else if(codex==='FINDINGS')planAction('FIX_CODEX_FINDINGS_IN_CHAT','MUSE','authenticated_review_findings');
  else if(codex!=='CLEAN')planAction('VERIFY_OR_REQUEST_CODEX','GITHUB','review_not_clean_or_unverified');
  else if(r.threads_resolved!==true)planAction('RESOLVE_REVIEW_THREADS','MUSE','review_threads_open');
  else if(r.dispatcher_only)planAction('OWNER_MERGE_REQUIRED','OWNER','privileged_dispatcher_pr');
  else if(r.review_base_current===false)planAction('VERIFY_REVIEW_ON_CURRENT_BASE','GITHUB','review_base_outdated');
  else if(remainingParents.length)planAction('WAIT_FOR_PARENT_MERGE','GITHUB','dependency_merge_order');
  else if(r.mergeable!==true)planAction(r.mergeable===false?'REPAIR_MERGE_CONFLICT':'VERIFY_MERGEABILITY',
    r.mergeable===false?'MUSE':'GITHUB','mergeability_not_verified');
  else if(mergeEligible)planAction('MERGE_IF_AUTHORIZED','GITHUB','all_six_merge_gates_green');
  if(suspectIdle&&['VERIFY_BRANCH_AND_PR','OBSERVE_CI'].includes(action))
    planAction('INVESTIGATE_SUSPECTED_STALL','MUSE','no_recent_observable_progress');
  return {
    version:V3_VERSION,task_id:id,product_id:task?.product_id||queue?.product_id||'AI_CAFE',
    title:task?.title||r.title||id,plan_revision:task?.approval_hash||r.approval_hash||null,
    dependencies:parents,remaining_dependencies:remainingParents,
    current_stage:stage,milestones,
    approval:{status:approved?'APPROVED':r.approved===false?'NOT_APPROVED':'UNKNOWN',
      signed_scope_hash:r.approval_hash||task?.approval_hash||null,
      plan_state:task?.state||null,approved_at:r.approved_at||task?.architecture_approval?.approved_at||null,
      authorized_files:task?.edits||task?.exclusive_files||[],
      acceptance_requirements:task?.acceptance||[],owner_hold:ownerHold,
      scope_mismatch:r.scope_mismatch===true||r.repo_mismatch===true,
      priority:state.owner_controls?.per_task?.[id]?.dispatch_priority??null,
      pause_new_dispatch:state.owner_controls?.per_task?.[id]?.pause_new_dispatch===true},
    dispatch:{eligible:approved,delivered:milestones.delivered,last_prompt_at:r.last_submission_at||null,
      pending_actions:awaiting.map(a=>({id:a.key,type:a.type,status:a.status,created_at:a.created_at||null})),
      verified_chat_url:deliveryVerified?r.conversation_ref:null,
      latest_delivery_receipt_at:deliveryVerified?(r.last_submission_at||null):null,
      last_delivery_attempt_at:r.last_submission_at||null,
      last_delivery_error:r.delivery_error||null,
      action_count:actions.length,pending_action_count:awaiting.length},
    coding:{branch:r.branch||null,last_commit_sha:head,last_commit_at:r.last_commit_at||null,
      minutes_since_commit:age(r.last_commit_at,clock),last_pr_activity_at:r.last_github_activity||null,
      suspected_stall:suspectIdle,chat_completion_authoritative:false,
      last_commit_actor:r.last_commit_actor||null,
      head_first_seen_at:r.head_first_seen_at||null,
      last_prompt_head_sha:r.last_prompt_head_sha||null,
      suspected_stall_since:r.stall_seen||null},
    pr:{number:r.pr_number||null,url:r.pr_number?'https://github.com/'+(queue.repo||'killbill2792/aicafe')+'/pull/'+r.pr_number:null,
      state:isMerged(r)?'MERGED':prOpen(r)?r.draft?'DRAFT':'OPEN':'MISSING',
      base_branch:r.base_branch||null,base_sha:r.base_sha||null,head_sha:head,
      mergeable:r.mergeable===true?'YES':r.mergeable===false?'NO':'UNKNOWN',
      draft_ready_at:r.ready_transition_at||null,
      created_at:r.pr_created_at||r.pr_created_observed_at||null,
      last_updated_at:r.pr_updated_at||r.last_github_activity||null,
      ready_requested_at:r.ready_attempted_at||null,
      ready_transition_error:r.ready_error||null},
    ci:{status:ci,head_sha:head,failed_check:r.ci_failure_job||null,
      failure_kind:r.ci_failure_kind||null,run_url:r.ci_failure_url||null,
      missing_checks:r.ci_missing_names||[],retry:r.transient_ci_retry||null,
      required_check_names:queue?.required_checks?.names||null,
      started_at:r.ci_started_at||null,finished_at:r.ci_finished_at||null,
      last_checked_at:r.ci_last_observed_at||null,
      failure_reason:r.ci_failure_fix||r.repo_marker_failure||null},
    codex:{status:codex,request_status:reviewRequest,reviewed_sha:r.codex_reviewed_sha||null,
      requested_sha:r.codex_review_requested_sha||null,review_at:r.codex_review_at||null,
      open_threads:Array.isArray(r.unresolved_codex_comments)?r.unresolved_codex_comments.length:null,
      watchdog:r.codex_watchdog||null,
      requested_at:r.codex_requested_at||null,
      started_at:r.codex_started_at||null,
      request_method:r.codex_request_method||null,
      in_progress_sha:r.codex_in_progress_sha||null,
      fallback_requested_sha:r.codex_fallback_requested_sha||null,
      request_failure:r.codex_request_error||null,
      unresolved_threads:r.unresolved_codex_comments||[]},
    acceptance:{status:acceptance,required_count:task?.acceptance?.length||0,
      evidence_head_sha:r.acceptance_evidence?.head_sha||null,
      evidence_source:r.acceptance_evidence?.source||null,
      evidence_run_url:r.acceptance_evidence?.run_url||null,
      evidence_rows:r.acceptance_evidence?.acceptance||null,
      verified_at:r.acceptance_verified_at||null,
      reported_coder_done_ignored:true},
    dependency_state:{parents:parents,remaining_parents:remainingParents,
      expected_base:r.base_branch||null,actual_base:r.actual_base_branch||r.base_branch||null,
      base_sha:r.base_sha||null,base_current:r.base_current??null,
      parent_merge_sha:r.parent_merged_sha||null,
      branch_update_status:r.branch_maintenance_result||null,
      branch_update_error:r.branch_maintenance_error||null,
      branch_update_evidence:r.codex_branch_update||null,
      branch_conflict:r.codex_branch_conflict||null},
    merge:{eligible:mergeEligible,blockers:mergeBlockers,merge_sha:r.merge_sha||null,
      merge_at:r.merged_at||null,branch_maintenance:r.branch_maintenance_result||null,
      owner_merge_required:r.dispatcher_only===true,
      actual_merge_state:r.github_state||null,
      attempted_at:r.merge_attempted_at||null,
      merge_error:r.merge_failure||null,
      current_head_sha:head},
    integration:{status:integrated?'PROVEN':isMerged(r)?'PENDING':'NOT_APPLICABLE',
      merge_sha:r.merge_sha||null,proof_run_id:r.integration_proof?.workflow_run_id||null,
      proof_source:r.integration_proof?.source||null,
      proof_run_url:r.integration_proof?.run_url||null,
      proof_verified_at:r.integration_verified_at||null,
      failure:r.landing_failure||r.integration_failure||null,
      landing_status:r.landing_dispatch||null},
    monitor:{last_observed_at:r.last_github_activity||null,
      github_effects:r.github_effects||{},github_effect_history:(r.github_effect_history||[]).slice(-30),
      status_age_minutes:age(r.last_github_activity,clock),
      last_dispatcher_state_at:state.updated_at||null,
      incidents:notices.filter(n=>['planned','claimed','uncertain'].includes(n.status))
        .map(n=>({kind:n.kind,status:n.status,created_at:n.created_at||null})),
      last_schedule_at:state.schedule_health?.last_schedule_at||null,
      api_pause_until:state.api_pause?.until||null,
      owner_control_revision:state.owner_controls?.revision??0,
      pending_recovery_count:Object.values(state.recovery_requests||{})
        .filter(x=>x.task_id===id&&['PENDING','OBSERVED'].includes(x.status)).length,
      next_action:action,next_actor:actor,next_reason:reason}
  };
}

export function projectLifecycle(state,queue={},now=new Date().toISOString()){
  if(!state||state.version!==1||!state.tasks||!state.actions)throw Error('Invalid authoritative ledger');
  const plan=Array.isArray(queue.tasks)?queue.tasks:[];
  const planById=new Map(plan.map(t=>[t.id,t]));
  const taskIds=[...new Set([...planById.keys(),...Object.keys(state.tasks)])];
  const tasks={};
  for(const id of taskIds)
    tasks[id]=taskLifecycle(planById.get(id)||{id},state.tasks[id]||{},state,queue,now);
  const scheduleAt=state.schedule_health?.last_schedule_at||null;
  const scheduleAge=age(scheduleAt,time(now));
  const scheduleStatus=scheduleAge===null?'UNKNOWN':scheduleAge>15?'STALE':'OBSERVED';
  return {schema_version:V3_VERSION,generated_at:now,source_ledger_updated_at:state.updated_at||null,
    health:{schedule_status:scheduleStatus,last_schedule_at:scheduleAt,
      schedule_age_minutes:scheduleAge,source_is_live:false,
      note:'An unchanged ledger is not a running-dispatcher heartbeat'},
    tasks};
}

// Persist a bounded transition log only when verified milestones or actions
// really change. The v1 actions/approvals/receipts remain authoritative.
export function recordLifecycleTransitions(state,queue,now=new Date().toISOString()){
  const next=structuredClone(state),view=projectLifecycle(next,queue,now);
  next.lifecycle_v3||={version:V3_VERSION,latest:{},transitions:[]};
  const log=next.lifecycle_v3;
  for(const [id,rec] of Object.entries(view.tasks)){
    const latest={stage:rec.current_stage,action:rec.monitor.next_action,actor:rec.monitor.next_actor,
      head_sha:rec.pr.head_sha,ci:rec.ci.status,codex:rec.codex.status,
      merge_sha:rec.merge.merge_sha,integration:rec.integration.status};
    const before=log.latest[id];
    if(JSON.stringify(before)!==JSON.stringify(latest)){
      log.transitions.push({task_id:id,at:now,from:before||null,to:latest,
        source:'derived_from_authoritative_evidence'});
      log.latest[id]=latest;
    }
  }
  // Full dashboard columns are cached as a derived projection only. All
  // time-relative ages come from timestamps when the view is opened; never
  // produce a Git commit simply because another minute elapsed.
  const rows=structuredClone(view.tasks);
  for(const row of Object.values(rows)){
    delete row.coding.minutes_since_commit;
    delete row.monitor.status_age_minutes;
    delete row.monitor.last_dispatcher_state_at;
  }
  if(JSON.stringify(log.rows)!==JSON.stringify(rows))log.rows=rows;
  // Retain the latest 1000 transitions; complete Git commit history is immutable.
  if(log.transitions.length>1000)log.transitions=log.transitions.slice(-1000);
  return next;
}
