// Verified GitHub plan comment -> version-bound Muse owner question -> signed exact scope.
// Planner comments are never authoritative approvals.
import {createHash} from 'node:crypto';
import {settings} from './settings.mjs';
import {noticeHash} from './alerts.mjs';
import {approvalSignature} from './delivery.mjs';
import {proposalSourceHash} from './proposal-stage.mjs';
import {validateQueue} from './core.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const yes=x=>/^yes(?:[.!]|(?:\s+to\s+(?:start|proceed))[.!]?)?$/i.test(String(x||'').trim());
const pathOK=x=>typeof x==='string'&&x.length<221&&x.length>0&&
 /^[a-zA-Z0-9_.\/-]+$/.test(x)&&!x.startsWith('/')&&!x.endsWith('/')&&
 !x.split('/').includes('..')&&!x.split('/').includes('.');
const filesOK=a=>Array.isArray(a)&&a.length>0&&a.length<=35&&
 a.every(pathOK)&&new Set(a).size===a.length;
const textOK=x=>typeof x==='string'&&x.trim().length>=8&&x.length<=1200;
const marker='<!-- aicafe-scope-contract:v1 -->\n';

export function parseScopeContract(comment){
 if(comment?.user?.login!==settings.owner.login||
    comment.author_association!=='OWNER'||!Number.isSafeInteger(comment.id)||
    typeof comment.body!=='string'||comment.body.length>12000||
    !comment.body.startsWith(marker))return null;
 const match=comment.body.slice(marker.length).match(new RegExp(
   '^\\x60{3}json\\n([\\s\\S]{30,9000}?)\\n\\x60{3}\\s*$'));
 if(!match)return null;
 let d;try{d=JSON.parse(match[1]);}catch{return null;}
 if(!d||d.version!==1||d.kind!=='scope_contract'||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(d.task_id||'')||
    !/^scope_plan(?:_update)?:[a-zA-Z0-9%_-]+:notice:[a-f0-9]{64}$/.test(d.action_id||'')||
    !/^[a-f0-9]{64}$/.test(d.proposal_source_sha||'')||
    !filesOK(d.exclusive_files)||!textOK(d.architecture)||
    !textOK(d.source_contract)||!textOK(d.change_behavior)||
    !textOK(d.gaps)||!Array.isArray(d.acceptance)||d.acceptance.length<1||
    d.acceptance.length>25||!d.acceptance.every(textOK)||
    (d.uses!=null&&(!Array.isArray(d.uses)||d.uses.length>40||
      !d.uses.every(pathOK)||new Set(d.uses).size!==d.uses.length)))
   return null;
 const link='https://github.com/'+settings.repo+'/issues/'+
   settings.owner.dashboard_issue+'#issuecomment-'+comment.id;
 return {task_id:d.task_id,action_id:d.action_id,
   proposal_source_sha:d.proposal_source_sha,comment_id:comment.id,
   url:link,comment_at:comment.created_at,
   exclusive_files:d.exclusive_files,uses:d.uses||[],
   acceptance:d.acceptance,architecture:d.architecture,
   source_contract:d.source_contract,change_behavior:d.change_behavior,
   gaps:d.gaps,plan_hash:hash([comment.id,d])};
}

function taskWithScope(task,rec){
 const a=rec?.scope_authorization;
 if(!a||a.proposal_source_sha!==proposalSourceHash(task)||
    !filesOK(a.exclusive_files)||!a.notice_id||
    !/^[a-f0-9]{64}$/.test(a.plan_hash||''))return task;
 return {...task,state:'architecture_approved',
  architecture_approval:{approved:true,owner_review_url:a.url,
    scope_authorization_ref:a.notice_id},
  exclusive_files:[...a.exclusive_files],edits:[...a.exclusive_files],
  uses:[...a.uses],acceptance:[...a.acceptance]};
}
export function effectiveScopeQueue(queue,state){
 const effective={...queue,tasks:queue.tasks.map(t=>taskWithScope(t,state.tasks?.[t.id]))};
 validateQueue(effective); // Existing ownership, dependency and file rules.
 return effective;
}

export function reconcileScopeContracts(state,queue,comments=[],{now=new Date().toISOString()}={}){
 const next=structuredClone(state);
 next.owner_alerts||={};next.tasks||={};
 const parsed=(Array.isArray(comments)?comments:[]).map(parseScopeContract)
   .filter(Boolean).sort((a,b)=>a.comment_id-b.comment_id);
 for(const plan of parsed){
   const task=queue.tasks.find(t=>t.id===plan.task_id), rec=next.tasks[plan.task_id];
   if(!task||task.state!=='proposed'||task.architecture_approval?.approved===true||
      !rec||rec.pr_number||!rec.scope_plan_completed||
      rec.proposal_source_sha!==plan.proposal_source_sha||
      plan.proposal_source_sha!==proposalSourceHash(task))continue;
   const action=next.actions?.[plan.action_id];
   if(!action||!['scope_plan','scope_plan_update'].includes(action.type)||
      action.task_id!==plan.task_id||action.status!=='submitted'||
      action.proposal_source_sha!==plan.proposal_source_sha||
      action.receipt?.courier!=='muse'||rec.scope_authorization)continue;
   const question='Exact coding scope proposed for task '+plan.task_id+
     ': '+plan.exclusive_files.join(', ').slice(0,345)+
     '. Architecture: '+plan.architecture.slice(0,160)+
     '. Acceptance: '+plan.acceptance.join('; ').slice(0,210)+
     '. Full GitHub plan: '+plan.url+
     '. Reply YES through Muse to approve ONLY these files and acceptance; or request changes.';
   const source_sha=plan.plan_hash;
   const h=noticeHash({kind:'scope_plan_review',task_id:plan.task_id,question,source_sha});
   const key='notice:'+h;
   for(const [id,n] of Object.entries(next.owner_alerts))
     if(id!==key&&n.kind==='scope_plan_review'&&n.task_id===plan.task_id&&
       n.status==='planned')n.status='cancelled_no_longer_needed';
   next.owner_alerts[key]??={
     kind:'scope_plan_review',task_id:plan.task_id,pr_number:null,question,
     source_sha,notice_hash:h,status:'planned',recipient:'owner',
     delivery_owner:'muse',created_at:now,plan};
 }
 for(const [id,rec] of Object.entries(next.tasks)){
   if(rec.scope_authorization)continue;
   const replies=Object.entries(rec.owner_reply_events||{})
     .flatMap(([event_id,e])=>{
       const n=next.owner_alerts[e.target?.notice_id];
       return e.courier==='muse'&&n?.kind==='scope_plan_review'&&
         n.task_id===id&&['submitted','planned'].includes(n.status)&&
         n.plan?.proposal_source_sha===rec.proposal_source_sha
           ? [{event_id,e,notice:n}]:[];
     }).sort((a,b)=>(Date.parse(a.e.at||'')||0)-(Date.parse(b.e.at||'')||0)||
       a.event_id.localeCompare(b.event_id));
   const last=replies.at(-1);
   if(!last||!yes(last.e.text))continue;
   const {notice,e,event_id}=last,plan=notice.plan;
   const task=queue.tasks.find(t=>t.id===id);
   if(!task||task.state!=='proposed'||
      plan.proposal_source_sha!==proposalSourceHash(task))continue;
   const authorization={task_id:id,proposal_source_sha:plan.proposal_source_sha,
     notice_id:e.target.notice_id,plan_hash:plan.plan_hash,comment_id:plan.comment_id,
     url:plan.url,exclusive_files:plan.exclusive_files,uses:plan.uses,
     acceptance:plan.acceptance,owner_event_id:event_id,owner_at:e.at};
   const tentative=structuredClone(next);
   tentative.tasks[id].scope_authorization=authorization;
   try{effectiveScopeQueue(queue,tentative);}catch{
     const question='Plan file ownership conflicts with an approved scope: '+plan.url+
       '. Ask planner to revise; do not release coding.';
     const h=noticeHash({kind:'scope_plan_conflict',task_id:id,
       question,source_sha:plan.plan_hash}),key='notice:'+h;
     next.owner_alerts[key]??={kind:'scope_plan_conflict',task_id:id,
       question,source_sha:plan.plan_hash,notice_hash:h,
       status:'planned',recipient:'owner',delivery_owner:'muse',created_at:now};
     continue;
   }
   rec.scope_authorization=authorization;
   rec.planning_approved=false;rec.approved=true;rec.status='proposed';
   rec.scope_plan_completed=true; // Reuse the same planning chat.
   rec.approval_hash=approvalSignature(taskWithScope(task,rec));
   if(notice.status==='planned'){
     notice.status='submitted';notice.receipt={
       courier:'muse',source:'authenticated_owner_reply',
       notice_hash:notice.notice_hash,submitted_at:e.at||now};
   }
 }
 return {state:next,queue:effectiveScopeQueue(queue,next)};
}
