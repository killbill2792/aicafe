// Exact-file proposal review: same signed queue, same Muse notices/receipts.
// GitHub planner comments are UNTRUSTED proposals, never owner authorization.
import {createHash} from 'node:crypto';
import {settings} from './settings.mjs';
import {noticeHash} from './alerts.mjs';
import {proposalSourceHash} from './proposal-stage.mjs';
import {validateQueue,editableFiles} from './core.mjs';
import {approvalSignature} from './delivery.mjs';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const taskId=id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
const pathOK=p=>typeof p==='string'&&p.length>0&&p.length<240&&
 !p.startsWith('/')&&!p.includes('*')&&!p.split('/').includes('..')&&
 /^[a-zA-Z0-9_./-]+$/.test(p);
const yes=s=>/^yes(?:[.!]|(?:\s+to\s+(?:start|proceed))[.!]?)?$/i.test(String(s||'').trim());

// Plans go on the existing owner-control issue #411, not a new PR, queue, job
// or comment channel. The ChatGPT planning agent must post this one-line marker:
// <!-- aicafe-scope-plan:v1 {"task_id":"...","action_id":"...","proposal_source_sha":"...","edits":["..."],"uses":["..."],"architecture":"source fields / keys / readers / what changes / gaps / multi-cafe","acceptance_plan":"..."} -->
const pattern=/<!-- aicafe-scope-plan:v1 (\{[^\r\n]{1,6000}\}) -->/g;
export function parseScopePlanComment(comment,queue,state){
 if(comment?.user?.login!==settings.owner.login ||
    comment?.author_association!=='OWNER'||!Number.isSafeInteger(comment.id)||
    !Number.isFinite(Date.parse(comment.created_at||''))||
    typeof comment.body!=='string')return null;
 const matches=[...comment.body.matchAll(pattern)];
 if(matches.length!==1)return null;
 let draft;try{draft=JSON.parse(matches[0][1]);}catch{return null;}
 if(!taskId(draft.task_id)||typeof draft.action_id!=='string'||
    !Array.isArray(draft.edits)||!draft.edits.length||draft.edits.length>25||
    !draft.edits.every(pathOK)||new Set(draft.edits).size!==draft.edits.length||
    !Array.isArray(draft.uses||[])||!(draft.uses||[]).every(pathOK)||
    new Set(draft.uses||[]).size!==(draft.uses||[]).length||
    typeof draft.architecture!=='string'||draft.architecture.trim().length<80||
    draft.architecture.length>1800||typeof draft.acceptance_plan!=='string'||
    draft.acceptance_plan.trim().length<30||draft.acceptance_plan.length>1300)
   return null;
 const task=queue.tasks.find(t=>t.id===draft.task_id);
 const rec=state.tasks?.[draft.task_id], action=state.actions?.[draft.action_id];
 if(!task||task.state!=='proposed'||task.architecture_approval?.approved===true||
    !rec?.scope_plan_completed||!rec?.conversation_ref||
    rec.proposal_source_sha!==proposalSourceHash(task)||
    draft.proposal_source_sha!==rec.proposal_source_sha||
    action?.task_id!==task.id||
    !['scope_plan','scope_plan_update'].includes(action.type)||
    action.status!=='submitted'||!action.receipt||
    action.delivery?.approval_hash!==action.receipt?.approval_hash &&
      action.receipt?.approval_hash!=null||
    !Number.isFinite(Date.parse(action.submitted_at||''))||
    Date.parse(comment.created_at)<Date.parse(action.submitted_at))return null;
 // Authenticated owner approval later is still mandatory. Nothing in this
 // untrusted comment can authorize a code effect or override queue dependencies.
 const normalized={task_id:task.id,edits:draft.edits,
   uses:draft.uses||[],architecture:draft.architecture.trim(),
   acceptance_plan:draft.acceptance_plan.trim(),
   comment_id:comment.id,comment_url:comment.html_url,
   comment_created_at:comment.created_at,
   proposal_source_sha:draft.proposal_source_sha,action_id:draft.action_id};
 return {...normalized,plan_hash:digest(normalized)};
}
export function selectScopePlans(comments,queue,state){
 const latest={};
 if(!Array.isArray(comments)||comments.length>100)throw Error('Unbounded GitHub scope plans');
 for(const c of comments){
   const x=parseScopePlanComment(c,queue,state);
   if(!x)continue;
   const prev=latest[x.task_id];
   if(!prev||x.comment_created_at>prev.comment_created_at||
      (x.comment_created_at===prev.comment_created_at&&x.comment_id>prev.comment_id))
     latest[x.task_id]=x;
 }
 // Even a PENDING owner decision is durable once the trusted dispatcher
 // verified and saved the source comment in the existing private owner notice.
 // Do not depend on the source issue comment remaining in the last page.
 for(const [key,notice] of Object.entries(state.owner_alerts||{})){
   const plan=notice.scope_plan;
   if(notice.kind!=='scope_plan_review'||!plan||
      !['planned','submitted'].includes(notice.status)||
      latest[notice.task_id]||plan.task_id!==notice.task_id||
      plan.plan_hash!==notice.source_sha||
      key!=='notice:'+noticeHash({kind:'scope_plan_review',
        task_id:notice.task_id,question:notice.question,
        source_sha:notice.source_sha}))continue;
   const task=queue.tasks.find(t=>t.id===plan.task_id);
   const rec=state.tasks?.[plan.task_id];
   if(task?.state!=='proposed'||!rec||
      plan.proposal_source_sha!==proposalSourceHash(task)||
      plan.action_id!==rec.proposal_action_id && !Object.values(state.actions||{})
        .some(a=>a.task_id===plan.task_id&&a.type?.startsWith('scope_plan')&&
          a.status==='submitted'&&a.proposal_source_sha===plan.proposal_source_sha))
     continue;
   latest[plan.task_id]=structuredClone(plan);
 }
 // An already signed exact scope is durable even when issue #411 grows.
 // New plans still require a real verified comment; this fallback applies
 // only to the original immutable owner-notice + owner-reply proof chain.
 for(const [id,scope] of Object.entries(state.scope_authorizations||{})){
   if(latest[id])continue;
   const task=queue.tasks.find(t=>t.id===id),rec=state.tasks?.[id];
   const notice=state.owner_alerts?.[scope.notice_id];
   const answer=rec?.owner_reply_events?.[scope.owner_event_id];
   if(task?.state!=='proposed'||!rec||scope.task_id!==id||
      scope.proposal_source_sha!==proposalSourceHash(task)||
      notice?.kind!=='scope_plan_review'||notice.task_id!==id||
      notice.source_sha!==scope.plan_hash||
      !['planned','submitted'].includes(notice.status)||
      answer?.courier!=='muse'||answer.target?.notice_id!==scope.notice_id||
      !yes(answer.text)||rec.scope_approval_hash!==digest(scope))continue;
   latest[id]={...scope,comment_id:scope.plan_comment_id,
     comment_url:scope.plan_comment_url,comment_created_at:scope.owner_approved_at,
     plan_hash:scope.plan_hash};
 }
 return latest;
}
const approvedScopeOverlap=(plan,queue,state)=>{
 const owner=new Map();
 for(const task of queue.tasks){
   if(task.id===plan.task_id)continue;
   for(const file of editableFiles(task)||[])owner.set(file,task.id);
 }
 for(const [id,scope] of Object.entries(state.scope_authorizations||{})){
   if(id===plan.task_id)continue;
   for(const file of scope.edits||[])owner.set(file,id);
 }
 return plan.edits.filter(f=>owner.has(f));
};

export function queueScopePlanReviews(state,queue,plans,{now=new Date().toISOString()}={}){
 const next=structuredClone(state);next.owner_alerts||={};
 for(const task of queue.tasks){
  const plan=plans?.[task.id];
  if(!plan)continue;
  const rec=next.tasks?.[task.id];
  if(!rec?.scope_plan_completed||!rec.planning_approved)continue;
  const conflicts=approvedScopeOverlap(plan,queue,next);
  for(const n of Object.values(next.owner_alerts))
   if(n.kind==='scope_plan_review'&&n.task_id===task.id&&
      n.status==='planned'&&(!plan||n.source_sha!==plan.plan_hash))
      n.status='cancelled_no_longer_needed';
  const message=conflicts.length
    ? 'Scope proposal for Task '+task.id+' has OWNERSHIP CONFLICTS ('+
       conflicts.join(', ')+'). Return to the planner; do not approve or edit overlapping files.'
    : 'Exact implementation scope for Task '+task.id+' is ready for your separate file/architecture decision. Files: '+
      'Full plan: '+plan.comment_url+'. Files: '+plan.edits.join(', ')+'. Architecture: '+plan.architecture.slice(0,220)+
      '. Acceptance plan: '+plan.acceptance_plan.slice(0,160)+
      '. Reply YES to approve THESE exact files via Muse, or request changes. Your original task-goal yes remains valid.';
  const question=message.slice(0,1100);
  const hash=noticeHash({kind:'scope_plan_review',task_id:task.id,
    source_sha:plan.plan_hash,question});
  const key='notice:'+hash;
  if(next.owner_alerts[key])continue;
  next.owner_alerts[key]={kind:'scope_plan_review',task_id:task.id,
   plan_hash:plan.plan_hash,plan_comment_id:plan.comment_id,
   source_sha:plan.plan_hash,notice_hash:hash,
   question,owner_message:question,
   recipient:'owner',delivery_owner:'muse',
   status:'planned',created_at:now,
   target_url:plan.comment_url||'https://github.com/'+settings.repo+'/issues/411',
   scope_plan:structuredClone(plan),
   ...(conflicts.length?{scope_conflicts:conflicts}:{}),
  };
 }
 return next;
}

// Only an authenticated Muse reply to the EXACT notice/version authorizes the
// proposed exact file list. Result lives in existing private ledger as a signed
// overlay to the immutable goal/brief. No GitHub comment alone ever signs code.
export function acceptScopePlanDecisions(state,queue,plans,{now=new Date().toISOString()}={}){
 const next=structuredClone(state);next.scope_authorizations||={};
 for(const task of queue.tasks){
   const plan=plans?.[task.id],rec=next.tasks?.[task.id];
   if(!plan||!rec?.scope_plan_completed)continue;
   const matches=Object.entries(next.owner_alerts||{}).filter(([_,n])=>
     n.kind==='scope_plan_review'&&n.task_id===task.id&&
     n.source_sha===plan.plan_hash&&
     !n.scope_conflicts?.length&&['planned','submitted'].includes(n.status));
   const [noticeId,notice]=matches.at(-1)||[];
   if(!noticeId)continue;
   const responses=Object.entries(rec.owner_reply_events||{})
     .filter(([_,r])=>r.courier==='muse'&&r.target?.notice_id===noticeId)
     .sort((a,b)=>(Date.parse(a[1].at||'')||0)-(Date.parse(b[1].at||'')||0)||
       a[0].localeCompare(b[0]));
   const [id,response]=responses.at(-1)||[];
   if(!response)continue;
   const prior=next.scope_authorizations[task.id];
   if(!yes(response.text)){
     // Later authenticated NO revokes an exact code scope before a verified
     // merge. Do not rewrite merged or integrated-proof history.
     if(prior?.notice_id===noticeId&&
        !['merged','integrated_proven','released_proven'].includes(rec.status)){
       delete next.scope_authorizations[task.id];
       rec.scope_approval_hash=null;
       rec.scope_revoked_event_id=id;
       rec.planning_approved=true;rec.approved=false;
       rec.status='blocked_needs_owner';
     }
     continue;
   }
   if(approvedScopeOverlap(plan,queue,next).length)continue;
   if(prior?.plan_hash===plan.plan_hash)continue;
   const scope={task_id:task.id,proposal_source_sha:plan.proposal_source_sha,
     plan_hash:plan.plan_hash,plan_comment_id:plan.comment_id,
     plan_comment_url:plan.comment_url,edits:plan.edits,uses:plan.uses,
     architecture:plan.architecture,acceptance_plan:plan.acceptance_plan,
     notice_id:noticeId,notice_hash:notice.notice_hash,
     owner_event_id:id,owner_approved_at:response.at||now};
   next.scope_authorizations[task.id]=scope;
   rec.scope_approval_hash=digest(scope);
   rec.scope_approval_event_id=id;
   rec.scope_approved_at=response.at||now;
   if(notice.status==='planned'){
     notice.status='submitted';notice.receipt={courier:'muse',
       notice_hash:notice.notice_hash,submitted_at:response.at||now,
       source:'authenticated_owner_reply'};
   }
 }
 return next;
}

// The existing dispatcher uses one effective queue. The signed overlay
// carries authenticated owner decision and exact task-plan comment identity.
// No new second queue, schedulers or approval artifacts are created.
export function effectiveSignedQueue(queue,state,plans={}){
 const tasks=queue.tasks.map(task=>{
  const signed=state.scope_authorizations?.[task.id];
  const observed=plans?.[task.id];
  if(task.state!=='proposed'||task.architecture_approval?.approved===true||
     !signed||!observed||signed.plan_hash!==observed.plan_hash||
     signed.plan_comment_id!==observed.comment_id||
     signed.proposal_source_sha!==proposalSourceHash(task)||
     signed.edits.length===0||
     state.tasks?.[task.id]?.scope_approval_hash!==digest(signed))
    return task;
  return {...task,edits:[...signed.edits],uses:[...signed.uses],
   exclusive_files:[...signed.edits],state:'architecture_approved',
   architecture_approval:{approved:true,source:'authenticated_muse_exact_scope',
     notice_id:signed.notice_id,owner_event_id:signed.owner_event_id,
     plan_comment_id:signed.plan_comment_id,
     plan_hash:signed.plan_hash}};
 });
 const result={...queue,tasks};
 validateQueue(result); // hard fail on two exclusive path owners
 return result;
}
