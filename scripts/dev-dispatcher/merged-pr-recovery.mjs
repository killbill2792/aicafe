// Git-first, bounded discovery of merged PRs missing from the private ledger.
// A merge commit is evidence of existence, NOT of scope approval/integration.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gitAuthEnvironment} from './git-operations.mjs';
import {settings} from './settings.mjs';
import {parseTaskMarker,parseChatMarker} from './github.mjs';
import {queueOwnerIssue} from './alerts.mjs';
const SHA=/^[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function git(args,{cwd,env,run=spawnSync}={}){
 const result=run('git',args,{cwd,env,encoding:'utf8',timeout:90000,
  maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)throw Error('Git merged-history '+args[0]+' unavailable');
 return String(result.stdout||'').trim();
}
export function recentMergeTitles(history,{taskIds=[],maxResults=5}={}){
 const ids=new Set(taskIds.filter(id=>ID.test(id)));
 const found=[],seen=new Set();
 for(const line of String(history||'').split('\n')){
  const tab=line.indexOf('\t');
  if(tab<0)continue;
  const merge_sha=line.slice(0,tab),title=line.slice(tab+1);
  if(!SHA.test(merge_sha))continue;
  const match=title.match(/(?:\(#|Merge pull request #)(\d+)\b/i);
  if(!match)continue;
  const pr_number=Number(match[1]);
  if(!Number.isSafeInteger(pr_number)||seen.has(pr_number))continue;
  // Git title is only a cheap filter. Actual PR body marker and owner
  // authentication are validated independently by GitHub before linking.
  const possible=[...ids].filter(id=>new RegExp(
    '(?:^|[^a-z0-9])task[\\s_:#-]*'+id+'(?:$|[^a-z0-9])','i').test(title));
  if(possible.length!==1)continue;
  found.push({task_id:possible[0],pr_number,merge_sha,title});
  seen.add(pr_number);
  if(found.length>=maxResults)break;
 }
 return found;
}
export function gitMergedHistory({repo=settings.repo,token,expectedMainSha,
  maxCommits=200,run=spawnSync,remoteUrl=null}={}){
 if(repo!==settings.repo||!token||!SHA.test(expectedMainSha||'')||
  !Number.isInteger(maxCommits)||maxCommits<10||maxCommits>300)
   throw Error('Unverified Git merged history inputs');
 const root=mkdtempSync(join(tmpdir(),'aicafe-merged-pr-'));
 try{
  const env=gitAuthEnvironment(token);
  git(['clone','-q','--depth',String(maxCommits),'--branch','main',
    remoteUrl||'https://github.com/'+repo+'.git',root],{env,run});
  if(git(['rev-parse','HEAD'],{cwd:root,env,run})!==expectedMainSha)
    throw Error('Git merged history not at current trusted main SHA');
  return git(['log','--first-parent','-n',String(maxCommits),
    '--format=%H%x09%s'],{cwd:root,env,run});
 }finally{rmSync(root,{recursive:true,force:true});}
}
export function eligibleMissingTaskIds(state){
 return Object.entries(state?.tasks||{}).filter(([id,rec])=>
  ID.test(id)&&rec?.approved===true&&!Number.isInteger(rec.pr_number)&&
  !!rec.approval_hash&&!!state.scope_authorizations?.[id]&&
  typeof rec.branch==='string'&&rec.branch.startsWith(settings.naming.branch_prefix+id))
  .map(([id])=>id);
}
export async function discoverMergedPrEvidence({github,state,mainSha,
  now=new Date().toISOString(),gitHistory=gitMergedHistory}={}){
 const missing=eligibleMissingTaskIds(state);
 if(!missing.length)return {candidates:[],blocked:[],checked:false};
 const prior=Date.parse(state.merged_pr_discovery_at||'');
 // Bound public GitHub reads when a task's PR was never produced or is
 // still open. A failed fetch never invents a negative PR conclusion.
 if(Number.isFinite(prior)&&Date.parse(now)-prior<60*60000)
   return {candidates:[],blocked:[],checked:false};
 const history=gitHistory({repo:settings.repo,token:process.env.GITHUB_TOKEN,
   expectedMainSha:mainSha});
 const likely=recentMergeTitles(history,{taskIds:missing,maxResults:5});
 const candidates=[],blocked=[];
 for(const item of likely){
  try{
   const pr=await github.request('/pulls/'+item.pr_number);
   if(!pr?.merged_at||pr.merge_commit_sha!==item.merge_sha||
     parseTaskMarker(pr.body)!==item.task_id||
     pr.user?.login!==settings.owner.login||
     pr.head?.repo?.full_name!==settings.repo||
     pr.base?.repo?.full_name!==settings.repo||
     pr.base?.ref!=='main'||
     !pr.head?.ref?.startsWith(settings.naming.branch_prefix+item.task_id)||
     !SHA.test(pr.head?.sha||'')){
    blocked.push({...item,reason:'merged_pr_identity_unverified'});
    continue;
   }
   const total=Number(pr.changed_files);
   if(!Number.isInteger(total)||total<1||total>300){
    blocked.push({...item,reason:'merged_pr_diff_count_unbounded'});continue;
   }
   const entries=[];
   for(let page=1;page<=Math.ceil(total/100);page++){
    const part=await github.request('/pulls/'+item.pr_number+
      '/files?per_page=100&page='+page);
    if(!Array.isArray(part))throw Error('Incomplete PR changed-file page');
    entries.push(...part);
   }
   // Count GitHub file entries separately from their effective edit paths:
   // a rename changes BOTH the old source and the new destination.
   if(entries.length!==total||new Set(entries.map(f=>f.filename)).size!==total||
      entries.some(f=>typeof f.filename!=='string'||
        !f.filename.length||
        (f.status==='renamed'&&
         (typeof f.previous_filename!=='string'||!f.previous_filename.length)))){
    blocked.push({...item,reason:'merged_pr_changed_files_incomplete'});continue;
   }
   const paths=[...new Set(entries.flatMap(f=>
     f.status==='renamed'?[f.previous_filename,f.filename]:[f.filename]))];
   const approved=state.scope_authorizations?.[item.task_id];
   const unsigned=paths.filter(path=>!approved?.edits?.includes(path));
   candidates.push({...item,head_sha:pr.head.sha,branch:pr.head.ref,
     base_branch:pr.base.ref,merged_at:pr.merged_at,
     conversation_url:parseChatMarker(pr.body),
     unsigned_files:unsigned});
  }catch(error){
   blocked.push({...item,reason:'merged_pr_evidence_fetch_unavailable'});
  }
 }
 return {candidates,blocked,checked:true};
}
export function applyMergedPrEvidence(state,observation,now=new Date().toISOString()){
 const next=structuredClone(state);
 if(observation?.checked)next.merged_pr_discovery_at=now;
 for(const item of observation?.candidates||[]){
  const rec=next.tasks?.[item.task_id];
  if(!rec||Number.isInteger(rec.pr_number)||rec.approved!==true||
    !next.scope_authorizations?.[item.task_id]||
    !SHA.test(item.merge_sha||'')||!SHA.test(item.head_sha||''))
   continue;
  // Technical facts only. Never rewrite approval, scope or coding receipts.
  rec.pr_number=item.pr_number;
  rec.github_state='merged';rec.status='merged';
  rec.head_sha=item.head_sha;rec.merge_sha=item.merge_sha;
  rec.branch=item.branch;rec.base_branch=item.base_branch;
  rec.merged_at=item.merged_at;
  rec.pr_link_recovery='verified_git_merge_and_owner_pr_marker';
  rec.recovered_pr_unsigned_files=item.unsigned_files;
  // A verified historical merge supersedes undelivered coding instructions
  // for this task. Retain claimed/submitted/uncertain receipts for audit and
  // never touch any other task (including an independent Task 9).
  for(const action of Object.values(next.actions||{})){
    if(action.task_id===item.task_id&&action.status==='planned'&&
      action.type!=='landing_failed')
      action.status='cancelled_merged_pr_recovered';
  }
  if(item.conversation_url&&item.conversation_url===rec.conversation_ref){
   next.pr_chat_links||={};
   next.pr_chat_links[String(item.pr_number)]={task_id:item.task_id,
     branch:item.branch,conversation_url:item.conversation_url,
     head_sha:item.head_sha,updated_at:now};
  }
  if(item.unsigned_files?.length){
   const notice=queueOwnerIssue(next,{kind:'merged_pr_scope_audit',
    task_id:item.task_id,pr_number:item.pr_number,
    identity:item.merge_sha,
    message:'Merged PR #'+item.pr_number+' is now linked to Task '+item.task_id+
      ', but its changed-file list contains paths outside the signed ledger scope.',
    needs:'Owner reconcile previously approved scope exceptions before marking integration proven'});
   next.owner_alerts=notice.owner_alerts;
  }
 }
 for(const failure of observation?.blocked||[]){
  const notice=queueOwnerIssue(next,{kind:'merged_pr_discovery_blocked',
   task_id:failure.task_id,pr_number:failure.pr_number,
   identity:failure.merge_sha+':'+failure.reason,
   message:'Historical merged PR #'+failure.pr_number+
     ' could not be linked safely: '+failure.reason,
   needs:'Review authenticated PR owner, exact task marker and full changed-file evidence'});
  next.owner_alerts=notice.owner_alerts;
 }
 return next;
}


// Technical merge discovery never grants unsigned code its integration gate.
export function recoveredMergeIntegrationAllowed(record){
 return !Array.isArray(record?.recovered_pr_unsigned_files)||
   record.recovered_pr_unsigned_files.length===0;
}
