// Generic, durable proposal approval -> read-only scoped planning handoff.
// A "yes" advances an owner-approved goal, NEVER grants file-write permission.
import {createHash} from 'node:crypto';
import {settings} from './settings.mjs';
import {promptHash} from './delivery.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const yes=text=>/^yes(?:[.!]|(?:\s+to\s+(?:start|proceed))[.!]?)?$/i.test(String(text||'').trim());
export const proposalSourceHash=task=>{
  const fields=[task.id,task.goal,task.scope_hint,task.exclusive_files,
    task.acceptance,task.depends_on,task.brief];
  // Backward compatible with original live Muse proposal yeses, while newer
  // Studio plans that specify `edits` bind that exact write-scope proposal.
  if(Object.hasOwn(task,'edits'))fields.push(task.edits);
  return hash(fields);
};
export function proposalEligible(task,queue,records={}){
 const gate=queue?.dispatch_rules?.priority_gate_task;
 if(gate&&!['integrated_proven','released_proven'].includes(records?.[gate]?.status))
   return false;
 return (task.depends_on||[]).every(id=>{
   const rec=records?.[id];
   return ['integrated_proven','released_proven'].includes(rec?.status)||
     (task.can_start_stacked===true&&rec?.github_state==='open'&&
      Number.isInteger(rec.pr_number)&&
      ['draft_open','review_fixing'].includes(rec.status));
 });
}
const proposalApprovalHash=(task,notice)=>hash(['scope-plan-v1',task.id,
  notice.notice_hash,notice.source_sha]);

export function createScopePlanDelivery(task,{actionId,approvalHash,conversationUrl=null,correction=null}){
 const prompt=[
   settings.chatgpt.project_name+' scope_plan | task '+task.id,
   'Owner said YES to the goal and authorized a READ-ONLY planning step. This is NOT coding permission.',
   ...(correction?['GITHUB DISPATCHER CORRECTION: '+String(correction)]:[]),
   'Read AGENTS.md and PROGRESS.md (read-only), this signed task plan, existing code and active dependencies.',
   'Goal: '+String(task.goal||task.title||'').slice(0,300),
   'Suggested areas only (NOT authorized files): '+String(task.scope_hint||'none').slice(0,500),
   'Required acceptance: '+(task.acceptance||[]).join('; ').slice(0,900),
   'Dependencies: '+(task.depends_on||[]).join(', '),
   'Prepare an exact implementation scope, tests, and acceptance plan. Shared-file edits are permitted across separately approved branches; GitHub determines safe integration order.',
   'Check current PRs and dependencies; disclose shared-file impact. Do not treat another PR editing the same file as a coding blocker.',
   'Show the proposed exact scope to the owner through the existing Muse conversation and request only the missing concrete decision; the owner already approved the task goal and must NOT be asked to approve that again.',
   'STOP at the planning step: DO NOT modify or commit any code, open a coding PR, run effects, create migrations, or claim coding permission. No production/Vercel-preview actions.',
   'Publish your EXACT proposed implementation scope as ONE verified GitHub issue #411 comment (this is NOT a code PR): https://github.com/'+settings.repo+'/issues/411',
   'Use your connected GitHub account; one line containing exactly: <!-- aicafe-scope-plan:v1 {"task_id":"'+task.id+'","action_id":"'+actionId+'","proposal_source_sha":"'+proposalSourceHash(task)+'","edits":["exact/owned/path.ts"],"uses":[],"architecture":"At least 80 characters describing actual source fields, object keys, persistence/readers, change behavior, omissions and tenant differences","acceptance_plan":"At least 30 characters of executed checks and acceptance plan"} -->',
   'Replace sample files with your real proposed paths. Keep source fields, keys, rejected data and cross-cafe gaps concrete. Do NOT include credentials, production data or private owner messages in this public comment.',
   'The dispatcher reads that GitHub comment and brings EXACT scope approval to the owner through Muse; never ask Muse to inspect this chat or respond for the owner.',
   'Only after the exact proposal is independently approved in Muse may the dispatcher authorize a coding prompt in this same chat.',
   'Authority: https://github.com/'+settings.repo+'/blob/main/AGENTS.md',
   'Signed queue: https://github.com/'+settings.queue.repo+'/blob/'+settings.queue.ref+'/'+settings.queue.path,
   'Task brief: https://github.com/'+settings.repo+'/blob/main/'+String(task.brief||''),
 ].join('\n');
 return {version:1,action_id:actionId,approval_hash:approvalHash,
   project:{id:settings.chatgpt.project_id,name:settings.chatgpt.project_name},
   muse_space:settings.muse.space,chatgpt_account:settings.chatgpt.account_label,
   project_url:settings.chatgpt.project_url,effort:settings.effort_default,
   provider:'chatgpt',intent:conversationUrl?'continue_existing_chat':'start_new_chat',
   conversation_url:conversationUrl,
   task_id:task.id,base_branch:'main',prompt,prompt_hash:promptHash(prompt)};
}

// Reads previously validated, actor-authenticated Muse replies from the same
// authoritative private ledger. Never infer approval from owner-facing notices.
export function advanceApprovedProposals(state,queue,{now=new Date().toISOString()}={}){
 const next=structuredClone(state);
 next.tasks||={};next.actions||={};next.owner_alerts||={};
 for(const task of queue?.tasks||[]){
   if(task.state!=='proposed'||task.architecture_approval?.approved===true)continue;
   const signature=proposalSourceHash(task);
   const replies=[
     ...Object.entries(next.owner_proposal_replies?.[task.id]||{}).map(([id,r])=>({id,...r})),
     ...Object.entries(next.tasks?.[task.id]?.owner_reply_events||{})
       .filter(([,r])=>r.target?.notice_id).map(([id,r])=>({
         id,...r,notice_id:r.target.notice_id,source_sha:signature}))
   ].filter(r=>{
     const n=next.owner_alerts?.[r.notice_id];
     return r.courier==='muse'&&n?.kind==='next_task_proposal'&&
       n.task_id===task.id&&n.source_sha===signature&&
       r.source_sha===signature&&['planned','submitted'].includes(n.status);
   }).sort((a,b)=>(Date.parse(a.at||'')||0)-(Date.parse(b.at||'')||0)||
     String(a.id).localeCompare(String(b.id)));
   const decision=replies.at(-1);
   const previous=next.tasks[task.id];
   // Never rewrite an ongoing or proven coding task from a stale proposal.
   if(previous?.pr_number || (previous?.conversation_ref&&!previous.proposal_notice_id) ||
      ['assigned','draft_open','review_fixing','merged','integrated_proven','released_proven'].includes(previous?.status))
     continue;
   const eligible=proposalEligible(task,queue,next.tasks);
   if(!eligible){
     if(previous?.planning_approved&&previous.status==='scope_planning'){
       previous.planning_eligible=false;
       for(const action of Object.values(next.actions))
         if(action.task_id===task.id&&
            ['scope_plan','scope_plan_update'].includes(action.type)&&
            action.status==='planned')
           action.status='cancelled_dependency_changed';
     }
     continue;
   }
   if(!decision) {
     if(previous?.planning_approved && previous.proposal_source_sha!==signature){
       for(const action of Object.values(next.actions))
         if(action.task_id===task.id&&['scope_plan','scope_plan_update'].includes(action.type)&&action.status==='planned')
           action.status='cancelled_approval_changed';
       next.tasks[task.id]={...previous,planning_approved:false,approved:false,
         status:'blocked_needs_owner',scope_change_pending:true};
     }
     continue;
   }
   if(!yes(decision.text)){
     if(previous?.planning_approved){
       for(const action of Object.values(next.actions))
         if(action.task_id===task.id&&['scope_plan','scope_plan_update'].includes(action.type)&&action.status==='planned')
           action.status='cancelled_owner_state_changed';
       next.tasks[task.id]={...previous,planning_approved:false,approved:false,
         status:'blocked_needs_owner',owner_answer_text:decision.text};
     }
     continue;
   }
   if(previous?.planning_approved && previous.proposal_source_sha===signature){
     if(previous.planning_eligible===false){
       for(const action of Object.values(next.actions))
         if(action.task_id===task.id&&
           ['scope_plan','scope_plan_update'].includes(action.type)&&
           action.proposal_source_sha===signature&&
           action.status==='cancelled_dependency_changed'&&!action.receipt)
           action.status='planned';
       previous.planning_eligible=true;
     }
     continue;
   }
   // A previously delivered/planned/claimed scope chat is not replayed.
   if(Object.values(next.actions).some(a=>a.task_id===task.id&&
     ['scope_plan','scope_plan_update'].includes(a.type)&&a.proposal_source_sha===signature&&
      ['planned','claimed','uncertain','submitted','needs_login'].includes(a.status)))
     continue;
   const notice=next.owner_alerts[decision.notice_id];
   const approvalHash=proposalApprovalHash(task,notice);
   const conversationUrl=previous?.proposal_notice_id
     ? previous.conversation_ref||null:null;
   const actionType=conversationUrl?'scope_plan_update':'scope_plan';
   const key=actionType+':'+encodeURIComponent(task.id)+':'+notice.notice_hash;
   if(next.actions[key])continue;
   const record={...previous,task_id:task.id,agent:'chatgpt',
     status:'scope_planning',planning_approved:true,planning_eligible:true,approved:false,
     proposal_source_sha:signature,approval_hash:approvalHash,
     proposal_notice_id:decision.notice_id,proposal_owner_event_id:decision.id,
     planning_approved_at:decision.at||now,
     // Scope planning has no repository branch or code permission.
     branch:null,pr_number:null,scope_plan_completed:false,
     conversation_ref:conversationUrl,conversation_url:conversationUrl};
   const delivery=createScopePlanDelivery(task,{actionId:key,approvalHash,conversationUrl});
   next.tasks[task.id]=record;
   next.actions[key]={task_id:task.id,type:actionType,status:'planned',
     delivery_owner:'muse',proposal_source_sha:signature,
     created_at:now,delivery};
 }
 return next;
}
