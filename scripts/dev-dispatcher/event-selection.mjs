// Event identity limits expensive per-PR reads; periodic full audit recovers lost events.
// This selector does not authorize actions or trust webhook text as a task decision.
import {settings} from './settings.mjs';
const number=n=>Number.isSafeInteger(n)&&n>0?n:null;
const minutes=setting=>Number.isInteger(setting)&&setting>=5&&setting<=1440?setting:30;
export function selectObservation({eventName,payload={},state={},now=Date.now(),
  auditMinutes=settings.dispatcher?.full_audit_minutes}={}) {
 const elapsed=now-Date.parse(state.last_full_audit_at||'');
 let fullAudit=!Number.isFinite(elapsed)||elapsed>=minutes(auditMinutes)*60000;
 const focus=new Set();
 const add=n=>{const id=number(n);if(id)focus.add(id);};
 switch(eventName){
 case 'push': case 'workflow_dispatch': fullAudit=true;break;
 case 'issue_comment': add(payload.issue?.number);break;
 case 'pull_request_review': add(payload.pull_request?.number);break;
 case 'pull_request': add(payload.pull_request?.number);break;
 case 'workflow_run': {
   const run=payload.workflow_run;
   if(run?.event!=='pull_request'){fullAudit=true;break;}
   for(const p of run?.pull_requests||[])add(p.number);
   if(!focus.size&&/^[a-f0-9]{40}$/.test(run?.head_sha||'')){
     for(const rec of Object.values(state.tasks||{}))
       if(rec.head_sha===run.head_sha)add(rec.pr_number);
   }
   if(!focus.size)fullAudit=true;
   break;
 }
 case 'repository_dispatch': add(payload.client_payload?.pr_number);break;
 case 'schedule':break;
 default:fullAudit=true;
 }
 return {fullAudit,focusNumbers:[...focus]};
}
export function canReusePr(pr,old,mainSha,focusNumbers=[],fullAudit=false){
 return !fullAudit && old?.github_state==='open' &&
   !focusNumbers.includes(pr.number)&&old.pr_number===pr.number &&
   old.head_sha===pr.head?.sha && old.base_sha===pr.base?.sha &&
   old.main_sha===mainSha && old.draft===pr.draft &&
   old.last_github_activity===pr.updated_at &&
   old.same_repo===true;
}
