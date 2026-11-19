// Local communication records, not an approval or execution authority.
import {readFileSync,writeFileSync,renameSync,unlinkSync,mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {validChatUrl} from './muse-local-notes.mjs';

const text=(v,max=2000)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
const idValid=id=>typeof id==='string'&&/^comment-[1-9]\d{0,19}$/.test(id);
export function readMuseQuestions(path){
 if(!existsSync(path))return {version:1,entries:{}};
 const state=JSON.parse(readFileSync(path,'utf8'));
 if(state?.version!==1||!state.entries||typeof state.entries!=='object'||Array.isArray(state.entries))
  throw Error('Invalid local owner-question records');
 return state;
}
function transact(path,fn){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const lock=path+'.lock';let fd;
 try{
  fd=openSync(lock,'wx',0o600);
  const next=fn(readMuseQuestions(path)),tmp=path+'.tmp-'+process.pid;
  try{writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,path);}
  catch(e){try{unlinkSync(tmp);}catch{}throw e;}
  return next;
 }finally{if(fd!==undefined){closeSync(fd);unlinkSync(lock);}}
}
export function importMuseQuestions(state,facts,now=new Date().toISOString()){
 const next=structuredClone(state);
 // Missing, edited, closed or deleted GitHub records do not answer a request.
 for(const p of facts?.prs||[]){
  for(const q of p.owner_requests||[]){
   if(!idValid(q.id)||q.pr_number!==p.number||!text(q.question)||
    !/^[a-f0-9]{40}$/.test(q.head_sha||'')||
    !q.url?.startsWith(p.url+'#issuecomment-')||q.url.split('#issuecomment-')[1]!==q.id.slice(8))continue;
   const old=next.entries[q.id];
   if(!old){
    next.entries[q.id]={...q,status:'open',revision:1,imported_at:now,history:[]};
   }else if((old.question!==q.question||old.head_sha!==q.head_sha||old.pr_number!==q.pr_number)&&!old.source_changed){
    old.source_changed=true;old.revision++;old.history.push({at:now,actor:'collector',event:'source_changed'});
   }
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
 if(action==='answer'&&q.status==='open'&&!q.source_changed){q.status='answered';q.answer=edit.detail;q.answer_recorded_by=role;}
 else if(action==='claim_delivery'&&q.status==='answered'&&!q.source_changed){
  const links=[...new Set(Object.values(notes?.entries||{}).filter(e=>e.pr_number===q.pr_number).map(e=>e.chat_url).filter(Boolean))];
  if(links.length!==1||!validChatUrl(links[0]))throw Error('One verified chat link required');
  q.status='delivery_uncertain';q.delivery_chat_url=links[0];
 }else if(action==='confirm_delivery'&&q.status==='delivery_uncertain'&&!q.source_changed){q.status='delivered';q.delivery_receipt=edit.detail;}
 else if(action==='confirm_not_sent'&&q.status==='delivery_uncertain'&&!q.source_changed){q.status='answered';delete q.delivery_chat_url;}
 else if(action==='close'&&['open','answered','delivered'].includes(q.status)){q.status='closed';q.closure=edit.detail;}
 else throw Error('Invalid question transition; do not replay uncertain delivery or use edited questions');
 q.revision++;q.history.push({at:now,actor:role,event:action,detail:edit.detail});
 return {...state,entries:{...state.entries,[q.id]:q}};
}
export function writeMuseQuestion(path,edit,opts){
 return transact(path,state=>applyQuestionEdit(state,edit,opts));
}
