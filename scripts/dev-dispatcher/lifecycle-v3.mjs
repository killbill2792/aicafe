// Dispatcher v3: one deterministic, read-only interpretation of existing signed facts.
// This is a PROJECTION of the original private ledger, never a second authority.
// No model output, inactivity guess, or self-reported coder_done proves completion.
import {overlappingPredecessorIds} from './core.mjs';

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
  const delivered=actions.filter(a=>a.status==='submitted'&&a.receipt)
    .sort((a,b)=>(time(b.submitted_at)||0)-(time(a.submitted_at)||0));
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
  const ownerHold=!!(r.sensitive_owner_block||r.protected_file_violation?.length);
  const blocked=[];
  if(!authorized)blocked.push(!approved?'task_not_approved':r.repo_mismatch?'wrong_repository':
    ownerHold?'privileged_owner_hold':'scope_mismatch');
  if(prOpen(r)){
    if(r.draft!==false)blocked.push('draft_pr');
    if(!green(r))blocked.push('ci_not_green');
    if(!cleaned(r))blocked.push('codex_not_clean_on_head');
    if(r.threads_resolved!==true)blocked.push('unresolved_review_threads');
    if(r.mergeable!==true)blocked.push('not_verified_mergeable');
    if(remainingParents.length)blocked.push('predecessor_not_merged');
    if(r.base_current===false)blocked.push('branch_base_outdated');
  }
  const mergeEligible=prOpen(r)&&authorized&&blocked.length===0;
  const integrated=proofGood(r);
  const codeSubmitted=prOpen(r)||isMerged(r);
  const deliveryVerified=!!r.conversation_ref&&delivered.length>0;
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
    dispatch:{eligible:approved,delivered:milestones.delivered,last_prompt_at:r.last_submission_at||null,
      pending_actions:awaiting.map(a=>({id:a.key,type:a.type,status:a.status,created_at:a.created_at||null})),
      verified_chat_url:deliveryVerified?r.conversation_ref:null},
    coding:{branch:r.branch||null,last_commit_sha:head,last_commit_at:r.last_commit_at||null,
      minutes_since_commit:age(r.last_commit_at,clock),last_pr_activity_at:r.last_github_activity||null,
      suspected_stall:suspectIdle,chat_completion_authoritative:false},
    pr:{number:r.pr_number||null,url:r.pr_number?'https://github.com/'+(queue.repo||'killbill2792/aicafe')+'/pull/'+r.pr_number:null,
      state:isMerged(r)?'MERGED':prOpen(r)?r.draft?'DRAFT':'OPEN':'MISSING',
      base_branch:r.base_branch||null,base_sha:r.base_sha||null,head_sha:head,
      mergeable:r.mergeable===true?'YES':r.mergeable===false?'NO':'UNKNOWN',
      draft_ready_at:r.ready_transition_at||null},
    ci:{status:ci,head_sha:head,failed_check:r.ci_failure_job||null,
      failure_kind:r.ci_failure_kind||null,run_url:r.ci_failure_url||null,
      missing_checks:r.ci_missing_names||[],retry:r.transient_ci_retry||null},
    codex:{status:codex,request_status:reviewRequest,reviewed_sha:r.codex_reviewed_sha||null,
      requested_sha:r.codex_review_requested_sha||null,review_at:r.codex_review_at||null,
      open_threads:Array.isArray(r.unresolved_codex_comments)?r.unresolved_codex_comments.length:null,
      watchdog:r.codex_watchdog||null},
    acceptance:{status:acceptance,required_count:task?.acceptance?.length||0,
      evidence_head_sha:r.acceptance_evidence?.head_sha||null,reported_coder_done_ignored:true},
    merge:{eligible:mergeEligible,blockers:blocked,merge_sha:r.merge_sha||null,
      merge_at:r.merged_at||null,branch_maintenance:r.branch_maintenance_result||null},
    integration:{status:integrated?'PROVEN':isMerged(r)?'PENDING':'NOT_APPLICABLE',
      merge_sha:r.merge_sha||null,proof_run_id:r.integration_proof?.workflow_run_id||null},
    monitor:{last_observed_at:r.last_github_activity||null,
      status_age_minutes:age(r.last_github_activity,clock),
      last_dispatcher_state_at:state.updated_at||null,
      incidents:notices.filter(n=>['planned','claimed','uncertain'].includes(n.status))
        .map(n=>({kind:n.kind,status:n.status,created_at:n.created_at||null})),
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
