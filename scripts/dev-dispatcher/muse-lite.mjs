#!/usr/bin/env node
// One-shot Muse-side PR observer. GitHub is a READ-ONLY evidence source.
// Run under Muse's EXISTING timer; this never sends chat, requests reviews,
// approves work, merges PRs, or depends on GitHub Actions reconciliation.
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readMuseNotes} from './muse-local-notes.mjs';
import {parseCodexReviewState,parseOwnerQuestion} from './github.mjs';

const millis=t=>{const n=Date.parse(t||'');return Number.isFinite(n)?n:null;};
const identity=a=>createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0,24);
const trusted=a=>['OWNER','MEMBER','COLLABORATOR'].includes(a);

export const QUERY=`query MuseMonitor($owner:String!,$repo:String!){
 repository(owner:$owner,name:$repo){
  nameWithOwner
  pullRequests(states:OPEN,first:70,orderBy:{field:UPDATED_AT,direction:DESC}){
   pageInfo{hasNextPage}
   nodes{number title url isDraft headRefOid body authorAssociation
    headRepository{nameWithOwner}
    labels(first:100){pageInfo{hasNextPage} nodes{name}}
    headRef{target{... on Commit{committedDate statusCheckRollup{state}}}}
    comments(last:100){pageInfo{hasPreviousPage} nodes{body createdAt url authorAssociation author{login}}}
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
  .filter(c=>/^(?:chatgpt-codex-connector|codex)(?:\[bot\])?$/.test(c.author?.login||''))
  .map(c=>parseCodexReviewState(c.body||'',head)?.state)
  .filter(Boolean);
 return states.at(-1)||'unknown';
}
// A question is an escalation, never an approval. Reuse the existing PR-body
// marker and label. Only a trusted same-repository PR/body or trusted comment
// may supply its text. A label with incomplete evidence still blocks nudges.
function ownerQuestion(p,repo){
 const sameRepo=typeof repo==='string'&&p.headRepository?.nameWithOwner===repo;
 const body=sameRepo&&trusted(p.authorAssociation)?parseOwnerQuestion(p.body):null;
 const labeled=(p.labels?.nodes||[]).some(l=>l.name==='needs-owner-decision');
 const markerPresent=sameRepo&&trusted(p.authorAssociation)&&
  /<!-- aicafe-owner-question\s/.test(p.body||'');
 if(body)return {status:'requested',question:body,url:p.url};
 if(labeled){
  const latest=[...(p.comments?.nodes||[])].reverse().find(c=>
   trusted(c.authorAssociation)&&!c.author?.login?.endsWith('[bot]')&&parseOwnerQuestion(c.body));
  if(latest)return {status:'requested',question:parseOwnerQuestion(latest.body),url:p.url};
  return {status:'missing_details',question:'Owner decision requested; exact question missing. Ask the coding chat to publish it on this PR.',url:p.url};
 }
 if(markerPresent)return {status:'missing_details',question:'Invalid or multiple owner-question markers. Ask the coding chat for one precise decision.',url:p.url};
 if(!p.labels||p.labels.pageInfo?.hasNextPage||!Array.isArray(p.labels.nodes))
  return {status:'unverified',question:'Owner decision label evidence incomplete; inspect the PR before continuing.',url:p.url};
 return null;
}
// The coder's report is a handoff, never proof of successful execution.
function workflowHandoff(p,repo){
 if(!trusted(p.authorAssociation)||p.headRepository?.nameWithOwner!==repo)return null;
 const matches=[...(p.body||'').matchAll(/<!-- aicafe-workflow-handoff (\{[^\n]{1,2000}\}) -->/g)];
 if(matches.length!==1)return null;
 try{
  const h=JSON.parse(matches[0][1]);
  if(h.head!==p.headRefOid||!['working','waiting_ci','waiting_codex','waiting_luna','blocked_external'].includes(h.state)||
   typeof h.next!=='string'||!h.next.trim()||h.next.length>500||
   typeof h.id!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(h.id))return null;
  const run=h.run_url==null?null:String(h.run_url);
  const prefix='https://github.com/'+repo+'/actions/runs/';
  const runId=run?.startsWith(prefix)?run.slice(prefix.length):null;
  if(run!==null&&(!runId||!/^\d{1,20}$/.test(runId)))return null;
  if(h.state==='waiting_luna'&&!runId)return null;
  return {state:h.state,head:h.head,id:h.id,next:h.next,run_url:run,run_id:runId};
 }catch{return null;}
}
// Use the same authenticated connector for a named shared Luna run. The
// candidate SHA comes from the handoff; the run's server head can be main.
// A terminal run is only a reason to resume, never Luna acceptance evidence.
export async function observeHandoffRuns(facts,readRun){
 for(const p of facts.prs||[]){
  const h=p.workflow_handoff;
  if(h?.state!=='waiting_luna')continue;
  h.observed='unknown';
  try{
   const run=await readRun(h.run_id);
   if(String(run?.id)!==h.run_id||run.html_url!==h.run_url||
    run.name!=='AI CAFE Shared Owner-Gated Luna Scenarios')continue;
   h.observed=run.status==='completed'?'completed':
    ['queued','in_progress','pending','waiting','requested'].includes(run.status)?'pending':'unknown';
   h.conclusion=h.observed==='completed'?run.conclusion:null;
  }catch{/* Unknown is not a pass; the next existing poll can retry. */}
 }
 return facts;
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
   codex:codexStatus(p.comments?.nodes,p.headRefOid),
   owner_question:ownerQuestion(p,repo.nameWithOwner),
   workflow_handoff:workflowHandoff(p,repo.nameWithOwner)});
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
  if(entry.stage==='waiting_owner'&&!(fresh&&byPr.get(entry.pr_number)?.owner_question)&&millis(entry.updated_at)!==null&&
   clock-millis(entry.updated_at)>=ownerReminderMinutes*60000)
   emit('remind_owner',task,entry.pr_number,null,entry.chat_url||null,
     'Review the proposed architecture in the existing chat',
     String(entry.revision));
 }
 if(!fresh)return {fresh:false,actions,blocked:[{reason:'github_evidence_stale_or_unavailable'}]};
 // The PR itself declares the blocker, even when Muse has no saved chat URL.
 // Deduplicate by PR + exact question, not commit SHA or mutable note revision.
 for(const p of facts.prs||[]){
  const q=p.owner_question;
  if(!q)continue;
  const entry=Object.values(records).find(e=>e.pr_number===p.number);
  if(q.status==='unverified'||q.status==='missing_details'){
   blocked.push({task_id:entry?.task_id??null,pr_number:p.number,reason:q.question});
   // Route an incomplete question back to the coder, not an owner approval.
   if(entry?.chat_url)emit('continue_chat',entry.task_id,p.number,p.head_sha,entry.chat_url,q.question,'owner_question_details');
   continue;
  }
  actions.push({id:identity(['owner_question',p.number,q.question]),kind:'remind_owner',
   task_id:entry?.task_id??null,pr_number:p.number,head_sha:p.head_sha,
   chat_url:entry?.chat_url||null,pr_url:p.url,owner_question:true,reason:q.question});
 }
 for(const entry of Object.values(records)){
  if(!entry.pr_number||entry.stage==='paused')continue;
  const p=byPr.get(entry.pr_number);
  if(!p){
   if(!(facts.merged_prs||[]).some(v=>v.number===entry.pr_number))
    blocked.push({task_id:entry.task_id,pr_number:entry.pr_number,
     reason:'pr_missing_or_closed_unmerged_verify_github'});
   continue;
  }
  if(p.owner_question)continue;
  const head=p.head_sha;
  const before=seen.find(v=>v.number===p.number),h=p.workflow_handoff;
  if(entry.stage==='waiting_owner'&&!before?.owner_question&&!h)continue;
  let kind=null,reason=null,extra='';
  if(h?.state==='waiting_luna'){
   if(h.observed!=='completed'){
    if(h.observed!=='pending')blocked.push({task_id:entry.task_id,pr_number:p.number,
     reason:'Luna run status unknown; verify '+h.run_url});
    continue;
   }
   kind='continue_chat';reason='Shared Luna run completed ('+(h.conclusion||'unknown')+'); verify actual artifacts and '+h.next;
   extra='luna:'+h.id+':'+h.run_id;
  }else if(h?.state==='blocked_external'){
   blocked.push({task_id:entry.task_id,pr_number:p.number,reason:h.next});continue;
  }else if(h?.state==='waiting_ci'){
   if(!['observed_green','failure'].includes(p.ci))continue;
   kind=p.ci==='failure'?'fix_ci':'continue_chat';
   reason='Reported CI wait ended ('+p.ci+'); '+h.next;extra='ci:'+h.id;
  }else if(h?.state==='waiting_codex'){
   if(!['clean','findings'].includes(p.codex))continue;
   kind=p.codex==='findings'?'fix_codex':'continue_chat';
   reason='Reported Codex wait ended ('+p.codex+'); '+h.next;extra='codex:'+h.id;
  }else if(before?.owner_question?.status==='requested'){
   kind='continue_chat';reason='Owner question removed; verify actual owner decision before continuing';
   extra=identity(['owner_answer',before.owner_question.question]);
  }
  else if(p.ci==='failure'){kind='fix_ci';reason='Investigate current-head failing checks and rerun';}
  else if(p.codex==='findings'){kind='fix_codex';reason='Address exact-head Codex findings and retest';}
  else if(!p.draft&&p.ci==='observed_green'&&p.codex==='clean'){
   kind='verify_merge';reason='Verify required CI, approval, security and acceptance gates; merge only if eligible';
  }else if(before?.head_sha===head&&before.ci==='pending'&&p.ci==='observed_green'&&p.codex!=='pending'){
   kind='continue_chat';reason='Current-head CI completed green; continue verification and next eligible step';
  }else if(entry.stage!=='ready_review'&&
    (millis(p.committed_at)!==null&&clock-millis(p.committed_at)>=idleMinutes*60000)&&
    p.ci!=='pending'&&p.codex!=='pending'){
   kind='continue_chat';reason='No recent commit; inspect actual work and continue if not actively running';
  }
  if(!kind)continue;
  if(!entry.chat_url){blocked.push({task_id:entry.task_id,pr_number:p.number,
    reason:'missing_verified_chat_url'});continue;}
  emit(kind,entry.task_id,p.number,head,entry.chat_url,reason,extra);
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
 // A completed/withdrawn PR question is no longer an outstanding suggestion.
 // Never infer withdrawal from an unavailable GitHub read or alter delivery receipts.
 if(planned.fresh){
  const active=new Set(planned.actions.filter(a=>a.owner_question).map(a=>a.id));
  for(const e of Object.values(next.events))
   if(e.owner_question&&e.status==='suggested_unverified'&&!active.has(e.id))e.status='superseded';
 }
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
  try{facts=await fetchGithubFacts({repo,token,fetchImpl,now});
   await observeHandoffRuns(facts,async id=>{
    const res=await fetchImpl('https://api.github.com/repos/'+repo+'/actions/runs/'+id,{
     headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
    if(!res.ok)throw Error('Run read unavailable HTTP '+res.status);
    return res.json();
   });
  }
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
