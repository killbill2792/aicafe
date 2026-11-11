#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {GitHubLedger} from './ledger.mjs';
import {settings} from './settings.mjs';
import {queueOwnerIssue} from './alerts.mjs';
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
 // Automatic Codex has no manual request comment. Guarantee an independent
 // 20-minute watchdog run if the ready-triggered review never appears.
 for(const [id,r] of Object.entries(state.tasks||{})){
  const at=dt(r.ready_transition_at);
  if(r.github_state==='open'&&r.draft===false&&r.ci_state==='success'&&
     r.codex_review_requested_sha===r.head_sha&&
     r.codex_reviewed_sha!==r.head_sha&&r.codex_referee_sha!==r.head_sha&&
     r.codex_in_progress_sha!==r.head_sha&&
     !['clean','findings'].includes(r.codex_state)&&Number.isFinite(at))
   list.push({at:at+20*60*1000,reason:'codex_watchdog',id});
 }
 for(const [id,a] of Object.entries(state.actions||{})){
  const at=dt(a.last_wake_at||a.created_at);
  if(a.status==='planned'&&a.delivery_owner==='muse'&&Number.isFinite(at))
   list.push({at:at+(config.muse.retry_seconds||900)*1000,reason:'muse_retry',id});
 }
 for(const [id,a] of Object.entries(state.owner_alerts||{})){
  const at=dt(a.last_wake_at||a.created_at);
  if(a.status==='planned'&&a.delivery_owner==='muse'&&Number.isFinite(at))
   list.push({at:at+(config.muse.retry_seconds||900)*1000,reason:'owner_notice_retry',id});
 }
 for(const [id,r] of Object.entries(state.receipt_feedback||{})){
  const at=dt(r.last_wake_at||r.first_seen_at);
  if(r.status==='rejected'&&Number.isFinite(at))
   list.push({at:at+(config.muse.retry_seconds||900)*1000,reason:'receipt_repair',id});
 }
 // The same reconciliation checks ALL overdue Muse actions/notices/repairs.
 // A burst of owner alerts must schedule one retry per KIND, not one Actions
 // run per notice. Codex waits stay exact-head/per-task and remain separate.
 const batchKinds=new Set(['muse_retry','owner_notice_retry','receipt_repair']);
 const batches=new Map(),singles=[];
 for(const item of list.filter(x=>Number.isFinite(x.at))){
   if(!batchKinds.has(item.reason)){singles.push(item);continue;}
   const prior=batches.get(item.reason);
   if(!prior||item.at<prior.at)batches.set(item.reason,{...item,id:'batch'});
 }
 // An overdue wake is due NOW, not silently dropped. Keep the identity
 // tied to its original deadline so repeated ticks cannot generate a storm.
 const candidates=[...singles,...batches.values()].map(x=>({
   ...x,key:sha(JSON.stringify([config.repo,x.reason,x.id,new Date(x.at).toISOString()]))
 })).filter(x=>{
   // Multiple overdue candidates must not bounce the single delayed_wake
   // pointer between each other. Remember each recently requested wake key.
   const prior=state.delayed_wake_history?.[x.key]||
     (state.delayed_wake?.key===x.key?state.delayed_wake:null);
   return !prior||
     !((prior.status==='requested'&&now-dt(prior.requested_at||prior.reserved_at)<15*60000)||
       (prior.status==='reserved'&&now-dt(prior.reserved_at)<60000));
 });
 // A previously requested overdue candidate cannot starve newer owner notices.
 const first=candidates.sort((a,b)=>a.at-b.at)[0];
 if(!first)return null;
 const due_at=new Date(Math.max(first.at,now+5000)).toISOString();
 return {due_at,reason:first.reason,key:first.key};
}
export async function scheduleSelfWake({ledger,token,config=settings,now=Date.now(),fetchFn=fetch}){
 if(!token)throw Error('Repository workflow token required');
 let reserved=null;
 await ledger.transaction(state=>{
  const due=nextWake(state,now,config);
  if(!due)return null;
  const old=state.delayed_wake;
  if(old?.key===due.key&&(
    (old.status==='requested'&&now-dt(old.requested_at||old.reserved_at)<15*60000)||
    (old.status==='reserved'&&now-dt(old.reserved_at)<60000)))return null;
  reserved={...due,status:'reserved',reserved_at:new Date(now).toISOString()};
  state.delayed_wake=reserved;
  state.delayed_wake_history||={};
  for(const [key,item] of Object.entries(state.delayed_wake_history))
    if(now-dt(item.requested_at||item.reserved_at)>24*60*60000)
      delete state.delayed_wake_history[key];
  state.delayed_wake_history[reserved.key]={...reserved};
  return state;
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
  const current=state.delayed_wake_history?.[reserved.key];
  if(current?.status==='reserved'){
    current.status=ok?'requested':'failed';
    if(ok)current.requested_at=new Date(now).toISOString();
  }
  if(state.delayed_wake?.key!==reserved.key)return state;
  state.delayed_wake.status=ok?'requested':'failed';
  if(ok)state.delayed_wake.requested_at=new Date(now).toISOString();
  if(!ok)state.owner_alerts=queueOwnerIssue(state,{kind:'delayed_wake_failed',
    identity:reserved.key,message:'Repository '+config.repo+
    ' delayed self-wake failed for '+reserved.reason+' at '+reserved.due_at,
    needs:'Repair workflow_dispatch permission or retry the wake'}).owner_alerts;
  return state;
 });
 if(!ok)throw Error('Delayed wake dispatch failed: HTTP '+(response?.status||'network'));
 return {...reserved,status:'requested'};
}
export async function dispatchReceiptWake({repo=settings.repo,token,event='dispatcher_receipt',fetchFn=fetch}={}){
 if(repo!==settings.repo||!token||!['dispatcher_receipt','dispatcher_owner_reply','dispatcher_owner_instruction','dispatcher_delayed'].includes(event))
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
