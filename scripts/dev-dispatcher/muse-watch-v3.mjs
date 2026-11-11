#!/usr/bin/env node
// Muse-host independent observer. No AI/model call, no browser send, no owner
// approval, and no direct merge. Can run from cron/systemd OUTSIDE GitHub.
// It reads a Git-synced private ledger, keeps a local backlog, and wakes the
// existing trusted-main GitHub dispatcher only if independently warranted.
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {recoveryIdentity} from './recovery-v3.mjs';
import {dispatchFrontier} from './core.mjs';
import {dispatchPreferences} from './owner-controls-v3.mjs';
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const ago=(stamp,clock)=>time(stamp)===null?null:Math.floor((clock-time(stamp))/60000);
const sha=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
const asIso=clock=>new Date(clock).toISOString();
export function inspectMuseEligibleTasks(queue,state){
  if(!queue)return [];
  // Muse reads the SAME signed DAG and owner preferences as GitHub. This is
  // an advisory eligibility check, never a second approval or task mutation.
  return dispatchFrontier(queue,state.tasks,null,dispatchPreferences(state))
    .map(a=>({task_id:a.task_id,agent:a.agent,base_branch:a.base_branch,
      prerequisite_pr:a.prerequisite_pr||null}));
}
export function inspectMuseHealth(state,{now=new Date().toISOString(),scheduleGapMinutes=15,
  codingIdleMinutes=20,deliveryGapMinutes=15,queue=null}={}){
  if(state?.version!==1||!state.tasks||!state.actions)throw Error('Invalid private ledger');
  const clock=time(now);
  if(clock===null||[scheduleGapMinutes,codingIdleMinutes,deliveryGapMinutes].some(v=>
    !Number.isFinite(v)||v<1))throw Error('Invalid watchdog configuration');
  const incidents=[],tasks=[];
  const eligible=inspectMuseEligibleTasks(queue,state);
  if(eligible.length)
    incidents.push({kind:'UNASSIGNED_APPROVED_TASKS',action:'RECONCILE',
      task_id:null,tasks:eligible.map(x=>x.task_id),
      note:'Muse suggests eligible tasks; GitHub alone revalidates assignment'});
  const scheduleAge=ago(state.schedule_health?.last_schedule_at,clock);
  if(scheduleAge===null||scheduleAge>scheduleGapMinutes)
    incidents.push({kind:'GITHUB_SCHEDULE_STALE',
      age_minutes:scheduleAge,source:'schedule_health.last_schedule_at',
      action:'RECONCILE',task_id:null});
  const ledgerAge=ago(state.updated_at,clock);
  if(ledgerAge===null||ledgerAge>Math.max(2*scheduleGapMinutes,30))
    incidents.push({kind:'LEDGER_STALE',age_minutes:ledgerAge,source:'state.updated_at',
      action:'RECONCILE',task_id:null});
  for(const [id,r] of Object.entries(state.tasks)){
    // A verified Muse prompt can be stranded before an early draft PR exists.
    // GitHub must attempt its signed-branch recovery; Muse checks the ORIGINAL
    // ChatGPT conversation if the branch/PR never materializes.
    const sinceDelivery=ago(r.last_submission_at,clock);
    if(r.approved===true&&!r.pr_number&&r.conversation_ref&&
      sinceDelivery!==null&&sinceDelivery>deliveryGapMinutes)
      incidents.push({kind:'DELIVERED_TASK_NO_PR',task_id:id,
        age_minutes:sinceDelivery,action:'MUSE_INSPECT_CHAT_AND_RECONCILE'});
    if(r.github_state!=='open'||!r.pr_number||!r.head_sha)continue;
    const last=Math.max(time(r.last_commit_at)||0,time(r.last_github_activity)||0,
      time(r.last_submission_at)||0);
    const idle=last?Math.floor((clock-last)/60000):null;
    if(r.draft===true&&r.ci_state!=='pending'&&idle!==null&&idle>codingIdleMinutes){
      incidents.push({kind:'SUSPECTED_CODING_STALL',task_id:id,pr_number:r.pr_number,
        head_sha:r.head_sha,age_minutes:idle,action:'CHECK_STALL'});
      tasks.push(id);
    }
    // CI can remain queued indefinitely without reporting a failure.
    // Record a suspected stalled check, never invent a red or green status.
    const pendingAt=r.ci_started_at||r.head_first_seen_at||
      r.last_commit_at||r.last_github_activity;
    const pendingAge=ago(pendingAt,clock);
    if(r.ci_state==='pending'&&pendingAge!==null&&pendingAge>30)
      incidents.push({kind:'CI_PENDING_STALE',task_id:id,pr_number:r.pr_number,
        head_sha:r.head_sha,age_minutes:pendingAge,action:'RECONCILE'});
    const codexAge=ago(r.ready_transition_at,clock);
    if(r.draft===false&&r.ci_state==='success'&&
      r.codex_state!=='clean'&&r.codex_state!=='findings'&&
      r.codex_reviewed_sha!==r.head_sha&&codexAge!==null&&codexAge>20)
      incidents.push({kind:'CODEX_NOT_RECEIVED',task_id:id,pr_number:r.pr_number,
        head_sha:r.head_sha,age_minutes:codexAge,action:'REQUEST_CODEX_IF_ELIGIBLE'});
  }
  for(const [id,a] of Object.entries(state.actions)){
    const delay=ago(a.created_at,clock);
    if(a.delivery_owner==='muse'&&['planned','uncertain','needs_login'].includes(a.status)&&
      delay!==null&&delay>deliveryGapMinutes)
      incidents.push({kind:'MUSE_DELIVERY_PENDING',task_id:a.task_id||null,
        action_id:id,age_minutes:delay,action:'MUSE_INSPECT_ORIGINAL_CHAT'});
  }
  const ownerPending=Object.values(state.owner_alerts||{}).filter(a=>
    a.delivery_owner==='muse'&&['planned','claimed','uncertain'].includes(a.status));
  if(ownerPending.length)incidents.push({kind:'OWNER_NOTICES_OUTSTANDING',
    count:ownerPending.length,action:'MUSE_DELIVER_NOTICES'});
  const reset=time(state.api_pause?.until);
  return {observed_at:now,schedule_age_minutes:scheduleAge,ledger_age_minutes:ledgerAge,
    github_api_pause_until:reset&&reset>clock?state.api_pause.until:null,
    incidents,eligible_tasks:eligible,
    tasks_suspected_stalled:tasks,healthy:incidents.length===0};
}
export function museRecoveryCandidates(health,state,{repo,actor,now=health?.observed_at}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!actor)throw Error('Invalid Muse identity');
  const clock=time(now);
  if(clock===null)throw Error('Invalid observation time');
  // One global reconciliation covers all infrastructure incidents. Specific
  // PR requests are hints; the GitHub engine still validates every gate.
  const intents=new Map();
  if(health.incidents.some(i=>['GITHUB_SCHEDULE_STALE','LEDGER_STALE',
      'UNASSIGNED_APPROVED_TASKS','DELIVERED_TASK_NO_PR','CI_PENDING_STALE'].includes(i.kind)))
    intents.set('global',{intent:'RECONCILE',task_id:null,pr_number:null,expected_head_sha:null});
  for(const i of health.incidents){
    if(!['SUSPECTED_CODING_STALL','CODEX_NOT_RECEIVED'].includes(i.kind))continue;
    if(!state.tasks[i.task_id]||state.tasks[i.task_id].head_sha!==i.head_sha)continue;
    intents.set(i.task_id+':'+i.action,{intent:i.action,task_id:i.task_id,
      pr_number:i.pr_number,expected_head_sha:i.head_sha});
  }
  const requestedAt=asIso(clock);
  return [...intents.values()].map(p=>{
    const identity={repo,actor,...p,requested_at:requestedAt};
    return {version:1,...identity,request_id:recoveryIdentity(identity)};
  });
}
export function planMuseBacklog(backlog,requests,now=new Date().toISOString()){
  const next=structuredClone(backlog&&typeof backlog==='object'?backlog:{version:1,items:{}});
  next.version=1;next.items||={};
  for(const request of requests){
    const key=sha([request.repo,request.intent,request.task_id,request.expected_head_sha]);
    const old=next.items[key];
    // Backoff and acknowledged wakes are durable: a 60-second poll must not
    // discard a 30-minute rate-limit cooldown or resend a successful wake.
    if(old&&['QUEUED','SENT_UNVERIFIED','GITHUB_ACKNOWLEDGED','GITHUB_REJECTED'].includes(old.status)&&
      time(now)-(time(old.acknowledged_at||old.first_seen_at)||0)<15*60000)continue;
    if(old?.status==='RETRYABLE'&&time(old.next_retry_at)>time(now))continue;
    // The GitHub receiver rejects commands older than 10 minutes. Rebind a
    // retry to a fresh timestamp only AFTER its cooldown expires.
    next.items[key]={key,status:'QUEUED',request,first_seen_at:now,
      attempts:old?.attempts||0,last_error:old?.last_error||null,next_retry_at:null};
  }
  // A bounded local backlog, no indefinite unbounded spool growth.
  const ordered=Object.values(next.items).sort((a,b)=>
    String(b.first_seen_at).localeCompare(String(a.first_seen_at)));
  next.items=Object.fromEntries(ordered.slice(0,200).map(x=>[x.key,x]));
  return next;
}
export async function deliverMuseRecovery(backlog,{token,now=new Date().toISOString(),
  fetchImpl=fetch,apiPauseUntil=null}={}){
  const next=structuredClone(backlog);
  const clock=time(now);
  if(clock===null)throw Error('Invalid delivery clock');
  const pause=[time(apiPauseUntil),time(next.api_pause_until)]
    .filter(Number.isFinite).sort((a,b)=>b-a)[0];
  if(pause>clock)return {backlog:next,results:[{status:'API_PAUSED',until:asIso(pause)}]};
  if(pause&&pause<=clock)delete next.api_pause_until;
  const results=[];
  for(const item of Object.values(next.items||{})){
    if(!['QUEUED','RETRYABLE'].includes(item.status)||time(item.next_retry_at)>clock)continue;
    if(!token){
      results.push({id:item.key,status:'WAITING_FOR_AUTHORIZED_WAKE_TOKEN'});
      continue;
    }
    const r=item.request;
    try{
      const response=await fetchImpl('https://api.github.com/repos/'+r.repo+'/dispatches',{
        method:'POST',headers:{Authorization:'Bearer '+token,
          Accept:'application/vnd.github+json','Content-Type':'application/json'},
        body:JSON.stringify({event_type:'dispatcher_recovery',client_payload:{
          version:1,intent:r.intent,task_id:r.task_id,pr_number:r.pr_number,
          expected_head_sha:r.expected_head_sha,requested_at:r.requested_at,
          request_id:r.request_id}})
      });
      item.attempts++;
      item.last_attempt_at=now;
      if(response.status===204){
        item.status='SENT_UNVERIFIED';item.next_retry_at=null;
        results.push({id:item.key,status:item.status});
      }else{
        item.status='RETRYABLE';
        const remaining=response.headers?.get?.('x-ratelimit-remaining');
        const retryHeader=response.headers?.get?.('retry-after');
        const rateLimited=response.status===429||
          (response.status===403&&(remaining==='0'||retryHeader!==null&&retryHeader!==undefined));
        const forbidden=response.status===401;
        const ambiguous403=response.status===403&&!rateLimited;
        const seconds=retryHeader==null?NaN:Number(retryHeader);
        const reset=response.headers?.get?.('x-ratelimit-reset');
        const resetAt=reset==null?NaN:Number(reset)*1000;
        const backoff=Math.min(30,2**Math.min(4,item.attempts));
        const mins=rateLimited?Math.max(15,
          Number.isFinite(seconds)?Math.ceil(seconds/60):15,
          Number.isFinite(resetAt)?Math.ceil((resetAt-clock)/60000):0):
          forbidden||ambiguous403?60:backoff;
        item.last_error=forbidden?'GitHub wake credential unauthorized HTTP 401':
          ambiguous403?'GitHub HTTP 403: rate limit or authorization unverified':
          rateLimited?'GitHub API rate limit HTTP '+response.status:
          'GitHub dispatch HTTP '+response.status;
        item.next_retry_at=asIso(clock+mins*60000);
        results.push({id:item.key,status:item.status,reason:item.last_error});
        if(rateLimited||forbidden||ambiguous403||[500,502,503,504].includes(response.status)){
          next.api_pause_until=item.next_retry_at;
          // One API outage must not fan out into many failed wake attempts.
          break;
        }
      }
    }catch{
      item.attempts++;item.status='RETRYABLE';item.last_error='transport_unverified';
      item.next_retry_at=asIso(clock+15*60000);
      results.push({id:item.key,status:item.status,reason:item.last_error});
    }
  }
  return {backlog:next,results};
}
export function reconcileMuseBacklog(backlog,state){
  const next=structuredClone(backlog);
  for(const [key,item] of Object.entries(next.items||{})){
    const rejected=state.recovery_rejections?.[item.request.request_id];
    if(rejected){
      item.status='GITHUB_REJECTED';item.acknowledged_at=rejected.at||null;
      item.verified_outcome='REJECTED';item.verified_reason=rejected.reason;
      continue;
    }
    const proof=state.recovery_requests?.[item.request.request_id];
    if(proof&&['OBSERVED','SATISFIED','BLOCKED'].includes(proof.status)){
      item.status='GITHUB_ACKNOWLEDGED';item.acknowledged_at=proof.checked_at||null;
      item.verified_outcome=proof.status;item.verified_reason=proof.reason;
    }
    // A confirmed GitHub observation is required; a 204 HTTP response is not.
  }
  return next;
}
export async function runMuseWatch({ledgerPath,backlogPath,queuePath=null,repo,actor,token,
  now=new Date().toISOString(),fetchImpl=fetch}={}){
  if(!ledgerPath||!backlogPath)throw Error('Ledger snapshot and local backlog paths required');
  const state=JSON.parse(readFileSync(ledgerPath,'utf8'));
  const backlog=existsSync(backlogPath)?JSON.parse(readFileSync(backlogPath,'utf8')):null;
  const queue=queuePath?JSON.parse(readFileSync(queuePath,'utf8')):null;
  const health=inspectMuseHealth(state,{now,queue});
  const candidates=museRecoveryCandidates(health,state,{repo,actor,now});
  const planned=planMuseBacklog(reconcileMuseBacklog(backlog||{version:1,items:{}},state),candidates,now);
  const delivered=await deliverMuseRecovery(planned,{token,now,fetchImpl,
    apiPauseUntil:health.github_api_pause_until});
  mkdirSync(dirname(backlogPath),{recursive:true,mode:0o700});
  // A crash while rewriting the only Muse recovery backlog must not leave
  // truncated JSON and permanently disable the independent watchdog.
  const temporary=backlogPath+'.tmp-'+process.pid;
  try{
    writeFileSync(temporary,JSON.stringify(delivered.backlog,null,2)+'\n',
      {mode:0o600,flag:'wx'});
    renameSync(temporary,backlogPath);
  }catch(error){
    try{unlinkSync(temporary);}catch{}
    throw error;
  }
  return {health,delivery:delivered.results,backlog_path:backlogPath};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const [ledgerPath,backlogPath,queuePath]=process.argv.slice(2);
  runMuseWatch({ledgerPath,backlogPath,queuePath,repo:process.env.GITHUB_REPOSITORY,
    actor:process.env.MUSE_GITHUB_ACTOR,token:process.env.MUSE_GITHUB_WAKE_TOKEN})
    .then(r=>{console.log(JSON.stringify(r));if(!r.health.healthy)process.exitCode=2;})
    .catch(e=>{console.error('Muse watchdog unavailable: '+String(e.message));process.exitCode=1;});
}
