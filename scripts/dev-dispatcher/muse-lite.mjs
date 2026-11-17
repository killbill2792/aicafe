#!/usr/bin/env node
// One-shot Muse-side PR observer. GitHub is a READ-ONLY evidence source.
// Run under Muse's EXISTING timer; this never sends chat, requests reviews,
// approves work, merges PRs, or depends on GitHub Actions reconciliation.
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readMuseNotes} from './muse-local-notes.mjs';
import {parseCodexReviewState} from './github.mjs';

const millis=t=>{const n=Date.parse(t||'');return Number.isFinite(n)?n:null;};
const identity=a=>createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0,24);

const QUERY=`query MuseMonitor($owner:String!,$repo:String!){
 repository(owner:$owner,name:$repo){
  pullRequests(states:OPEN,first:70,orderBy:{field:UPDATED_AT,direction:DESC}){
   pageInfo{hasNextPage}
   nodes{number title url isDraft headRefOid
    headRef{target{... on Commit{committedDate statusCheckRollup{state}}}}
    comments(last:100){nodes{body createdAt author{login}}}
   }
  }
  recentlyMerged:pullRequests(states:MERGED,first:25,orderBy:{field:UPDATED_AT,direction:DESC}){
   nodes{number title url mergedAt headRefOid}
  }
 }
}`;
function codexStatus(comments,head){
 // Use the same strict, head-bound Codex parser as the existing dispatcher.
 // Only authenticated Codex bot-authored summary comments count.
 const states=(comments||[])
  .filter(c=>['chatgpt-codex-connector[bot]','codex[bot]'].includes(c.author?.login))
  .map(c=>parseCodexReviewState(c.body||'',head)?.state)
  .filter(Boolean);
 return states.at(-1)||'unknown';
}
export function normalizeGithubFacts(response,now=new Date().toISOString()){
 const repo=response?.data?.repository;
 if(response?.errors?.length||!repo?.pullRequests||repo.pullRequests.pageInfo?.hasNextPage)
  throw Error('Incomplete GitHub PR evidence; do not infer clean status');
 const prs=[];
 for(const p of repo.pullRequests.nodes||[]){
  if(!Number.isInteger(p.number)||!/^https:\/\/github\.com\//.test(p.url||'')||
     !/^[a-f0-9]{40}$/.test(p.headRefOid||''))continue;
  const check=p.headRef?.target?.statusCheckRollup?.state;
  prs.push({number:p.number,title:p.title,url:p.url,head_sha:p.headRefOid,
   draft:p.isDraft===true,merged:false,
   committed_at:p.headRef?.target?.committedDate||null,
   ci:check==='SUCCESS'?'observed_green':check==='FAILURE'||check==='ERROR'?'failure':
      check==='PENDING'?'pending':'unknown',
   codex:codexStatus(p.comments?.nodes,p.headRefOid)});
 }
 return {version:1,observed_at:now,source:'github_graphql_read_only',
  prs,merged_prs:(repo.recentlyMerged?.nodes||[]).filter(p=>p.mergedAt)
    .map(p=>({number:p.number,title:p.title,url:p.url,merged_at:p.mergedAt}))};
}
export async function fetchGithubFacts({repo,token,fetchImpl=fetch,
 now=new Date().toISOString()}={}){
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo||'')||!token)
  throw Error('Read-only GitHub credentials and repository required');
 const [owner,name]=repo.split('/');
 const response=await fetchImpl('https://api.github.com/graphql',{
  method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
   'Content-Type':'application/json'},
  body:JSON.stringify({query:QUERY,variables:{owner,repo:name}})});
 if(!response.ok)throw Error('GitHub read unavailable HTTP '+response.status);
 return normalizeGithubFacts(await response.json(),now);
}
export function museActions(facts,previous,notes,{now=new Date().toISOString(),
 idleMinutes=10,ownerReminderMinutes=7,freshMinutes=15}={}){
 const clock=millis(now),seen=previous?.prs||[],records=notes?.entries||{};
 if(clock===null)throw Error('Invalid clock');
 const fresh=facts?.version===1&&millis(facts.observed_at)!==null&&
  clock-millis(facts.observed_at)<=freshMinutes*60000;
 const byPr=new Map((facts?.prs||[]).map(p=>[p.number,p]));
 const activePrevious=new Set(seen.map(p=>p.number));
 const actions=[],blocked=[];
 const emit=(kind,task_id,pr_number,head_sha,chat_url,reason,extra='')=>{
  const id=identity([kind,task_id,pr_number,head_sha,extra]);
  actions.push({id,kind,task_id,pr_number,head_sha,chat_url,reason});
 };
 // Owner reminders are independent of GitHub health.
 for(const [task,entry] of Object.entries(records)){
  if(entry.stage==='waiting_owner'&&millis(entry.updated_at)!==null&&
   clock-millis(entry.updated_at)>=ownerReminderMinutes*60000)
   emit('remind_owner',task,entry.pr_number,null,entry.chat_url||null,
     'Review the proposed architecture in the existing chat',
     String(entry.revision));
 }
 if(!fresh)return {fresh:false,actions,blocked:[{reason:'github_evidence_stale_or_unavailable'}]};
 for(const entry of Object.values(records)){
  if(!entry.pr_number||['waiting_owner','paused'].includes(entry.stage))continue;
  const p=byPr.get(entry.pr_number);
  if(!p){
   if(!(facts.merged_prs||[]).some(v=>v.number===entry.pr_number))
    blocked.push({task_id:entry.task_id,pr_number:entry.pr_number,
     reason:'pr_missing_or_closed_unmerged_verify_github'});
   continue;
  }
  const head=p.head_sha;
  let kind=null,reason=null;
  if(p.ci==='failure'){kind='fix_ci';reason='Investigate current-head failing checks and rerun';}
  else if(p.codex==='findings'){kind='fix_codex';reason='Address exact-head Codex findings and retest';}
  else if(!p.draft&&p.ci==='observed_green'&&p.codex==='clean'){
   kind='verify_merge';reason='Verify required CI, approval, security and acceptance gates; merge only if eligible';
  }else if(entry.stage!=='ready_review'&&
    (millis(p.committed_at)!==null&&clock-millis(p.committed_at)>=idleMinutes*60000)&&
    p.ci!=='pending'&&p.codex!=='pending'){
   kind='continue_chat';reason='No recent commit; inspect actual work and continue if not actively running';
  }
  if(!kind)continue;
  if(!entry.chat_url){blocked.push({task_id:entry.task_id,pr_number:p.number,
    reason:'missing_verified_chat_url'});continue;}
  emit(kind,entry.task_id,p.number,head,entry.chat_url,reason);
 }
 // Only a PR observed open on a previous successful snapshot may trigger next-task planning.
 for(const p of facts.merged_prs||[]){
  if(!activePrevious.has(p.number))continue;
  emit('plan_next',null,p.number,null,null,
    'Ask the existing planning chat which independent tasks can start next',p.merged_at);
 }
 return {fresh:true,actions,blocked};
}
function atomicJson(path,obj){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const tmp=path+'.tmp-'+process.pid;
 writeFileSync(tmp,JSON.stringify(obj,null,2)+'\n',{mode:0o600,flag:'wx'});
 try{renameSync(tmp,path);}catch(e){try{unlinkSync(tmp);}catch{}throw e;}
}
export function reserveMuseActions(existing,planned,now){
 const next=structuredClone(existing||{version:1,events:{}});
 if(next.version!==1||!next.events)throw Error('Invalid Muse event record');
 const newly=[];
 for(const a of planned.actions){
  if(next.events[a.id])continue;
  next.events[a.id]={...a,status:'suggested_unverified',created_at:now};
  newly.push(a);
 }
 // Keep bounded history, retain pending records; do not silently allow duplicate sends.
 if(Object.keys(next.events).length>1000)throw Error('Muse event history full; review before archival');
 return {state:next,new_actions:newly};
}
export async function runMuseLite({repo,token,home=join(homedir(),'.local','state','aicafe-muse'),
 now=new Date().toISOString(),fetchImpl=fetch}={}){
 const notes=readMuseNotes(join(home,'notes.json'));
 const cache=join(home,'github-facts.json'),events=join(home,'events.json');
 const previous=existsSync(cache)?JSON.parse(readFileSync(cache,'utf8')):null;
 const prior=existsSync(events)?JSON.parse(readFileSync(events,'utf8')):null;
 const blockedUntil=millis(prior?.github_backoff_until);
 let facts,error=null;
 if(blockedUntil!==null&&blockedUntil>millis(now)){
  error='GitHub read backoff until '+prior.github_backoff_until;
  facts=previous;
 }else{
  try{facts=await fetchGithubFacts({repo,token,fetchImpl,now});}
  catch(e){facts=previous;error=String(e.message||e);}
 }
 const result=museActions(error?null:facts,previous,notes,{now});
 const reserved=reserveMuseActions(prior,result,now);
 if(error){
  const minutes=/HTTP 429|HTTP 403|HTTP 401/.test(error)?30:5;
  reserved.state.github_backoff_until=blockedUntil!==null&&blockedUntil>millis(now)
   ?prior.github_backoff_until:new Date(millis(now)+minutes*60000).toISOString();
 }else delete reserved.state.github_backoff_until;
 atomicJson(events,reserved.state);
 if(!error)atomicJson(cache,facts);
 return {observed_at:now,github_read:error?'unavailable':'verified',
   last_github_observed_at:facts?.observed_at||null,
   actions:reserved.new_actions,holds:result.blocked,
   pending:Object.values(reserved.state.events).filter(x=>x.status==='suggested_unverified').length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const repo=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN||process.env.GH_TOKEN;
 const home=process.env.MUSE_COORDINATION_HOME||undefined;
 runMuseLite({repo,token,home}).then(result=>console.log(JSON.stringify(result,null,2)))
  .catch(e=>{console.error('Muse monitor cannot run: '+String(e.message));process.exitCode=1;});
}
