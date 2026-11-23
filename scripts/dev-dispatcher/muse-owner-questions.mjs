// Local communication records, not an approval or execution authority.
import {readFileSync,writeFileSync,renameSync,unlinkSync,mkdirSync,openSync,closeSync,existsSync,statSync,writeSync,fsyncSync} from 'node:fs';
import {dirname} from 'node:path';
import {validChatUrl} from './muse-local-notes.mjs';
import {randomBytes} from 'node:crypto';

const text=(v,max=2000)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
const idValid=id=>typeof id==='string'&&/^comment-[1-9]\d{0,19}$/.test(id);
export function readMuseQuestions(path){
 if(!existsSync(path))return {version:1,entries:{}};
 const state=JSON.parse(readFileSync(path,'utf8'));
 if(state?.version!==1||!state.entries||typeof state.entries!=='object'||Array.isArray(state.entries))
  throw Error('Invalid local owner-question records');
 return state;
}
const transactionLeaseMs=15*60*1000;
function alive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return null;
 try{process.kill(pid,0);return true;}
 catch(e){return e?.code==='ESRCH'?false:true;}
}
function openTransactionLock(path){
 const lock=path+'.lock';
 let fd;
 try{fd=openSync(lock,'wx',0o600);}
 catch(e){
  if(e?.code!=='EEXIST')throw e;
  let stat,old;
  try{
   stat=statSync(lock);
   try{old=JSON.parse(readFileSync(lock,'utf8'));}catch{}
  }catch{throw Error('Question write lock unavailable; retry after current writer');}
  // Fail closed for an active writer. A dead PID or an aged legacy lock
  // can be reclaimed; a new write always re-reads the authoritative JSON.
  const dead=alive(old?.pid)===false;
  if(!dead&&Date.now()-stat.mtimeMs<=transactionLeaseMs)
   throw Error('Question write lock held by another process');
  try{
   const same=statSync(lock);
   if(same.ino!==stat.ino||same.dev!==stat.dev||same.mtimeMs!==stat.mtimeMs)
    throw Error('Question lock replaced by concurrent writer');
   unlinkSync(lock);
   fd=openSync(lock,'wx',0o600);
  }catch{throw Error('Question write lock recovery unavailable; retry');}
 }
 try{
  const data=Buffer.from(JSON.stringify({pid:process.pid,created_at:new Date().toISOString()})+'\n');
  writeSync(fd,data,0,data.length,0);fsyncSync(fd);
  return fd;
 }catch(e){
  closeSync(fd);
  try{unlinkSync(lock);}catch{}
  throw e;
 }
}
function transact(path,fn){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const lock=path+'.lock',fd=openTransactionLock(path);
 try{
  const next=fn(readMuseQuestions(path)),tmp=path+'.tmp-'+process.pid+'-'+randomBytes(6).toString('hex');
  let tmpFd;
  try{
   // This file is the write-ahead "uncertain" journal for GitHub comments.
   // Atomic rename alone is NOT crash-durable: flush the bytes, rename,
   // then flush the containing directory before allowing a network POST.
   tmpFd=openSync(tmp,'wx',0o600);
   writeFileSync(tmpFd,JSON.stringify(next,null,2)+'\n');
   fsyncSync(tmpFd);
   closeSync(tmpFd);tmpFd=undefined;
   renameSync(tmp,path);
   const dirFd=openSync(dirname(path),'r');
   try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
  }catch(e){
   if(tmpFd!==undefined)try{closeSync(tmpFd);}catch{}
   try{unlinkSync(tmp);}catch{}
   // Fail closed on failed fsync: even if rename occurred, never claim a
   // durable send state or begin the GitHub POST on this error.
   throw e;
  }
  return next;
 }finally{closeSync(fd);unlinkSync(lock);}
}
export function importMuseQuestions(state,facts,now=new Date().toISOString()){
 const next=structuredClone(state);
 if(facts?.version!==1||!Array.isArray(facts.prs))return next;
 // Missing, edited, closed or deleted GitHub records do not answer a request.
 for(const p of [...(facts.prs||[]),...(facts.merged_prs||[])]){
  for(const q of p.owner_requests||[]){
   if(!idValid(q.id)||q.pr_number!==p.number||!text(q.question)||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(p.url||'')||
    !/^[a-f0-9]{40}$/.test(q.head_sha||'')||
    !q.url?.startsWith(p.url+'#issuecomment-')||q.url.split('#issuecomment-')[1]!==q.id.slice(8))continue;
   const old=next.entries[q.id];
   const disposition=q.disposition||'needs_review';
   const settled=['historical_after_merge','duplicate_reported'].includes(disposition)?'archived':
    ['resolved_reported','superseded_reported'].includes(disposition)?'resolved_reported':null;
   if(!old){
    next.entries[q.id]={...q,status:settled||'open',revision:1,imported_at:now,history:[],
     ...(settled?{closure:'GitHub reported '+disposition+'; no owner authorization inferred'}:{})};
   }else{
    if((old.question!==q.question||
       (old.source==='marked'&&q.source==='marked'&&old.head_sha!==q.head_sha)||
       old.pr_number!==q.pr_number)&&!old.source_changed){
     old.source_changed=true;old.revision++;old.history.push({at:now,actor:'collector',event:'source_changed'});
    }
    if(!old.classification&&q.classification)old.classification=q.classification;
    if(!old.source&&q.source)old.source=q.source;
    // Source reconciliation never invents approval or overwrites a local answer.
    if(settled&&old.status==='open'&&!old.source_changed&&!old.manually_reopened){
     old.status=settled;old.closure='GitHub reported '+disposition+'; no owner authorization inferred';
     old.revision++;old.history.push({at:now,actor:'collector',event:disposition});
    }
   }
  }
  // PR comments are the portable coordination history. Do not overwrite a
  // newer local decision while its own receipt is still awaiting confirmation.
  const seq=e=>Number(e.sequence??e.event_id?.match(/-r([1-9]\d*)/)?.[1]);
  const ordered=[...(p.ack_events||[])].sort((a,b)=>seq(a)-seq(b)||a.comment_id-b.comment_id);
  for(const event of ordered){
   const q=next.entries[event.question_id],sequence=seq(event);
   if(!q||q.pr_number!==p.number||q.source_changed||
      !Number.isSafeInteger(event.comment_id)||event.comment_id<=0||
      !Number.isSafeInteger(sequence)||sequence<1||
      sequence<(q.last_github_sequence||0)||
      (sequence===(q.last_github_sequence||0)&&
       q.last_github_comment_id>=event.comment_id))continue;
   if(q.github_sync?.event_id===event.event_id&&q.github_sync.state===event.state){
    q.github_sync={...q.github_sync,status:'verified',url:event.url};
    q.last_github_sequence=sequence;
    q.last_github_comment_id=event.comment_id;
    continue;
   }
   // A newer local decision is authoritative even when GitHub write access is absent.
   if(q.github_sync&&['pending','no_token','blocked_auth','uncertain','published_unverified'].includes(q.github_sync.status)){
    q.github_sync_conflict={event_id:event.event_id,url:event.url};
    continue;
   }
   if(sequence===(q.last_github_sequence||0)&&
      q.github_sync?.event_id!==event.event_id){
    q.github_sync_conflict={event_id:event.event_id,url:event.url};
    continue;
   }
   const status={acknowledged:'acknowledged',answered:'answered',
    delivery_uncertain:'delivery_uncertain',delivered:'delivered',
    ignored:'ignored',resolved:'closed',reopened:'open'}[event.state];
   if(!status)continue;
   q.status=status;
   if(event.state==='reopened')q.manually_reopened=true;
   q.github_sync={event_id:event.event_id,state:event.state,status:'verified',url:event.url};
   q.last_github_comment_id=event.comment_id;
   q.last_github_sequence=sequence;
   q.revision=Math.max(q.revision,sequence)+1;
   q.history.push({at:now,actor:'github:'+event.actor,event:'shared_state',state:event.state,url:event.url});
  }
 }
 return next;
}
export function syncMuseQuestions(path,facts,now){
 return transact(path,state=>importMuseQuestions(state,facts,now));
}
export function applyQuestionEdit(state,edit,{role,now=new Date().toISOString(),notes}={}){
 if(!['owner','muse'].includes(role)||!idValid(edit?.id)||!Number.isSafeInteger(edit.expected_revision))
  throw Error('Authenticated actor, valid question ID and revision required');
 const old=state.entries[edit.id];
 if(!old||old.revision!==edit.expected_revision)throw Error('Question edit conflict: refresh and retry');
 if(!text(edit.detail)||Object.keys(edit).some(k=>!['id','expected_revision','action','detail'].includes(k)))
  throw Error('Invalid question edit; provide the exact answer or evidence');
 const q=structuredClone(old),action=edit.action;
 let shared=null;
 if(action==='acknowledge'&&q.status==='open'&&!q.source_changed){
  q.status='acknowledged';shared='acknowledged';
 }else if(action==='answer'&&['open','acknowledged'].includes(q.status)&&!q.source_changed){
  q.status='answered';q.answer=edit.detail;q.answer_recorded_by=role;shared='answered';
 }else if(action==='claim_delivery'&&q.status==='answered'&&!q.source_changed){
  const links=[...new Set(Object.values(notes?.entries||{}).filter(e=>e.pr_number===q.pr_number).map(e=>e.chat_url).filter(Boolean))];
  if(links.length!==1||!validChatUrl(links[0]))throw Error('One verified chat link required');
  q.status='delivery_uncertain';q.delivery_chat_url=links[0];shared='delivery_uncertain';
 }else if(action==='confirm_delivery'&&q.status==='delivery_uncertain'){
  q.status='delivered';q.delivery_receipt=edit.detail;shared='delivered';
 }else if(action==='confirm_not_sent'&&q.status==='delivery_uncertain'){
  q.status='answered';delete q.delivery_chat_url;shared='answered';
 }else if(action==='ignore'&&['open','acknowledged','answered','delivered','archived','resolved_reported'].includes(q.status)){
  q.status='ignored';q.closure=edit.detail;shared='ignored';
 }else if(action==='close'&&['open','acknowledged','answered','delivered','resolved_reported','archived'].includes(q.status)){
  q.status='closed';q.closure=edit.detail;shared='resolved';
 }else if(action==='reopen'&&['closed','ignored','archived','resolved_reported'].includes(q.status)){
  q.status='open';q.manually_reopened=true;q.closure=null;shared='reopened';
 }else if(action==='retry_github_sync'&&q.github_sync&&['blocked_auth','uncertain','no_token'].includes(q.github_sync.status)){
  // Never auto-replay an uncertain POST. The caller explicitly confirms a
  // separate check found no receipt before opting to retry.
  q.github_sync={...q.github_sync,status:'pending'};shared=null;
 }else throw Error('Invalid question transition; do not replay uncertain delivery or use edited questions');
 q.revision++;q.history.push({at:now,actor:role,event:action,detail:edit.detail});
 if(shared){
  q.github_sync={event_id:q.id+'-r'+q.revision+'-'+randomBytes(8).toString('hex'),state:shared,status:'pending'};
  delete q.github_sync_conflict;
 }
 return {...state,entries:{...state.entries,[q.id]:q}};
}
export function writeMuseQuestion(path,edit,opts){
 return transact(path,state=>applyQuestionEdit(state,edit,opts));
}

export function recordMuseGithubSync(path,id,eventId,patch,now=new Date().toISOString()){
 return transact(path,state=>{
  const q=state.entries[id];if(!q||q.github_sync?.event_id!==eventId)return state;
  const next=structuredClone(state),r=next.entries[id];
  if(!['pending','no_token','blocked_auth','uncertain','published_unverified'].includes(r.github_sync.status))
   return state;
  const status=patch?.status;
  if(!['no_token','blocked_auth','uncertain','published_unverified','verified'].includes(status))
   throw Error('Invalid GitHub synchronization receipt');
  r.github_sync={...r.github_sync,status,...(patch.url?{url:patch.url}:{})};
  r.history.push({at:now,actor:'github_sync',event:status});
  r.revision++;return next;
 });
}
