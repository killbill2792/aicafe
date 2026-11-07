// Durable owner-attention notices in the SAME private dispatcher ledger.
// Muse delivers these later; GitHub never sends owner messages directly.
import {createHash} from 'node:crypto';
import {architectureFoundationReady} from './core.mjs';
import {validConversationUrl} from './delivery.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function noticeHash({kind,task_id,pr_number,question,source_sha}){
 const identity=[kind,task_id||null,pr_number||null,question];
 // Version-bound owner review: an edited/newly merged architecture is a NEW notice.
 if(kind==='architecture_approval')identity.push(source_sha||null);
 return sha(JSON.stringify(identity));
}
export function queueOwnerAlerts(state,{unmappedPrs=[],queue=null,now=new Date().toISOString()}={}){
 const next=structuredClone(state);
 next.owner_alerts ||= {};
 const add=(kind,task_id,pr_number,question,source_sha=null)=>{
  if(typeof question!=='string'||!question.trim()||question.length>1200)return;
  if(pr_number!=null&&(!Number.isInteger(pr_number)||pr_number<1))return;
  const entry={kind,task_id:task_id||null,pr_number:pr_number||null,
   question:question.trim(),delivery_owner:'muse',status:'planned',created_at:now};
  if(kind==='architecture_approval')entry.source_sha=source_sha;
  entry.notice_hash=noticeHash(entry);
  const key='notice:'+entry.notice_hash;
  const prior=next.owner_alerts[key];
  if(!prior) next.owner_alerts[key]=entry;
  else if(prior.status==='cancelled_no_longer_needed' && !prior.receipt) {
    // A withdrawn question may later be restored verbatim. Requeue the SAME
    // verified identity, never a duplicate; submitted notices are immutable.
    prior.status='planned';
    prior.requeued_at=now;
  }
 };
 for(const [id,rec] of Object.entries(next.tasks||{})){
  // One open PR may have only one active owner question. A revised or removed
  // question supersedes an UNSENT notice; an acknowledged notice remains audit
  // history but never authorizes an owner decision or downstream implementation.
  const question=rec.owner_question || rec.github_owner_question;
  const previous=Object.values(next.owner_alerts).filter(n=>
    n.kind==='owner_decision' && n.task_id===id &&
    n.pr_number===(rec.pr_number||null));
  if(question) {
   const detail='PR #'+(rec.pr_number||'not opened')+': '+question;
   const chat=rec.agent==='chatgpt' && validConversationUrl('chatgpt',rec.conversation_ref)
     ? ' Your approval is needed. ChatGPT chat: '+rec.conversation_ref : '';
   const desired=detail+chat;
   // A submitted notification of this SAME question is sufficient even if
   // the chat URL was enriched afterward. An edited question is a new decision.
   const acknowledged=previous.some(n=>n.status==='submitted' &&
     (n.question===detail ||
      n.question.startsWith(detail+' Your approval is needed. ChatGPT chat: ')));
   for(const prior of previous)
     if(prior.status==='planned' && prior.question!==desired)
       prior.status='cancelled_no_longer_needed';
   if(!acknowledged) add('owner_decision',id,rec.pr_number,desired);
  } else {
   // The coder removed the explicit question or label: do not deliver it
   // after it has been withdrawn, even if no new PR commit occurred.
   for(const prior of previous)
     if(prior.status==='planned') prior.status='cancelled_no_longer_needed';
  }
  if(rec.agent==='claude'&&rec.blocker?.confirmed===true &&
     ['usage_limit','confirmed_blocker'].includes(rec.blocker.kind))
   add('claude_blocker',id,rec.pr_number,
    'Claude task '+id+' blocked ('+rec.blocker.kind+'): '+String(rec.blocker.detail||'Confirmed blocker'));
 }
 // Architecture acceptance is a separate owner decision after the audit is
 // merged and integration-proven. Do not invent a ChatGPT URL from branch/PR.
 const foundation=queue?.dispatch_rules?.architecture_foundation_proof_task;
 if(foundation) {
  const rec=next.tasks?.[foundation];
  const awaitingReview=['integrated_proven','released_proven'].includes(rec?.status) &&
    !architectureFoundationReady(queue,next.tasks) && /^[a-f0-9]{40}$/.test(rec?.merge_sha||'');
  const chat=rec?.agent==='chatgpt' && validConversationUrl('chatgpt',rec?.conversation_ref)
    ? rec.conversation_ref : null;
  const message=chat ? 'Your approval is needed. ChatGPT chat: '+chat : null;
  // Revoke unsent, obsolete review notices after approval or a new revision.
  for(const notice of Object.values(next.owner_alerts)) {
   if(notice.kind!=='architecture_approval'||notice.task_id!==foundation||
      notice.status!=='planned')continue;
   if(!awaitingReview||notice.source_sha!==rec.merge_sha||notice.question!==message)
    notice.status='cancelled_no_longer_needed';
  }
  if(awaitingReview && message)
   add('architecture_approval',foundation,rec.pr_number,message,rec.merge_sha);
 }
 for(const pr of unmappedPrs)
  add('unmapped_pr',null,pr,'Identify the approved task and existing coding conversation for PR #'+pr+'. Do not guess ownership.');
 return next;
}
export function acceptOwnerNoticeReceipt(state,receipt,{authenticatedCourier}={}){
 if(authenticatedCourier!=='muse')throw Error('Only authenticated Muse may acknowledge owner notices');
 if(receipt?.kind!=='owner_notice'||typeof receipt.notice_id!=='string'||
    receipt.status!=='submitted')throw Error('Invalid owner notice receipt');
 const next=structuredClone(state);
 const notice=next.owner_alerts?.[receipt.notice_id];
 if(!notice||notice.status!=='planned'||notice.delivery_owner!=='muse'||
    notice.notice_hash!==receipt.notice_hash)throw Error('Unapproved owner notice receipt');
 notice.status='submitted';
 notice.receipt={courier:'muse',notice_hash:notice.notice_hash,submitted_at:receipt.submitted_at||new Date().toISOString()};
 return next;
}
