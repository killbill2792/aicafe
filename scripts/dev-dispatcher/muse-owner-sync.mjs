// Optional GitHub PR-comment synchronization for the existing Muse host.
// This is NOT a dispatcher, scheduler, code writer, or grant of owner approval.
// Local question disposition is usable without a write token; GitHub publication
// is a portable cross-courier receipt with a stable event identity.
import {openSync,closeSync,unlinkSync} from 'node:fs';
import {readMuseQuestions,recordMuseGithubSync} from './muse-owner-questions.mjs';

const eligible=new Set(['pending','no_token','uncertain','blocked_auth','published_unverified']);
const writable=new Set(['pending','no_token']);
const validRepo=s=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s||'');
const validPr=n=>Number.isSafeInteger(n)&&n>0&&n<=9999999;
function asReceipt(q){
 const ack=q.github_sync;
 if(!ack||!/^comment-[1-9]\d{0,19}-r[1-9]\d{0,9}(?:-[a-f0-9]{16})?$/.test(ack.event_id||'')||
   !ack.event_id.startsWith(q.id+'-r')||
   !['acknowledged','answered','delivery_uncertain','delivered','ignored','resolved','reopened'].includes(ack.state))
  return null;
 return {v:1,question_id:q.id,event_id:ack.event_id,state:ack.state};
}
export function githubAttentionComment(q){
 const body=asReceipt(q);
 if(!body)throw Error('Invalid Muse coordination event');
 return '<!-- aicafe-owner-state:v1 '+JSON.stringify(body)+' -->\n'+
  'Muse coordination: '+({
   acknowledged:'Request picked up by courier (not approved)',
   answered:'Owner answer recorded privately (not authorization evidence)',
   delivery_uncertain:'Chat delivery unconfirmed; no automatic resend',
   delivered:'Answer delivery receipt recorded (implementation still unverified)',
   ignored:'Request dismissed for attention only; original comment preserved',
   resolved:'Question closed as coordination history (not an approval)',
   reopened:'Owner question reopened for attention'
  }[body.state])+'.\nOriginal question: '+q.url;
}
export async function publishMuseQuestionAcks({repo,path,facts,token=null,
 fetchImpl=fetch,now=new Date().toISOString(),maxWrites=5}={}){
 if(!validRepo(repo)||!path)throw Error('GitHub synchronization repository/path required');
 const result={published:0,verified:0,pending:0,unconfigured:0,uncertain:0,blocked:0};
 // Prevent duplicate sends from overlapping Muse timer/browser processes.
 let lock=null;
 try{lock=openSync(path+'.publish.lock','wx',0o600);}
 catch(e){if(e?.code==='EEXIST')return {...result,blocked:1};throw e;}
 try{
  const current=readMuseQuestions(path);
  const prs=[...(facts?.prs||[]),...(facts?.merged_prs||[])];
  const observed=Date.parse(facts?.observed_at),clock=Date.parse(now);
  const validFacts=facts?.version===1&&Number.isFinite(observed)&&Number.isFinite(clock)&&
   clock>=observed&&clock-observed<=15*60*1000;
  if(!validFacts)return {...result,blocked:1};
  let written=0;
  for(const q of Object.values(current.entries||{})){
   const ack=q.github_sync;
   if(!eligible.has(ack?.status))continue;
   const source=prs.find(p=>p.number===q.pr_number);
   // Unknown/incomplete reads must not trigger a duplicate comment.
   if(!source||source.owner_request_read_incomplete!==false){result.pending++;continue;}
   const present=(source.ack_events||[]).find(e=>e.event_id===ack.event_id&&e.question_id===q.id);
   if(present){
    recordMuseGithubSync(path,q.id,ack.event_id,{status:'verified',url:present.url},now);
    result.verified++;continue;
   }
   if(!token){
    if(ack.status==='pending')recordMuseGithubSync(path,q.id,ack.event_id,
     {status:'no_token'},now);
    result.unconfigured++;continue;
   }
   if(!writable.has(ack.status)){result.uncertain++;continue;}
   if(written>=maxWrites){result.pending++;continue;}
   if(!validPr(q.pr_number)||!(source.owner_requests||[]).some(r=>r.id===q.id)){
    result.blocked++;continue;
   }
   const url='https://api.github.com/repos/'+repo+'/issues/'+q.pr_number+'/comments';
   // The comment contains state only, never the private owner response.
   const body=githubAttentionComment(q);
   written++;
   try{
    const res=await fetchImpl(url,{method:'POST',headers:{
     Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
     'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'
    },body:JSON.stringify({body})});
    if(res.status===401||res.status===403){
     recordMuseGithubSync(path,q.id,ack.event_id,{status:'blocked_auth'},now);
     result.blocked++;continue;
    }
    if(res.status!==201){
     recordMuseGithubSync(path,q.id,ack.event_id,{status:'uncertain'},now);
     result.uncertain++;continue;
    }
    const published=await res.json();
    const expected=source.url+'#issuecomment-'+published?.id;
    if(!Number.isSafeInteger(published?.id)||published.id<=0||
       published.html_url!==expected){
     recordMuseGithubSync(path,q.id,ack.event_id,{status:'uncertain'},now);
     result.uncertain++;continue;
    }
    recordMuseGithubSync(path,q.id,ack.event_id,{status:'published_unverified',
      url:published.html_url},now);
    result.published++;
   }catch{
    // A failed or interrupted POST may have succeeded at GitHub.
    // Inspect the next authoritative read; never auto-resend blindly.
    recordMuseGithubSync(path,q.id,ack.event_id,{status:'uncertain'},now);
    result.uncertain++;
   }
  }
  return result;
 }finally{closeSync(lock);unlinkSync(path+'.publish.lock');}
}
