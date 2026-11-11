// Authenticated Muse -> GitHub recovery hints.
// A command can only WAKE existing deterministic gates; it NEVER authorizes an
// approval, changes a head, supplies a CI result, or bypasses a merge hold.
import {createHash} from 'node:crypto';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const SHA=/^[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const RECOVERY_INTENTS=Object.freeze([
 'RECONCILE','MARK_READY_IF_ELIGIBLE','REQUEST_CODEX_IF_ELIGIBLE',
 'RETRY_CI_IF_SAFE','REFRESH_BRANCH_IF_SAFE','MERGE_IF_ELIGIBLE',
 'VERIFY_INTEGRATION','CHECK_STALL'
]);
const intents=new Set(RECOVERY_INTENTS);
export function recoveryIdentity(input){
  const p=input||{};
  return sha([p.repo,p.actor,p.intent,p.task_id,p.pr_number,p.expected_head_sha,p.requested_at]);
}
export function recoveryEvent(event,{repo,actors={},owner,records={},now=new Date().toISOString()}={}){
  if(event?.action!=='dispatcher_recovery')return null;
  const payload=event.client_payload||{};
  const actor=event.sender?.login;
  const label=actors[actor];
  if(typeof actor!=='string'||!(label==='muse'||actor===owner))
    return {accepted:false,reason:'unauthenticated_muse_or_owner'};
  if(payload.version!==1||!intents.has(payload.intent)||
    !ID.test(payload.task_id||'')||!Number.isInteger(payload.pr_number)||
    payload.pr_number<1||!SHA.test(payload.expected_head_sha||''))
    return {accepted:false,reason:'malformed_recovery_request'};
  const requestedAt=Date.parse(payload.requested_at||''),clock=Date.parse(now);
  if(!Number.isFinite(requestedAt)||!Number.isFinite(clock)||
    requestedAt>clock+120000||clock-requestedAt>10*60000)
    return {accepted:false,reason:'stale_or_future_recovery_request'};
  const current=records[payload.task_id];
  if(!current||current.pr_number!==payload.pr_number)
    return {accepted:false,reason:'unmatched_task_pr'};
  if(current.head_sha!==payload.expected_head_sha)
    return {accepted:false,reason:'stale_head'};
  const item={repo,actor,intent:payload.intent,task_id:payload.task_id,
    pr_number:payload.pr_number,expected_head_sha:payload.expected_head_sha,
    requested_at:payload.requested_at};
  const key=recoveryIdentity(item);
  if(payload.request_id!==key)
    return {accepted:false,reason:'request_identity_mismatch'};
  return {accepted:true,request:{...item,request_id:key,status:'PENDING',
    first_seen_at:now,verified_actor:label==='muse'?'muse':'owner'}};
}
// This only records a GitHub-authenticated sender; a caller-supplied "actor"
// inside client_payload has no authority.
export function recordRecoveryEvent(state,event,options={}){
  const next=structuredClone(state);
  const parsed=recoveryEvent(event,{...options,records:next.tasks});
  if(!parsed)return next;
  if(!parsed.accepted)return next; // Invalid requests never authorize effects.
  next.recovery_requests||={};
  if(!next.recovery_requests[parsed.request.request_id])
    next.recovery_requests[parsed.request.request_id]=parsed.request;
  return next;
}
function outcome(req,row){
  if(!row)return {status:'BLOCKED',reason:'missing_task_projection'};
  if(row.pr.head_sha!==req.expected_head_sha)
    return {status:'BLOCKED',reason:'head_changed_since_request'};
  const p=row.pr,c=row.codex,ci=row.ci,m=row.merge;
  switch(req.intent){
    case 'RECONCILE':return {status:'OBSERVED',reason:'verified_facts_reconciled_not_action_authorized'};
    case 'CHECK_STALL':return {status:'OBSERVED',reason:row.coding.suspected_stall?'suspected_stall':'no_verified_stall'};
    case 'MARK_READY_IF_ELIGIBLE':
      return p.state==='OPEN'?{status:'SATISFIED',reason:'pr_ready'}:
        {status:'PENDING',reason:row.monitor.next_reason};
    case 'REQUEST_CODEX_IF_ELIGIBLE':
      return c.request_status==='CONFIRMED'?{status:'SATISFIED',reason:'review_request_verified'}:
        c.status==='CLEAN'||c.status==='FINDINGS'?{status:'SATISFIED',reason:'review_observed'}:
        {status:'PENDING',reason:c.request_status};
    case 'RETRY_CI_IF_SAFE':
      return ci.retry?.head_sha===p.head_sha?{status:'SATISFIED',reason:'verified_startup_retry_reserved'}:
        {status:'PENDING',reason:ci.failure_kind||ci.status};
    case 'REFRESH_BRANCH_IF_SAFE':
      return row.merge.branch_maintenance==='updating'||row.merge.branch_maintenance==='already_current'
        ?{status:'SATISFIED',reason:'safe_branch_update_observed'}:
        {status:'PENDING',reason:m.blockers.join(',')||'branch_update_unverified'};
    case 'MERGE_IF_ELIGIBLE':
      return m.merge_sha?{status:'SATISFIED',reason:'merge_sha_verified'}:
        {status:'PENDING',reason:m.blockers.join(',')||'awaiting_github_merge'};
    case 'VERIFY_INTEGRATION':
      return row.integration.status==='PROVEN'?{status:'SATISFIED',reason:'exact_merge_sha_proven'}:
        {status:'PENDING',reason:row.integration.status};
    default:return {status:'BLOCKED',reason:'unknown_intent'};
  }
}
export function settleRecoveryRequests(state,view,now=new Date().toISOString()){
  const next=structuredClone(state);
  for(const req of Object.values(next.recovery_requests||{})){
    if(!['PENDING','OBSERVED'].includes(req.status))continue;
    const result=outcome(req,view?.tasks?.[req.task_id]);
    if(req.status!==result.status||req.reason!==result.reason){
      req.status=result.status;req.reason=result.reason;
      req.checked_at=now;
    }
  }
  return next;
}
