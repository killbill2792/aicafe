import {queueOwnerIssue,resolveOwnerIssueIdentity} from './alerts.mjs';
// The trusted GitHub runner's own operation receipts, retained in the
// authoritative private task ledger. A PR gate is evidence, not an effect.
const OPERATIONS=new Set(['CREATE_DRAFT_PR','MARK_READY','MERGE']);
const STATUSES=new Set(['created','existing_pr_needs_link','ready_for_review',
 'merged_unproven','blocked','uncertain','already_linked','not_attempted']);
const SHA=/^[a-f0-9]{40}$/;
export function recordGithubEffects(state,observations=[],now=new Date().toISOString()){
 if(!state||state.version!==1||!state.tasks||!state.actions)
   throw Error('Private task ledger required');
 if(!Array.isArray(observations)||!Number.isFinite(Date.parse(now)))
   throw Error('Invalid GitHub observations');
 let result=null;
 for(const item of observations){
   if(!item||!OPERATIONS.has(item.operation)||
      typeof item.task_id!=='string'||!item.task_id||
      typeof item.status!=='string'||!STATUSES.has(item.status))continue;
   const rec=(result||state).tasks[item.task_id];
   if(!rec)continue;
   const head=item.head_sha;
   // Do not attach a late outcome to a new PR head, even when both share
   // the same task ID. Missing SHA is permitted for missing-branch checks.
   // An uncertain PR POST is branch-scoped. Even if ChatGPT pushed a newer
   // head before our outcome was committed, the old POST may have opened
   // a PR; the uncertainty must be latched against the task, not dropped.
   if(head!=null&&(!SHA.test(head)||rec.head_sha&&rec.head_sha!==head)&&
      !(item.operation==='CREATE_DRAFT_PR'&&item.status==='uncertain'&&SHA.test(head)))
      continue;
   const proof={
     operation:item.operation,head_sha:head||null,status:item.status,
     reason:typeof item.reason==='string'?item.reason.slice(0,140):null,
     pr_number:Number.isInteger(item.pr_number)?item.pr_number:rec.pr_number||null
   };
   const prior=rec.github_effects?.[item.operation];
   const uncertain=item.operation==='CREATE_DRAFT_PR'&&item.status==='uncertain';
   const confirmed=item.operation==='CREATE_DRAFT_PR'&&
     ['created','existing_pr_needs_link','already_linked'].includes(item.status)&&
     Number.isInteger(rec.pr_number)&&
     (!Number.isInteger(item.pr_number)||item.pr_number===rec.pr_number);
   const latch=uncertain&&!rec.pr_creation_uncertain_hold;
   const clear=confirmed&&Boolean(rec.pr_creation_uncertain_hold);
   const unchanged=prior&&JSON.stringify({...prior,observed_at:undefined})===
       JSON.stringify({...proof,observed_at:undefined});
   if(unchanged&&!latch&&!clear)continue;
   if(!result)result=structuredClone(state);
   const task=result.tasks[item.task_id];
   if(latch)task.pr_creation_uncertain_hold={
     first_observed_at:now,attempted_head_sha:head||rec.head_sha||null,
     reason:proof.reason||'unverified_pr_write'};
   if(clear)delete task.pr_creation_uncertain_hold;
   if(unchanged)continue;
   task.github_effects||={};
   task.github_effects[item.operation]={...proof,observed_at:now};
   task.github_effect_history||=[];
   task.github_effect_history.push({...proof,observed_at:now,
     previous_status:prior?.status||null});
   task.github_effect_history=task.github_effect_history.slice(-30);
 }
 return result;
}


// Convert a verified GitHub capability failure into an existing Muse-delivered
// owner notice, never a new approval or ChatGPT coding action. Stable incident
// identity prevents each scheduled tick from creating another owner prompt.
export function recordPrWriterOwnerNotices(state,observations=[]){
  if(!state||state.version!==1||!state.tasks||!state.actions)
    throw Error('Private ledger required for PR writer notice');
  let next=state;
  for(const item of observations){
    if(item?.operation!=='CREATE_DRAFT_PR'||!next.tasks[item.task_id])continue;
    const reasons=['missing_pr_creator_install_token','pr_creator_permission_denied'];
    if(item.status==='blocked'&&reasons.includes(item.reason)){
      const text=item.reason==='missing_pr_creator_install_token'
        ?'GitHub cannot open the signed draft PR because its configured PR-writer capability is missing.'
        :'GitHub rejected the signed draft-PR write due to insufficient permissions.';
      next=queueOwnerIssue(next,{kind:'pr_writer_unavailable',task_id:item.task_id,
        identity:item.task_id+':'+item.reason,
        message:text,
        needs:'Muse notify owner; verify the existing narrow GitHub installation permission outside chat. Do not send credentials or bypass the signed task.'});
    }else if(['created','existing_pr_needs_link','already_linked'].includes(item.status)){
      for(const reason of reasons)
        next=resolveOwnerIssueIdentity(next,{kind:'pr_writer_unavailable',
          task_id:item.task_id,identity:item.task_id+':'+reason});
    }
  }
  return next;
}
