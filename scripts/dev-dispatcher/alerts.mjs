// Durable owner-attention notices in the SAME private dispatcher ledger.
// Muse delivers these later; GitHub never sends owner messages directly.
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function noticeHash({kind,task_id,pr_number,question}){
 return sha(JSON.stringify([kind,task_id||null,pr_number||null,question]));
}
export function queueOwnerAlerts(state,{unmappedPrs=[],now=new Date().toISOString()}={}){
 const next=structuredClone(state);
 next.owner_alerts ||= {};
 const add=(kind,task_id,pr_number,question)=>{
  if(typeof question!=='string'||!question.trim()||question.length>1200)return;
  if(pr_number!=null&&(!Number.isInteger(pr_number)||pr_number<1))return;
  const entry={kind,task_id:task_id||null,pr_number:pr_number||null,
   question:question.trim(),delivery_owner:'muse',status:'planned',created_at:now};
  entry.notice_hash=noticeHash(entry);
  const key='notice:'+entry.notice_hash;
  if(!next.owner_alerts[key])next.owner_alerts[key]=entry;
 };
 for(const [id,rec] of Object.entries(next.tasks||{})){
  if(rec.owner_question || rec.github_owner_question)
   add('owner_decision',id,rec.pr_number,'PR #'+(rec.pr_number||'not opened')+': '+(rec.owner_question||rec.github_owner_question));
  if(rec.agent==='claude'&&rec.blocker?.confirmed===true &&
     ['usage_limit','confirmed_blocker'].includes(rec.blocker.kind))
   add('claude_blocker',id,rec.pr_number,
    'Claude task '+id+' blocked ('+rec.blocker.kind+'): '+String(rec.blocker.detail||'Confirmed blocker'));
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
