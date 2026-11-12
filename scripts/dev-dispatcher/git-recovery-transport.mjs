// Private Git transport for durable Muse -> GitHub recovery hints.
// A signed file survives a cancelled GitHub Actions run; repository_dispatch
// is merely an optional fast wake. Neither transport grants scope or merge authority.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {settings} from './settings.mjs';
import {recoveryIdentity,RECOVERY_INTENTS} from './recovery-v3.mjs';
import {gitAuthEnvironment} from './git-operations.mjs';
const SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/;
const REPO=/^[\w.-]+\/[\w.-]+$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DIR='dispatcher/recovery-requests';
const DOMAIN='AI-CAFE signed Muse Git recovery v1\n';
const MAX_FILES=1000,MAX_FILE_BYTES=8192;
const allowed=new Set(RECOVERY_INTENTS);
function keyBuffer(secret){
 if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32)
   throw Error('Muse Git recovery signing key is not configured securely');
 return Buffer.from(secret,'utf8');
}
function command(raw){
 const p=raw||{};
 const cmd={version:1,repo:p.repo,actor:p.actor,intent:p.intent,
   task_id:p.task_id??null,pr_number:p.pr_number??null,
   expected_head_sha:p.expected_head_sha??null,requested_at:p.requested_at,
   request_id:p.request_id};
 const global=cmd.intent==='RECONCILE'&&cmd.task_id===null&&
   cmd.pr_number===null&&cmd.expected_head_sha===null;
 if(p.version!==1||!REPO.test(cmd.repo||'')||!ID.test(cmd.actor||'')||
    !allowed.has(cmd.intent)||!Number.isFinite(Date.parse(cmd.requested_at||''))||
    (!global&&(!ID.test(cmd.task_id||'')||
      !Number.isSafeInteger(cmd.pr_number)||cmd.pr_number<1||
      !SHA.test(cmd.expected_head_sha||''))))
   throw Error('Invalid signed Muse recovery request');
 const computed=recoveryIdentity(cmd);
 if(!HASH.test(cmd.request_id||'')||computed!==cmd.request_id)
   throw Error('Muse recovery request identity mismatch');
 return cmd;
}
function mac(cmd,secret){
 return createHmac('sha256',keyBuffer(secret))
   .update(DOMAIN+JSON.stringify([cmd.version,cmd.repo,cmd.actor,
    cmd.intent,cmd.task_id,cmd.pr_number,cmd.expected_head_sha,
    cmd.requested_at,cmd.request_id])).digest('hex');
}
export function signMuseGitRecovery(request,secret){
 const cmd=command(request);
 if(cmd.repo!==settings.repo)throw Error('Signed recovery repository mismatch');
 return {version:1,request:cmd,signature:mac(cmd,secret)};
}
export function verifyMuseGitRecovery(envelope,{secret,actors={},now=new Date().toISOString()}={}){
 if(!envelope||envelope.version!==1||typeof envelope.signature!=='string'||
    !HASH.test(envelope.signature))throw Error('Invalid Muse recovery envelope');
 const cmd=command(envelope.request);
 if(cmd.repo!==settings.repo||actors[cmd.actor]!=='muse')
   throw Error('Unauthorized Muse recovery actor/repository');
 const expected=Buffer.from(mac(cmd,secret),'hex');
 if(!timingSafeEqual(expected,Buffer.from(envelope.signature,'hex')))
   throw Error('Muse Git recovery signature mismatch');
 const clock=Date.parse(now),stamp=Date.parse(cmd.requested_at);
 // Cancelled Actions may delay intake. Preserve the command for a bounded
 // window, then reject it. Exact-head validation remains mandatory on intake.
 if(!Number.isFinite(clock)||stamp>clock+120000||clock-stamp>7*86400000)
   throw Error('Expired or future Muse Git recovery command');
 return cmd;
}
export function scanMuseGitRecoveryDirectory(root,{secret,actors={},now,
  processed={}}={}){
 const dir=join(root,DIR),accepted=[],rejected=[];
 if(!existsSync(dir))return {accepted,rejected,complete:true};
 if(!lstatSync(dir).isDirectory())throw Error('Invalid Muse Git recovery directory');
 const names=readdirSync(dir).sort();
 if(names.length>MAX_FILES)throw Error('Muse Git recovery inbox requires bounded archival');
 for(const filename of names){
  if(!HASH.test(filename.slice(0,-5))||!filename.endsWith('.json')){
    rejected.push({file:filename,reason:'invalid_recovery_filename'});continue;
  }
  if(processed[filename])continue;
  try{
   const path=join(dir,filename),st=lstatSync(path);
   if(!st.isFile()||st.size>MAX_FILE_BYTES)throw Error('invalid_recovery_file');
   const envelope=JSON.parse(readFileSync(path,'utf8'));
   const cmd=verifyMuseGitRecovery(envelope,{secret,actors,now});
   if(filename!==cmd.request_id+'.json')throw Error('recovery_filename_mismatch');
   accepted.push({file:filename,request:cmd});
  }catch(error){
   rejected.push({file:filename,reason:String(error.message||'invalid_recovery').slice(0,80)});
  }
 }
 return {accepted,rejected,complete:rejected.length===0};
}
function git(args,{cwd,env,run=spawnSync}={}){
 const r=run('git',args,{cwd,env,encoding:'utf8',timeout:90000,maxBuffer:1024*1024,
   stdio:['ignore','pipe','pipe']});
 if(r.error||r.status!==0)throw Error('Private Git recovery transport '+args[0]+' failed');
 return String(r.stdout||'').trim();
}
function gitRemote(repo){
 if(repo!==settings.ledger.repo)throw Error('Untrusted private Muse recovery repository');
 return 'https://github.com/'+repo+'.git';
}
export function fetchMuseGitRecoveries({token,secret,actors={},processed={},
  now=new Date().toISOString(),repo=settings.ledger.repo,
  remoteUrl=null,run=spawnSync}={}){
 if(!token||repo!==settings.ledger.repo)throw Error('Private Muse Git inbox access not configured');
 const root=mkdtempSync(join(tmpdir(),'aicafe-muse-inbox-'));
 try{
  git(['clone','-q','--depth','1','--branch','main',remoteUrl||gitRemote(repo),root],
    {env:gitAuthEnvironment(token),run});
  return scanMuseGitRecoveryDirectory(root,{secret,actors,processed,now});
 }finally{rmSync(root,{recursive:true,force:true});}
}
export function pushMuseGitRecovery({request,secret,token,repo=settings.ledger.repo,
  remoteUrl=null,maxRetries=3,run=spawnSync}={}){
 if(!token||repo!==settings.ledger.repo||
    !Number.isInteger(maxRetries)||maxRetries<1||maxRetries>5)
   throw Error('Private Muse Git writer is not configured');
 const envelope=signMuseGitRecovery(request,secret);
 const filename=envelope.request.request_id+'.json',relative=DIR+'/'+filename;
 const body=JSON.stringify(envelope,null,2)+'\n';
 const env=gitAuthEnvironment(token);
 for(let i=0;i<maxRetries;i++){
  const root=mkdtempSync(join(tmpdir(),'aicafe-muse-submit-'));
  try{
   git(['clone','-q','--depth','1','--branch','main',remoteUrl||gitRemote(repo),root],{env,run});
   const file=join(root,relative);
   if(existsSync(file)){
    if(readFileSync(file,'utf8')!==body)
      throw Error('Recovery ID collision with different signed payload');
    return {status:'already_queued',file:relative,request_id:envelope.request.request_id};
   }
   mkdirSync(dirname(file),{recursive:true,mode:0o700});
   writeFileSync(file,body,{flag:'wx',mode:0o600});
   git(['add','--',relative],{cwd:root,env,run});
   git(['-c','user.name=Muse Recovery Courier',
     '-c','user.email=muse@users.noreply.github.com',
     'commit','-q','-m','chore(muse): queue signed dispatcher recovery'],{cwd:root,env,run});
   try{
    git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
    return {status:'queued',file:relative,request_id:envelope.request.request_id};
   }catch(error){
    // No force-push. Reclone and check whether this same request was saved.
    if(i===maxRetries-1)throw error;
   }
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 throw Error('Muse recovery Git push not confirmed');
}
