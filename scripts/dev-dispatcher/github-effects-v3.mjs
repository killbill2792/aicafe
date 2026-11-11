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
   if(head!=null&&(!SHA.test(head)||rec.head_sha&&rec.head_sha!==head))continue;
   const proof={
     operation:item.operation,head_sha:head||null,status:item.status,
     reason:typeof item.reason==='string'?item.reason.slice(0,140):null,
     pr_number:Number.isInteger(item.pr_number)?item.pr_number:rec.pr_number||null
   };
   const prior=rec.github_effects?.[item.operation];
   if(prior&&JSON.stringify({...prior,observed_at:undefined})===
       JSON.stringify({...proof,observed_at:undefined}))continue;
   if(!result)result=structuredClone(state);
   const task=result.tasks[item.task_id];
   task.github_effects||={};
   task.github_effects[item.operation]={...proof,observed_at:now};
   task.github_effect_history||=[];
   task.github_effect_history.push({...proof,observed_at:now,
     previous_status:prior?.status||null});
   task.github_effect_history=task.github_effect_history.slice(-30);
 }
 return result;
}
