// HMAC-free Muse recovery bridge. GitHub's existing PRIVATE receipt scanner
// authenticates the Git commit actor before accepting this command. This
// reuses the owner-instruction channel that is already live, without exporting
// the vault signing key or creating an HTTP signing service.
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {receiptFilename} from './receipt-identity.mjs';
import {RECOVERY_INTENTS,recoveryIdentity} from './recovery-v3.mjs';
import {gitAuthEnvironment} from './git-operations.mjs';
import {settings} from './settings.mjs';
const HEX40=/^[a-f0-9]{40}$/;
const HEX64=/^[a-f0-9]{64}$/;
const TASK=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const supported=new Set(RECOVERY_INTENTS);
const REQUEST_DIR=settings.ledger.receipts_path;
function git(args,{cwd,env,run=spawnSync}={}){
 const result=run('git',args,{cwd,env,encoding:'utf8',timeout:90000,
   maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 if(result.error||result.status!==0)
   throw Error('Muse private Git receipt '+args[0]+' failed');
 return String(result.stdout||'').trim();
}
export function museRecoveryReceipt(request,{repo=settings.repo,actor}={}){
 const r=request||{};
 if(repo!==settings.repo||typeof actor!=='string'||!TASK.test(actor))
   throw Error('Unconfigured Muse recovery identity');
 const intent=r.intent,task_id=r.task_id??null,
   pr_number=r.pr_number??null,expected_head_sha=r.expected_head_sha??null;
 const global=intent==='RECONCILE'&&task_id===null&&pr_number===null&&
   expected_head_sha===null;
 if(r.version!==1||!supported.has(intent)||
   (!global&&(!TASK.test(task_id||'')||!Number.isSafeInteger(pr_number)||
     pr_number<1||!HEX40.test(expected_head_sha||''))))
   throw Error('Invalid scoped Muse recovery request');
 const requested_at=r.requested_at||new Date().toISOString();
 if(!Number.isFinite(Date.parse(requested_at)))
   throw Error('Invalid recovery submission timestamp');
 const identity={repo,actor,intent,task_id,pr_number,expected_head_sha,requested_at};
 const request_id=recoveryIdentity(identity);
 if(r.request_id!=null&&r.request_id!==request_id)
   throw Error('Recovery request identity mismatch');
 return {kind:'muse_recovery',version:1,project_id:settings.naming.task_prefix,
   ...identity,request_id,event_id:request_id,submitted_at:requested_at};
}
export function validateMuseRecoveryReceipt(receipt,{
 actor,actors={},now=new Date().toISOString()}={}){
 if(!receipt||receipt.kind!=='muse_recovery'||receipt.version!==1||
    receipt.project_id!==settings.naming.task_prefix||receipt.repo!==settings.repo||
    !actor||actors[actor]!=='muse'||
    (receipt.actor!=null&&receipt.actor!==actor)||
    typeof receipt.event_id!=='string'||
    !/^[A-Za-z0-9_-]{1,100}$/.test(receipt.event_id)||
    typeof receipt.submitted_at!=='string'||
    (receipt.request_id!=null&&receipt.event_id!==receipt.request_id)||
    (receipt.requested_at!=null&&receipt.submitted_at!==receipt.requested_at))
   throw Error('Unverified Muse recovery receipt');
 // Muse can use the SAME authenticated Git writer as owner_instruction.
 // It supplies a stable event ID, not a signing key or a SHA-256 digest.
 // GitHub derives the canonical identity from the VERIFIABLE commit actor.
 const timestamp=receipt.requested_at||receipt.submitted_at;
 const expected=museRecoveryReceipt({...receipt,requested_at:timestamp},
   {repo:settings.repo,actor});
 const normalized={...expected,event_id:receipt.event_id};
 if((receipt.request_id!=null&&expected.request_id!==receipt.request_id)||
    receiptFilename(normalized)!==receiptFilename(receipt))
   throw Error('Muse recovery receipt identity mismatch');
 const stamp=Date.parse(receipt.submitted_at),clock=Date.parse(now);
 if(!Number.isFinite(stamp)||!Number.isFinite(clock)||
    stamp>clock+120000||clock-stamp>7*86400000)
   throw Error('Expired or future Muse recovery receipt');
 return normalized;
}
export function pushMuseRecoveryReceipt({request,token,actor,
  repo=settings.ledger.repo,remoteUrl=null,run=spawnSync,
  maxRetries=3,authorEmail=process.env.MUSE_GIT_AUTHOR_EMAIL}={}){
 if(!token||repo!==settings.ledger.repo||!TASK.test(actor||'')||
    !Number.isInteger(maxRetries)||maxRetries<1||maxRetries>5)
   throw Error('Muse private Git recovery receipt not configured');
 const receipt=museRecoveryReceipt(request,{actor});
 const name=receiptFilename(receipt),relative=REQUEST_DIR+'/'+name;
 const body=JSON.stringify(receipt,null,2)+'\n';
 const env=gitAuthEnvironment(token);
 for(let attempt=0;attempt<maxRetries;attempt++){
   const root=mkdtempSync(join(tmpdir(),'aicafe-muse-receipt-'));
   try{
     git(['clone','-q','--depth','1','--branch','main',
       remoteUrl||'https://github.com/'+repo+'.git',root],{env,run});
     const statePath=join(root,settings.ledger.path);
     // The canonical ledger is read using ordinary Git; no REST requests.
     const state=JSON.parse(readFileSync(statePath,'utf8'));
     if(state.recovery_requests?.[receipt.request_id]||
        state.recovery_rejections?.[receipt.request_id])
       return {status:'already_acknowledged',request_id:receipt.request_id,file:relative};
     const file=join(root,relative);
     if(existsSync(file)){
       if(readFileSync(file,'utf8')!==body)
         throw Error('Recovery receipt collision with different content');
       return {status:'already_queued',request_id:receipt.request_id,file:relative};
     }
     mkdirSync(dirname(file),{recursive:true,mode:0o700});
     writeFileSync(file,body,{flag:'wx',mode:0o600});
     git(['add','--',relative],{cwd:root,env,run});
     // GitHub's verified commit actor must resolve to the allowlisted Muse
     // account. Prefer the author's already-configured host Git identity.
     const args=['-c','user.name='+actor];
     if(authorEmail){
       if(!/^[^\s@]+@[^\s@]+$/.test(authorEmail))
         throw Error('Invalid Muse Git author email');
       args.push('-c','user.email='+authorEmail);
     }else{
       const existing=git(['config','user.email'],{cwd:root,env,run});
       if(!existing)throw Error('Muse Git author email not configured');
     }
     git([...args,'commit','-qm','chore(muse): queue authenticated recovery receipt'],
       {cwd:root,env,run});
     try{
       git(['push','origin','HEAD:refs/heads/main'],{cwd:root,env,run});
       return {status:'queued',request_id:receipt.request_id,file:relative};
     }catch(error){
       // A lost POST response is uncertain: re-clone and verify the file.
       // Never force push or duplicate the original browser instruction.
       if(attempt===maxRetries-1)throw error;
     }
   }finally{rmSync(root,{recursive:true,force:true});}
 }
 throw Error('Muse private recovery receipt was not confirmed');
}
