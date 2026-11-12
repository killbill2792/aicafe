// Trusted-main, read-only encrypted projection of the ONE private dispatcher ledger.
// Never publish state.json or its private action/receipt fields. The browser
// receives only AEAD ciphertext and a documented, non-secret KDF envelope.
import {pbkdf2Sync,randomBytes,createCipheriv} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLedgerViaGit} from './git-operations.mjs';
import {settings} from './settings.mjs';

const ITERATIONS=600_000;
const safeText=(v,max=160)=>typeof v==='string'?v.slice(0,max):null;
const validPrUrl=(v,n)=>Number.isInteger(n)&&n>0&&
  v==='https://github.com/'+settings.repo+'/pull/'+n?v:null;
const safeStatuses=value=>value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value)
    .filter(([k,v])=>/^[a-z_]{1,40}$/.test(k)&&typeof v==='string')
    .map(([k,v])=>[k,v.slice(0,64)])):{};

export function projectEncryptedOwnerView(state,{now=new Date().toISOString()}={}){
 if(state?.version!==1||!state.tasks||!state.actions||!state.lifecycle_v3?.rows)
   throw Error('Private dispatcher lifecycle snapshot unavailable');
 if(!Number.isFinite(Date.parse(now)))throw Error('Invalid projection clock');
 const tasks=Object.entries(state.lifecycle_v3.rows).map(([id,r])=>{
   const n=r?.pr?.number;
   return {id:safeText(id,64),product:safeText(r.product_id,64),
     title:safeText(r.title,240),stage:safeText(r.current_stage,60),
     milestones:safeStatuses(r.milestones),
     pr:{number:Number.isInteger(n)?n:null,state:safeText(r.pr?.state,48),
       url:validPrUrl(r.pr?.url,n),head_sha:safeText(r.pr?.head_sha,40),
       last_updated_at:safeText(r.pr?.last_updated_at,42)},
     last_commit_sha:safeText(r.coding?.last_commit_sha,40),
     last_commit_at:safeText(r.coding?.last_commit_at,42),
     ci:safeText(r.ci?.status,48),
     codex:safeText(r.codex?.status,48),
     codex_requested:safeText(r.codex?.request_status,48),
     acceptance:safeText(r.acceptance?.status,48),
     dependencies:Array.isArray(r.remaining_dependencies)
       ?r.remaining_dependencies.slice(0,60).map(x=>safeText(x,64)):[],
     merge_eligible:r.merge?.eligible===true,
     integration:safeText(r.integration?.status,48),
     next_actor:safeText(r.monitor?.next_actor,48),
     next_action:safeText(r.monitor?.next_action,120),
     next_reason:safeText(r.monitor?.next_reason,160)};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return {version:1,generated_at:now,
   ledger_updated_at:safeText(state.updated_at,42),
   last_schedule_at:safeText(state.schedule_health?.last_schedule_at,42),
   owner_notices_pending:Object.values(state.owner_alerts||{}).filter(n=>
     ['planned','claimed','uncertain'].includes(n.status)).length,
   tasks};
}

export function encryptOwnerView(projected,passphrase,{random=randomBytes}={}){
 if(typeof passphrase!=='string'||passphrase.length<24||passphrase.length>1024)
   throw Error('OWNER_PAGES_PASSPHRASE requires a long secret (24+ characters)');
 const salt=random(16),iv=random(12);
 if(!Buffer.isBuffer(salt)||salt.length!==16||!Buffer.isBuffer(iv)||iv.length!==12)
   throw Error('No cryptographically secure random source');
 const key=pbkdf2Sync(passphrase,salt,ITERATIONS,32,'sha256');
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const plaintext=Buffer.from(JSON.stringify(projected),'utf8');
 const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),
   cipher.getAuthTag()]);
 key.fill(0);plaintext.fill(0);
 return {version:1,
   kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:salt.toString('base64')},
   cipher:{name:'AES-256-GCM',iv:iv.toString('base64')},
   ciphertext:ciphertext.toString('base64')};
}

export function publishEncryptedOwnerView({token,passphrase,outputPath,now}={}){
 if(!token||!outputPath)throw Error('Private ledger credential and output required');
 const state=readLedgerViaGit({repo:settings.ledger.repo,token});
 const projected=projectEncryptedOwnerView(state,{now});
 const encrypted=encryptOwnerView(projected,passphrase);
 mkdirSync(dirname(outputPath),{recursive:true,mode:0o700});
 writeFileSync(outputPath,JSON.stringify(encrypted)+'\n',{mode:0o600,flag:'wx'});
 return {status:'encrypted',tasks:projected.tasks.length,generated_at:projected.generated_at};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
   const r=publishEncryptedOwnerView({token:process.env.DISPATCH_LEDGER_TOKEN,
     passphrase:process.env.OWNER_PAGES_PASSPHRASE,
     outputPath:process.argv[2]});
   console.log('Encrypted owner snapshot generated; plaintext and private metadata suppressed');
 }catch(error){
   // Never print the environment, private state, passphrase or ciphertext.
   console.error('Encrypted owner snapshot unavailable: '+String(error.message).slice(0,110));
   process.exitCode=1;
 }
}
