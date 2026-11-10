#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {GitHubLedger} from './ledger.mjs';
import {settings} from './settings.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex'),dt=s=>Date.parse(s||'');
export function nextWake(state,now=Date.now(),config=settings){
 const list=[];
 for(const [id,r] of Object.entries(state.tasks||{})){
  if(r.github_state!=='open'||r.draft!==false||r.ci_state!=='success'||
   ['findings','clean'].includes(r.codex_state)||r.codex_reviewed_sha===r.head_sha||
   r.codex_in_progress_sha===r.head_sha||r.codex_review_requested_sha===r.head_sha)continue;
  const at=Math.max(Number.isFinite(dt(r.ready_transition_at))?dt(r.ready_transition_at):0,
   dt(r.last_github_activity||r.last_commit_at));
  if(Number.isFinite(at))list.push({at:at+config.codex.settle_seconds*1000,reason:'codex_settle',id});
 }
 for(const [id,a] of Object.entries(state.actions||{})){
  const at=dt(a.last_wake_at||a.created_at);
  if(a.status==='planned'&&a.delivery_owner==='muse'&&Number.isFinite(at))
   list.push({at:at+(config.muse.retry_seconds||900)*1000,reason:'muse_retry',id});
 }
 for(const [id,r] of Object.entries(state.receipt_feedback||{})){
  const at=dt(r.last_wake_at||r.first_seen_at);
  if(r.status==='rejected'&&Number.isFinite(at))
   list.push({at:at+(config.muse.retry_seconds||900)*1000,reason:'receipt_repair',id});
 }
 const first=list.filter(x=>x.at>now+1000).sort((a,b)=>a.at-b.at)[0];
 if(!first)return null;
 const due_at=new Date(first.at).toISOString();
 return {due_at,reason:first.reason,key:sha(JSON.stringify([config.repo,first.reason,first.id,due_at]))};
}
export async function scheduleSelfWake({ledger,token,config=settings,now=Date.now(),fetchFn=fetch}){
 if(!token)throw Error('Repository workflow token required');
 let reserved=null;
 await ledger.transaction(state=>{
  const due=nextWake(state,now,config);
  if(!due)return null;
  const old=state.delayed_wake;
  if(old?.key===due.key&&
    (old.status==='requested'||old.status==='reserved'&&now-dt(old.reserved_at)<60000))return null;
  reserved={...due,status:'reserved',reserved_at:new Date(now).toISOString()};
  state.delayed_wake=reserved;return state;
 });
 if(!reserved)return {status:'unchanged'};
 let response;
 try{response=await fetchFn('https://api.github.com/repos/'+config.repo+
  '/actions/workflows/'+config.workflows.delayed_wake+'/dispatches',{
   method:'POST',headers:{Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json','Content-Type':'application/json'},
   body:JSON.stringify({ref:'main',inputs:{due_at:reserved.due_at,wake_key:reserved.key}})});
 }catch{}
 const ok=response?.ok===true;
 await ledger.transaction(state=>{
  if(state.delayed_wake?.key!==reserved.key)return null;
  state.delayed_wake.status=ok?'requested':'failed';return state;
 });
 if(!ok)throw Error('Delayed wake dispatch failed: HTTP '+(response?.status||'network'));
 return {...reserved,status:'requested'};
}
export async function dispatchReceiptWake({repo=settings.repo,token,event='dispatcher_receipt',fetchFn=fetch}={}){
 if(repo!==settings.repo||!token||!['dispatcher_receipt','dispatcher_owner_reply','dispatcher_delayed'].includes(event))
  throw Error('Untrusted or cross-project receipt wake');
 const r=await fetchFn('https://api.github.com/repos/'+repo+'/dispatches',{
  method:'POST',headers:{Authorization:'Bearer '+token,
   Accept:'application/vnd.github+json','Content-Type':'application/json'},
  body:JSON.stringify({event_type:event,client_payload:{version:1}})});
 if(!r.ok)throw Error('Receipt repository_dispatch failed: HTTP '+r.status);
 return {status:'dispatched',repo,event};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const ledger=new GitHubLedger({repo:settings.ledger.repo,token:process.env.DISPATCH_LEDGER_TOKEN});
 scheduleSelfWake({ledger,token:process.env.GITHUB_TOKEN})
 .then(x=>console.log('Delayed self-wake: '+x.status))
 .catch(e=>{console.error(e.message);process.exitCode=1;});
}
