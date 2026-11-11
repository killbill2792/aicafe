import {settings} from './settings.mjs';
// Durable owner-attention notices in the SAME private dispatcher ledger.
// Muse delivers these later; GitHub never sends owner messages directly.
import {createHash} from 'node:crypto';
import {architectureFoundationReady,approved} from './core.mjs';
import {approvalSignature} from './delivery.mjs';
import {validConversationUrl} from './delivery.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function noticeHash({kind,task_id,pr_number,question,source_sha,identity:operationalIdentity}){
 // Operational alerts are deduped by verified issue identity, not by a
 // human-readable message. This must match queueOwnerIssue's hash.
 if(operationalIdentity!==undefined)
  return sha(JSON.stringify([kind,task_id||null,pr_number||null,operationalIdentity]));
 const identity=[kind,task_id||null,pr_number||null,question];
 // Version-bound owner review: an edited/newly merged architecture is a NEW notice.
 if(['architecture_approval','next_task_start'].includes(kind))identity.push(source_sha||null);
 if(kind==='next_task_start')return sha(JSON.stringify([kind,task_id,source_sha]));
 return sha(JSON.stringify(identity));
}
// Prior priority deferral never suppresses a newly eligible owner's start ask.
export function startTaskReady(task,state,queue){
 const rec=state.tasks?.[task?.id],gate=queue?.dispatch_rules?.priority_gate_task;
 if(!rec||!approved(task)||rec.pr_number||rec.conversation_ref||
    ['assigned','draft_open','review_fixing'].includes(rec.status)||
    !(rec.approved===false||rec.status==='blocked_needs_owner'||rec.priority_deferred)||
    (gate&&!['integrated_proven','released_proven'].includes(state.tasks?.[gate]?.status)))
   return false;
 return (task.depends_on||[]).every(id=>{
   const dep=state.tasks?.[id];
   if(['integrated_proven','released_proven'].includes(dep?.status))return true;
   const plan=queue.tasks.find(t=>t.id===id);
   return dep?.status==='merged'&&dep.github_state==='merged'&&
     /^[a-f0-9]{40}$/.test(dep.merge_sha||'')&&
     (dep.proof_required===false||plan?.test_kinds?.includes('read_only_audit'));
 });
}
export function applyOwnerStartApprovals(state,queue){
 const next=structuredClone(state);
 for(const task of queue.tasks){
  if(!startTaskReady(task,next,queue))continue;
  const hash=approvalSignature(task),id='notice:'+noticeHash({
    kind:'next_task_start',task_id:task.id,source_sha:hash});
  const notice=next.owner_alerts?.[id];
  if(!notice||!['planned','submitted'].includes(notice.status)||
     notice.source_sha!==hash)continue;
  const replies=Object.values(next.tasks[task.id].owner_reply_events||{})
    .filter(event=>event.courier==='muse'&&event.target?.notice_id===id)
    .sort((a,b)=>(Date.parse(a.at||'')||0)-(Date.parse(b.at||'')||0));
  // A newer authenticated "no" must not be overridden by an older "yes".
  const reply=replies.at(-1);
  if(!reply||!/^yes(?: to start)?[.!]?$/i.test(reply.text))continue;
  // An authenticated, hash-bound owner answer proves the question was received.
  // Never require a second courier acknowledgement to release the SAME decision.
  // Retain an independently authenticated notice receipt when one already exists.
  if(notice.status==='planned'){
    notice.status='submitted';
    notice.receipt={courier:'muse',notice_hash:notice.notice_hash,
      submitted_at:reply.at||new Date().toISOString(),source:'authenticated_owner_reply'};
  }
  Object.assign(next.tasks[task.id],{approved:true,status:'proposed',
    priority_deferred:false,approval_hash:hash,approval_signature_version:3});
 }
 return next;
}
// Re-publish an opaque Muse hint every retry interval until a valid notice
// receipt or its authenticated owner answer is reconciled. No browser resend here.
export function wakePendingOwnerNotices(state,nowMs,intervalMs=900000){
  for(const [key,notice] of Object.entries(state.owner_alerts||{})){
    if(notice.status!=='planned'||notice.delivery_owner!=='muse'||
       key!=='notice:'+notice.notice_hash)continue;
    const since=Date.parse(notice.last_wake_at||notice.created_at||'');
    if(!Number.isFinite(since)||nowMs-since<intervalMs)continue;
    notice.last_wake_at=new Date(nowMs).toISOString();
    notice.wake_round=(notice.wake_round||0)+1;
  }
  return state;
}
export function queueOwnerIssue(state,{kind,task_id=null,pr_number=null,identity='',message,needs='investigation'}){
 const next=structuredClone(state);next.owner_alerts||={};
 if(typeof message!=='string'||!message.trim())return next;
 const hash=sha(JSON.stringify([kind,task_id,pr_number,identity]));
 const key='notice:'+hash,now=new Date().toISOString();
 const old=next.owner_alerts[key];
 if(old&&old.status!=='resolved'&&old.status!=='cancelled_no_longer_needed'){
  // Backfill historic notices so the opaque Muse signal can wake for them.
  if(!Object.hasOwn(old,'identity'))old.identity=identity;
  return next;
 }
 next.owner_alerts[key]={kind,task_id,pr_number,identity,notice_hash:hash,
  question:message.slice(0,1000)+' Needed: '+needs,recipient:'owner',
  delivery_owner:'muse',status:'planned',created_at:now,
  target_url:pr_number?'https://github.com/'+settings.repo+'/pull/'+pr_number:
   'https://github.com/'+settings.repo,
  owner_message:message.slice(0,1000)+' Needed: '+needs};
 return next;
}
// Retire only the precise operational incident. Multiple tasks/actions can
// share a PR; a receipt recovery must never close their unrelated notices.
export function resolveOwnerIssueIdentity(state,{kind,task_id=null,pr_number=null,identity}){
 const next=structuredClone(state);
 const key='notice:'+noticeHash({kind,task_id,pr_number,identity});
 const notice=next.owner_alerts?.[key];
 if(notice?.status==='planned'){
  notice.status='resolved';
  notice.resolved_at=new Date().toISOString();
 }
 return next;
}
export function resolveOwnerIssue(state,kind,pr_number){
 const next=structuredClone(state);
 for(const n of Object.values(next.owner_alerts||{}))
  if(n.kind===kind&&n.pr_number===pr_number&&n.status!=='resolved'){
   n.status='resolved';n.resolved_at=new Date().toISOString();
  }
 return next;
}
export function queueOwnerAlerts(state,{unmappedPrs=null,openPrs=[],queue=null,now=new Date().toISOString()}={}){
 const next=structuredClone(state);
 next.owner_alerts ||= {};
 const ownerKinds=new Set(['owner_decision','architecture_approval','owner_sensitive_hold','go_live','approval_hash','next_task_start','missing_chat_link','dispatcher_issue']);
 const route=entry=>{
  // An operational failure was explicitly addressed to the owner; do
  // not downgrade it to a referee notice on the next reconciliation.
  entry.recipient=['owner','referee'].includes(entry.recipient)
    ? entry.recipient : ownerKinds.has(entry.kind)?'owner':'referee';
  if(entry.recipient==='owner'){
   entry.target_url=entry.pr_number
    ?'https://github.com/'+settings.repo+'/pull/'+entry.pr_number
    :'https://github.com/'+settings.repo+'/blob/main/'+settings.queue.path;
   entry.owner_message=(entry.target_url+' — '+entry.question).slice(0,1200);
  }
  return entry;
 };
 // Preserve historical notice identity and submitted status. Do not re-send.
 for(const notice of Object.values(next.owner_alerts))route(notice);
 const add=(kind,task_id,pr_number,question,source_sha=null)=>{
  if(typeof question!=='string'||!question.trim()||question.length>1200)return;
  if(pr_number!=null&&(!Number.isInteger(pr_number)||pr_number<1))return;
  const entry={kind,task_id:task_id||null,pr_number:pr_number||null,
   question:question.trim(),recipient:ownerKinds.has(kind)?'owner':'referee',
   delivery_owner:'muse',status:'planned',created_at:now};
  if(['architecture_approval','next_task_start'].includes(kind))entry.source_sha=source_sha;
  route(entry);
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
  // Withdraw only UNSENT safety notices when actual facts changed. Submitted
  // notices remain immutable audit records, never proof of a current defect.
  for(const prior of Object.values(next.owner_alerts)) {
    if(prior.task_id!==id || prior.status!=='planned') continue;
    if((prior.kind==='wrong_repo' && !rec.repo_mismatch) ||
       (prior.kind==='repeated_stall' && !rec.stall_escalate) ||
       (prior.kind==='connector_403' && !rec.connector_403) ||
       (prior.kind==='codex_watchdog' && rec.codex_referee_sha!==rec.head_sha))
      prior.status='cancelled_no_longer_needed';
  }
  // One open PR may have only one active owner question. A revised or removed
  // question supersedes an UNSENT notice; an acknowledged notice remains audit
  // history but never authorizes an owner decision or downstream implementation.
  const question=rec.owner_question || rec.github_owner_question;
  const previous=Object.values(next.owner_alerts).filter(n=>
    n.kind==='owner_decision' && n.task_id===id &&
    n.pr_number===(rec.pr_number||null));
  if(question) {
   const source=rec.github_owner_question_url;
   const detail='PR #'+(rec.pr_number||'not opened')+': '+question+
     (typeof source==='string' && /^https:\/\/github\.com\/[^\s]+$/.test(source)
       ? ' Source: '+source : '');
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
  const base='https://github.com/'+settings.repo;
  const target=Number.isInteger(rec.pr_number)
    ? base+'/pull/'+rec.pr_number
    : base+'/blob/main/'+settings.queue.path;
  if(rec.sensitive_owner_block===true || rec.owner_directive==='go_live' ||
      rec.owner_directive==='hold')
    add(rec.owner_directive==='go_live'?'go_live':'owner_sensitive_hold',
      id,rec.pr_number,'Owner decision for '+id+': '+target+
      ' — '+(rec.owner_directive==='go_live'?'Go-live instruction requires owner authorization':
        rec.owner_directive==='hold'?'Owner requested hold':
        'Paid/live/prod/secret scope requires owner approval'));
  const task=queue?.tasks?.find(t=>t.id===id);
  const ready=task&&startTaskReady(task,next,queue);
  if(ready)add('next_task_start',id,rec.pr_number,
    id+' / '+(task.title||id)+' is ready to start: '+
    String(task.goal||'Begin approved work').replace(/\s+/g,' ').slice(0,180)+
    '. Reply yes to start.',approvalSignature(task));
  if(rec.status==='blocked_needs_owner' && rec.approved===false &&
     !rec.priority_deferred && (!task || rec.pr_number))
    add('approval_hash',id,rec.pr_number,
      'Owner approval needed for '+id+': '+target+' — signed goal/scope/acceptance differs');
  for(const notice of Object.values(next.owner_alerts))
    if(notice.kind==='next_task_start'&&notice.task_id===id&&
       notice.status==='planned'&&(!ready||notice.source_sha!==approvalSignature(task)))
      notice.status='cancelled_no_longer_needed';
  if(rec.repo_mismatch)
   add('wrong_repo',id,rec.pr_number,'Task '+id+' belongs to '+rec.repo_mismatch.expected+
     ' but PR #'+rec.pr_number+' is in '+rec.repo_mismatch.actual+'. Correct the task-to-repo dispatch; do not use PR body as authority.');
  if(rec.stall_escalate)
   add('repeated_stall',id,rec.pr_number,'PR #'+rec.pr_number+' still stuck after one 20-minute Muse nudge on head '+rec.head_sha+
     '. Owner intervention required; no repeated coding nudge.');
  if(rec.codex_referee_sha && rec.codex_referee_sha===rec.head_sha)
   add('codex_watchdog',id,rec.pr_number,
     'Referee: Codex gave no review or reaction after one request for PR #'+
     rec.pr_number+' on head '+rec.head_sha+'. Do not re-request unchanged code.');
  if(rec.connector_403) {
   const assigned=queue?.tasks?.find(t=>t.id===id);
   const expected=rec.repo_mismatch?.expected || assigned?.repository || assigned?.repo ||
     rec.repository || rec.repo || 'killbill2792/aicafe';
   add('connector_403',id,rec.pr_number,'ChatGPT Codex Connector likely missing repo '+expected);
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
  const awaitingReview=['merged','integrated_proven','released_proven'].includes(rec?.status) &&
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
 // Only a fresh GitHub open-PR snapshot may retire prior unmapped alerts.
 // The second notice pass in run.mjs deliberately lacks a snapshot and must
 // not cancel current notices just because no list was supplied.
 if (Array.isArray(unmappedPrs)) {
  const active=new Set(unmappedPrs);
  for(const notice of Object.values(next.owner_alerts)) {
   if(notice.kind==='unmapped_pr' && notice.status==='planned' &&
      !active.has(notice.pr_number))
    notice.status='cancelled_no_longer_needed';
  }
  for(const n of unmappedPrs){
    const pr=openPrs.find(x=>x.pr_number===n);
    if(!pr){add('unmapped_pr',null,n,'Identify the approved task and existing coding conversation for PR #'+n+'. Do not guess ownership.');continue;}
    const chat=next.branch_chat_links?.[pr.branch]?.conversation_url||pr.chat_marker||
      next.pr_chat_links?.[String(n)]?.conversation_url;
    if(!chat){
      const changed=queueOwnerIssue(next,{kind:'missing_chat_link',pr_number:n,
        identity:pr.branch,message:'PR #'+n+' on branch '+pr.branch+
         ' titled '+pr.title+' has no chat. Paste its chat URL or tell Muse to register it.',
        needs:'A verified ChatGPT conversation URL'});
      next.owner_alerts=changed.owner_alerts;
    }else{
      const resolved=resolveOwnerIssue(next,'missing_chat_link',n);next.owner_alerts=resolved.owner_alerts;
    }
   }
 }
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
