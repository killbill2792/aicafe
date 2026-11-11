// Git transport only. Never authorize a GitHub action with a prompt/receipt.
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {queueOwnerIssue} from './alerts.mjs';
import {assertLedgerShape,sanitizeLedger} from './ledger.mjs';
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
    }catch {
      return {status:'conflict_needs_coder'};
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
  targetRepo=settings.repo,remoteUrl=null,run=spawnSync,
  retry=3}={}) {
  if(!validRepo(repo)||repo!==settings.ledger.repo||!validRepo(targetRepo)||
    !/^[a-z0-9_:-]{1,128}$/i.test(incidentId||'') ||
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
      const existing=Object.values(state.owner_alerts||{}).find(n=>
        n.kind===kind&&n.identity===incidentId&&['planned','submitted'].includes(n.status));
      if(existing)return {status:'already_queued',notice_hash:existing.notice_hash};
      const next=queueOwnerIssue(state,{kind,identity:incidentId,
        message:'Dispatcher '+targetRepo+': '+message.slice(0,500),
        needs:needs||'Muse notify owner; dispatcher will retry safely'});
      next.updated_at=new Date().toISOString();
      sanitizeLedger(next);
      writeFileSync(statePath,JSON.stringify(next,null,2)+'\n');
      const viewPath=join(root,settings.ledger.owner_view_path);
      mkdirSync(dirname(viewPath),{recursive:true});
      writeFileSync(viewPath,renderPrivateQueue(next,{repo})+'\n');
      git(['add','--',settings.ledger.path,settings.ledger.owner_view_path],{cwd:root,env,run});
      git(identity(['commit','-q','-m','chore(dispatcher): queue emergency owner notice']),{cwd:root,env,run});
      try{
        git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
        const item=Object.values(next.owner_alerts).find(n=>n.kind===kind&&n.identity===incidentId);
        return {status:'queued',notice_hash:item.notice_hash};
      } catch {
        if(attempt===retry-1)throw Error('Emergency Git queue push failed after bounded retries');
      }
    } finally {rmSync(root,{recursive:true,force:true});}
  }
  throw Error('Emergency delivery unconfirmed');
}
