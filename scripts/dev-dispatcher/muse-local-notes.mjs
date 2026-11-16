// Muse's private, local coordination notes. Not a task queue or approval ledger.
// Nothing here can attest CI, Codex, owner scope, merge or provider effects.
import {readFileSync,writeFileSync,renameSync,unlinkSync,mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';

const TASK_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STAGES=new Set(['working','waiting_owner','ready_review','incomplete','paused','unknown']);
const BLOCKED=/[\x00-\x08\x0b-\x1f\x7f]/;

export function validChatUrl(input){
 if(input==='')return true;
 if(typeof input!=='string'||input.length>600)return false;
 try{
  const u=new URL(input);
  return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&
   !u.username&&!u.password&&!u.search&&!u.hash&&!u.port&&
   (/^\/c\/[A-Za-z0-9-]+\/?$/.test(u.pathname)||
     /^\/g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9-]+\/?$/.test(u.pathname));
 }catch{return false;}
}
export function validateMuseNote(edit){
 if(!edit||typeof edit!=='object'||Array.isArray(edit)||
   !TASK_ID.test(edit.task_id||''))throw Error('Invalid task ID');
 if(!Number.isSafeInteger(edit.expected_revision)||edit.expected_revision<0)
  throw Error('Expected note revision required');
 const {chat_url='',stage='unknown',note='',pr_number=null}=edit;
 if(!validChatUrl(chat_url))throw Error('Invalid ChatGPT URL');
 if(!STAGES.has(stage))throw Error('Unsupported coordination stage');
 if(typeof note!=='string'||note.length>1600||BLOCKED.test(note))
  throw Error('Invalid coordination note');
 if(pr_number!==null&&(!Number.isSafeInteger(pr_number)||pr_number<1||pr_number>9999999))
  throw Error('Invalid PR number');
 if(Object.keys(edit).some(k=>!['task_id','expected_revision','chat_url','stage','note','pr_number'].includes(k)))
  throw Error('Unsupported note field');
 return true;
}
export function applyMuseNote(state,edit,{role,now=new Date().toISOString()}={}){
 if(role!=='owner'&&role!=='muse')throw Error('Authenticated owner or Muse required');
 validateMuseNote(edit);
 if(!Number.isFinite(Date.parse(now)))throw Error('Invalid time');
 if(!state||state.version!==1||!state.entries||typeof state.entries!=='object')
  throw Error('Invalid Muse notes');
 const previous=state.entries[edit.task_id],revision=previous?.revision??0;
 if(revision!==edit.expected_revision)throw Error('Note edit conflict: refresh and retry');
 const entry={task_id:edit.task_id,pr_number:edit.pr_number??null,
  chat_url:edit.chat_url??'',stage:edit.stage??'unknown',note:edit.note??'',
  revision:revision+1,updated_at:now,updated_by:role};
 return {...state,entries:{...state.entries,[edit.task_id]:entry}};
}
export function readMuseNotes(path){
 if(!existsSync(path))return {version:1,entries:{}};
 const state=JSON.parse(readFileSync(path,'utf8'));
 if(state?.version!==1||!state.entries||Array.isArray(state.entries)||
    typeof state.entries!=='object')throw Error('Invalid Muse notes');
 return state;
}
export function writeMuseNote(path,edit,opts){
 // Lock and atomic rename: a second Node process cannot lose another edit.
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const lock=path+'.lock';
 let fd;
 try{
  fd=openSync(lock,'wx',0o600);
  const next=applyMuseNote(readMuseNotes(path),edit,opts);
  const temp=path+'.tmp-'+process.pid;
  try{
   writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
   renameSync(temp,path);
  }catch(e){try{unlinkSync(temp);}catch{}throw e;}
  return next;
 }finally{
  if(fd!==undefined){closeSync(fd);unlinkSync(lock);}
 }
}
