// Git transport only. Never authorize a GitHub action with a prompt/receipt.
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {queueOwnerIssue} from './alerts.mjs';
import {assertLedgerShape,sanitizeLedger} from './ledger.mjs';
import {compactPrivateLedger} from './ledger-compaction.mjs';
import {renderPrivateQueue} from './private-owner-view.mjs';
import {settings} from './settings.mjs';

const validRepo = value => typeof value==='string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value);
const validBranch = value => typeof value==='string' &&
  /^[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..') &&
  !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock');
export function gitAuthEnvironment(token,base=process.env) {
  if(!token)throw Error('Missing authorized Git transport credential');
  // Secret is passed in an environment value, never command arguments or URLs.
  const existing=Number(base.GIT_CONFIG_COUNT||0);
  if(!Number.isInteger(existing)||existing<0||existing>20)throw Error('Unsafe Git configuration');
  return {...base,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:String(existing+1),
    ['GIT_CONFIG_KEY_'+existing]:'http.https://github.com/.extraheader',
    ['GIT_CONFIG_VALUE_'+existing]:'AUTHORIZATION: basic '+
      Buffer.from('x-access-token:'+token).toString('base64')};
}
function git(args,{cwd,env,run=spawnSync,timeout=90000}={}) {
  const r=run('git',args,{cwd,env,encoding:'utf8',timeout,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe']});
  if(r.error||r.status!==0)throw Error('Git '+args[0]+' failed (exit '+(r.status??'transport')+')');
  return String(r.stdout||'').trim();
}
function saveCompactionArchive(root,result) {
  if(!result.archive)return [];
  const file=join(root,result.archive.path);
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  // Private archive is committed atomically with the compacted active ledger.
  writeFileSync(file,result.archive.content,{mode:0o600,flag:'wx'});
  return [result.archive.path];
}
const gitUrl = repo => {
  if(!validRepo(repo))throw Error('Invalid Git repository');
  return 'https://github.com/'+repo+'.git';
};
function identity(name){return ['-c','user.name=Universal Dispatcher','-c','user.email=dispatcher@users.noreply.github.com',...name];}

// A normal Git merge + push, not the GitHub update-branch endpoint.
// Never use the Actions GITHUB_TOKEN here: its generated PR events require approval.
export function updateBranchViaGit({repo=settings.repo,branch,expectedHeadSha,
  token,remoteUrl=null,run=spawnSync}={}) {
  if(!validRepo(repo)||!validBranch(branch)||branch==='main'||
    !/^[a-f0-9]{40}$/.test(expectedHeadSha||''))
    throw Error('Unverified Git branch update');
  if(!token) return {status:'missing_git_credential'};
  const root=mkdtempSync(join(tmpdir(),'dispatcher-branch-'));
  try{
    const env=gitAuthEnvironment(token);
    git(['init','-q'],{cwd:root,env,run});
    git(['remote','add','origin',remoteUrl||gitUrl(repo)],{cwd:root,env,run});
    git(['fetch','--no-tags','origin',
      '+refs/heads/main:refs/remotes/origin/main',
      '+refs/heads/'+branch+':refs/remotes/origin/pr'],{cwd:root,env,run});
    const actual=git(['rev-parse','refs/remotes/origin/pr'],{cwd:root,env,run});
    if(actual!==expectedHeadSha)return {status:'stale_head'};
    const base=git(['rev-parse','refs/remotes/origin/main'],{cwd:root,env,run});
    if(base===actual)return {status:'already_current'};
    git(['checkout','-q','--detach',actual],{cwd:root,env,run});
    try {
      git(identity(['merge','-q','--no-ff','--no-edit',base]),{cwd:root,env,run});
    }catch(error) {
      // Only an actual unmerged file is a coder conflict. Infrastructure,
      // authentication and Git transport errors use the generic failure path.
      const unresolved=git(['diff','--name-only','--diff-filter=U'],{cwd:root,env,run});
      if(unresolved)return {status:'conflict_needs_coder'};
      throw error;
    }
    const merged=git(['rev-parse','HEAD'],{cwd:root,env,run});
    if(merged===actual)return {status:'already_current'};
    try{git(['push','origin','HEAD:refs/heads/'+branch],{cwd:root,env,run});}
    catch{return {status:'push_failed_needs_retry'};}
    return {status:'updating',old_head_sha:actual,new_head_sha:merged,new_base_sha:base};
  } finally {rmSync(root,{recursive:true,force:true});}
}

// A generic fallback for ANY failed normal Muse publication or fatal dispatcher
// step. Writes the SAME state.json + owner-queue.md by Git, not REST API.
// Existing Muse owner_notice delivery + authenticated receipts remain unchanged.
export function publishEmergencyViaGit({repo=settings.ledger.repo,
  token,kind='dispatcher_emergency',identity:incidentId,message,needs,
  resetAt=null,targetRepo=settings.repo,remoteUrl=null,run=spawnSync,
  retry=3}={}) {
  if(!validRepo(repo)||repo!==settings.ledger.repo||!validRepo(targetRepo)||
    !/^[a-z0-9_.:-]{1,128}$/i.test(incidentId||'') ||
    typeof message!=='string'||!message.trim()||!token)
    throw Error('Invalid emergency notification inputs');
  if(!Number.isInteger(retry)||retry<1||retry>4)throw Error('Unsafe Git retry count');
  const env=gitAuthEnvironment(token);
  for(let attempt=0;attempt<retry;attempt++){
    const root=mkdtempSync(join(tmpdir(),'dispatcher-emergency-'));
    try{
      git(['clone','-q','--depth','1','--branch','main',remoteUrl||gitUrl(repo),root],{env,run});
      const statePath=join(root,settings.ledger.path);
      const state=assertLedgerShape(JSON.parse(readFileSync(statePath,'utf8')));
      // A failed workflow may reach this generic fallback after a primary
      // rate-limit incident was already queued. Do not spam per-run duplicates.
      const pauseUntil=Date.parse(state.api_pause?.until||'');
      if(incidentId.startsWith('run:')&&Number.isFinite(pauseUntil)&&
         Date.now()<pauseUntil){
        const prior=Object.values(state.owner_alerts||{}).find(n=>
          n.kind==='dispatcher_emergency'&&
          n.identity===state.api_pause.identity&&
          ['planned','submitted','claimed','uncertain'].includes(n.status));
        if(prior)return {status:'already_queued',notice_hash:prior.notice_hash};
      }
      const existing=Object.values(state.owner_alerts||{}).find(n=>
        n.kind===kind&&n.identity===incidentId&&['planned','submitted'].includes(n.status));
      if(existing)return {status:'already_queued',notice_hash:existing.notice_hash};
      // One failed GitHub run can cause multiple observer runs; do not grow
      // state.json with one new "emergency" per run while reconciling is broken.
      const recent=kind==='dispatcher_emergency'
        ?Object.values(state.owner_alerts||{}).find(n=>
          n.kind===kind&&['planned','submitted','claimed','uncertain'].includes(n.status)&&
          Date.now()-Date.parse(n.created_at||'')<60*60*1000)
        :null;
      if(recent)return {status:'already_queued',notice_hash:recent.notice_hash};
      const next=queueOwnerIssue(state,{kind,identity:incidentId,
        message:'Dispatcher '+targetRepo+': '+message.slice(0,500),
        needs:needs||'Muse notify owner; dispatcher will retry safely'});
      next.updated_at=new Date().toISOString();
      const reset=Date.parse(resetAt||'');
      if(Number.isFinite(reset)&&reset>Date.now()&&reset-Date.now()<24*60*60*1000){
        next.api_pause={until:new Date(reset).toISOString(),
          identity:incidentId,reason:'github_api_rate_limit'};
      }
      sanitizeLedger(next);
      const compacted=compactPrivateLedger(next);
      writeFileSync(statePath,JSON.stringify(compacted.state,null,2)+'\n');
      const archived=saveCompactionArchive(root,compacted);
      const viewPath=join(root,settings.ledger.owner_view_path);
      mkdirSync(dirname(viewPath),{recursive:true});
      writeFileSync(viewPath,renderPrivateQueue(compacted.state,{repo})+'\n');
      git(['add','--',settings.ledger.path,settings.ledger.owner_view_path,...archived],{cwd:root,env,run});
      git(identity(['commit','-q','-m','chore(dispatcher): queue emergency owner notice']),{cwd:root,env,run});
      try{
        git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
        const item=Object.values(compacted.state.owner_alerts).filter(n=>
          n.kind===kind&&n.identity===incidentId&&n.status==='planned')
          .sort((a,b)=>(b.incident_cycle||0)-(a.incident_cycle||0))[0];
        if(!item)throw Error('Emergency incident identity not verified after Git push');
        return {status:'queued',notice_hash:item.notice_hash};
      } catch {
        if(attempt===retry-1)throw Error('Emergency Git queue push failed after bounded retries');
      }
    } finally {rmSync(root,{recursive:true,force:true});}
  }
  throw Error('Emergency delivery unconfirmed');
}


// Read the owner dashboard and Muse status through Git transport, avoiding
// GitHub REST quota use on every refresh. This is a read, never an approval.
export function readLedgerViaGit({repo=settings.ledger.repo,token,
  remoteUrl=null,run=spawnSync}={}) {
 if(repo!==settings.ledger.repo||!token)throw Error('Private ledger Git read not authorized');
 const root=mkdtempSync(join(tmpdir(),'dispatcher-ledger-read-'));
 try{
  git(['clone','-q','--depth','1','--branch','main',
    remoteUrl||gitUrl(repo),root],{env:gitAuthEnvironment(token),run});
  const file=join(root,settings.ledger.path);
  return assertLedgerShape(JSON.parse(readFileSync(file,'utf8')));
 }finally{rmSync(root,{recursive:true,force:true});}
}

// Durable private-ledger compare-and-swap over ordinary Git. Concurrent
// writers are rejected by the non-force main push and retried from fresh main.
// Muse reads the exact same state.json and projection as before.
export async function transactLedgerViaGit({repo=settings.ledger.repo,token,
  transform,maxRetries=3,remoteUrl=null,run=spawnSync}={}) {
 if(repo!==settings.ledger.repo||!token||typeof transform!=='function'||
    !Number.isInteger(maxRetries)||maxRetries<1||maxRetries>5)
   throw Error('Invalid Git ledger transaction');
 const env=gitAuthEnvironment(token);
 for(let attempt=0;attempt<maxRetries;attempt++){
  const root=mkdtempSync(join(tmpdir(),'dispatcher-ledger-txn-'));
  try{
   git(['clone','-q','--depth','1','--branch','main',
     remoteUrl||gitUrl(repo),root],{env,run});
   const file=join(root,settings.ledger.path);
   const state=assertLedgerShape(JSON.parse(readFileSync(file,'utf8')));
   const updated=await transform(structuredClone(state));
   if(updated===null)return {committed:false,state};
   updated.updated_at=new Date().toISOString();
   updated.owner_alerts||={};
   sanitizeLedger(updated);
   const compacted=compactPrivateLedger(updated);
   writeFileSync(file,JSON.stringify(compacted.state,null,2)+'\n');
   const archived=saveCompactionArchive(root,compacted);
   const view=join(root,settings.ledger.owner_view_path);
   mkdirSync(dirname(view),{recursive:true});
   writeFileSync(view,renderPrivateQueue(compacted.state,{repo})+'\n');
   git(['add','--',settings.ledger.path,settings.ledger.owner_view_path,...archived],{cwd:root,env,run});
   if(!git(['status','--porcelain'],{cwd:root,env,run}))
     return {committed:false,state};
   const old=git(['rev-parse','HEAD'],{cwd:root,env,run});
   git(identity(['commit','-q','-m','chore(dispatcher): reconcile private task ledger']),
     {cwd:root,env,run});
   try{
    git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
    return {committed:true,state:compacted.state};
   }catch{
    const remote=git(['ls-remote','origin','refs/heads/main'],{cwd:root,env,run})
      .split(/\s+/)[0];
    if(remote===old)throw Error('Git ledger push unavailable, not a CAS conflict');
    if(attempt===maxRetries-1)throw Error('Git ledger CAS retry limit reached');
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 throw Error('Git ledger retry limit reached');
}

export function publishOwnerQueueViaGit({repo=settings.ledger.repo,token,
  remoteUrl=null,run=spawnSync,maxRetries=3}={}) {
 if(repo!==settings.ledger.repo||!token)throw Error('Invalid private queue Git transport');
 const env=gitAuthEnvironment(token);
 for(let i=0;i<maxRetries;i++){
  const root=mkdtempSync(join(tmpdir(),'dispatcher-private-queue-'));
  try{
   git(['clone','-q','--depth','1','--branch','main',
     remoteUrl||gitUrl(repo),root],{env,run});
   const state=assertLedgerShape(JSON.parse(
     readFileSync(join(root,settings.ledger.path),'utf8')));
   state.owner_alerts||={};
   const view=renderPrivateQueue(state,{repo})+'\n';
   const file=join(root,settings.ledger.owner_view_path);
   mkdirSync(dirname(file),{recursive:true});
   let prior='';
   try{prior=readFileSync(file,'utf8');}catch{}
   if(prior===view)return {status:'unchanged'};
   writeFileSync(file,view);
   git(['add','--',settings.ledger.owner_view_path],{cwd:root,env,run});
   const old=git(['rev-parse','HEAD'],{cwd:root,env,run});
   git(identity(['commit','-q','-m','chore(dispatcher): refresh private Muse queue']),
     {cwd:root,env,run});
   try{
    git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
    return {status:'updated'};
   }catch{
    const remote=git(['ls-remote','origin','refs/heads/main'],{cwd:root,env,run})
      .split(/\s+/)[0];
    if(remote===old)throw Error('Private owner queue Git push unavailable');
    if(i===maxRetries-1)throw Error('Private owner queue CAS retries exhausted');
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 throw Error('Private owner queue Git retries exhausted');
}

export function readApiPauseViaGit({repo=settings.ledger.repo,token,
  remoteUrl=null,run=spawnSync}={}) {
 if(repo!==settings.ledger.repo||!token)throw Error('Private queue credential required');
 const root=mkdtempSync(join(tmpdir(),'dispatcher-api-pause-'));
 try{
  git(['clone','-q','--depth','1','--branch','main',
    remoteUrl||gitUrl(repo),root],{env:gitAuthEnvironment(token),run});
  const state=assertLedgerShape(JSON.parse(readFileSync(join(root,settings.ledger.path),'utf8')));
  const until=Date.parse(state.api_pause?.until||'');
  return Number.isFinite(until)&&state.api_pause?.reason==='github_api_rate_limit'
    ?{until:new Date(until).toISOString(),identity:state.api_pause.identity}
    :null;
 }finally{rmSync(root,{recursive:true,force:true});}
}
