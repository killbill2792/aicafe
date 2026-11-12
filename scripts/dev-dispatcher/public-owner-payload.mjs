// PUBLIC operational projection from the ONE private dispatcher ledger.
// This intentionally replaces the encrypted Pages projection at owner's request.
// Never copy private prompts, credentials, conversations, receipts, owner questions,
// signed hashes or unvalidated free-form evidence into public Pages.
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLedgerViaGit} from './git-operations.mjs';
import {settings} from './settings.mjs';

const date=v=>typeof v==='string'&&v.length<45&&Number.isFinite(Date.parse(v))
  ?new Date(v).toISOString():null;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v)?v:null;
const status=v=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,80}$/.test(v)?v:null;
const title=v=>typeof v==='string'&&v.length<=240&&!/[\x00-\x1f\x7f]/.test(v)?v:null;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)?v:null;
const prUrl=n=>Number.isSafeInteger(n)&&n>0
  ?'https://github.com/'+settings.repo+'/pull/'+n:null;
const blockers=values=>Array.isArray(values)
  ?values.map(status).filter(Boolean).slice(0,35):[];
const countPending=val=>['planned','claimed','uncertain','needs_login'].includes(val);

export function projectPublicOwnerView(state,{now=new Date().toISOString()}={}){
 if(state?.version!==1||!state.tasks||!state.actions||!state.lifecycle_v3?.rows)
   throw Error('Authoritative lifecycle snapshot unavailable');
 const generatedAt=date(now);
 if(!generatedAt)throw Error('Invalid snapshot time');
 const notices=Object.values(state.owner_alerts||{});
 const actions=Object.values(state.actions||{});
 const tasks=Object.entries(state.lifecycle_v3.rows).map(([taskId,r])=>{
   if(!id(taskId)||!r||typeof r!=='object')return null;
   const n=r.pr?.number;
   const prNumber=Number.isSafeInteger(n)&&n>0?n:null;
   const pendingActions=actions.filter(a=>a.task_id===taskId&&
     a.delivery_owner==='muse'&&countPending(a.status));
   const pendingNotices=notices.filter(a=>a.task_id===taskId&&
     a.delivery_owner==='muse'&&countPending(a.status));
   const actionTypes=[...new Set(pendingActions.map(a=>status(a.type)).filter(Boolean))].slice(0,8);
   const noticeKinds=[...new Set(pendingNotices.map(a=>status(a.kind)).filter(Boolean))].slice(0,12);
   const outcome=r.integration?.status==='PROVEN'?'Integrated and proven':
     r.current_stage==='TASK_COMPLETE'?'Task complete — proof unverified':
     status(r.current_stage)||'UNKNOWN';
   return {
     id:taskId,product:id(r.product_id),title:title(r.title),
     stage:status(r.current_stage)||'UNKNOWN',outcome,
     approval:status(r.approval?.status),plan_state:status(r.approval?.plan_state),
     pr:{number:prNumber,url:prUrl(prNumber),state:status(r.pr?.state)||'MISSING',
       head_sha:sha(r.pr?.head_sha),branch:typeof r.coding?.branch==='string'
         &&/^[A-Za-z0-9._/\-]{1,180}$/.test(r.coding.branch)?r.coding.branch:null,
       last_updated_at:date(r.pr?.last_updated_at)},
     coding:{last_commit_at:date(r.coding?.last_commit_at),
       last_commit_sha:sha(r.coding?.last_commit_sha)},
     ci:{status:status(r.ci?.status)||'UNKNOWN',
       started_at:date(r.ci?.started_at),finished_at:date(r.ci?.finished_at),
       last_checked_at:date(r.ci?.last_checked_at),
       failed_check:title(r.ci?.failed_check),
       failure_kind:status(r.ci?.failure_kind)},
     codex:{status:status(r.codex?.status)||'UNKNOWN',
       request_status:status(r.codex?.request_status)||'UNKNOWN',
       requested_at:date(r.codex?.requested_at),
       started_at:date(r.codex?.started_at),
       reviewed_at:date(r.codex?.review_at),
       reviewed_sha:sha(r.codex?.reviewed_sha),
       open_threads:Number.isSafeInteger(r.codex?.open_threads)
         ?Math.max(0,r.codex.open_threads):null},
     acceptance:status(r.acceptance?.status)||'UNKNOWN',
     dependencies:blocksToIds(r.remaining_dependencies),
     muse:{delivered:status(r.dispatch?.delivered)||'UNKNOWN',
       last_receipt_at:date(r.dispatch?.latest_delivery_receipt_at),
       pending_actions:pendingActions.length,
       action_types:actionTypes,
       pending_owner_notices:pendingNotices.length,
       notice_kinds:noticeKinds},
     merge:{eligible:r.merge?.eligible===true,
       blockers:blockers(r.merge?.blockers),
       merged_at:date(r.merge?.merge_at),
       merge_sha:sha(r.merge?.merge_sha)},
     integration:{status:status(r.integration?.status)||'UNKNOWN',
       verified_at:date(r.integration?.proof_verified_at),
       proof_run_id:Number.isSafeInteger(r.integration?.proof_run_id)
         ?r.integration.proof_run_id:null},
     next:{actor:status(r.monitor?.next_actor)||'UNKNOWN',
       action:status(r.monitor?.next_action)||'UNKNOWN',
       reason:status(r.monitor?.next_reason)},
   };
 }).filter(Boolean).sort((a,b)=>a.id.localeCompare(b.id));
 return {version:2,generated_at:generatedAt,
   ledger_updated_at:date(state.updated_at),
   last_schedule_at:date(state.schedule_health?.last_schedule_at),
   owner_notices_pending:notices.filter(n=>countPending(n.status)).length,
   pending_muse_actions:actions.filter(a=>a.delivery_owner==='muse'&&countPending(a.status)).length,
   tasks};
}
function blocksToIds(input){
 return Array.isArray(input)?input.map(id).filter(Boolean).slice(0,60):[];
}
export function publishPublicOwnerView({token,outputPath,now}={}){
 if(!token||!outputPath)throw Error('Private ledger credential and output required');
 const state=readLedgerViaGit({repo:settings.ledger.repo,token});
 const view=projectPublicOwnerView(state,{now});
 mkdirSync(dirname(outputPath),{recursive:true,mode:0o700});
 writeFileSync(outputPath,JSON.stringify(view)+'\n',{mode:0o600,flag:'wx'});
 return {status:'published',rows:view.tasks.length};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
   publishPublicOwnerView({token:process.env.DISPATCH_LEDGER_TOKEN,
     outputPath:process.argv[2]});
   console.log('Public allowlisted owner operations snapshot staged');
 }catch(error){
   console.error('Owner operations snapshot unavailable: '+String(error.message).slice(0,100));
   process.exitCode=1;
 }
}
