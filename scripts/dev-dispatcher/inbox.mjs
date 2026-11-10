// Courier receipts are deposited as private GitHub files, never as public signals.
// GitHub verifies authenticated GitHub commit actor, exact action/hash/URL and CAS state.
import { createHash } from 'node:crypto';
import { acceptDeliveryReceipt } from './receipt.mjs';
import { validConversationUrl } from './delivery.mjs';
import { acceptOwnerNoticeReceipt } from './alerts.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');

// The GitHub commit actor is the authentication boundary. A self-declared
// receipt author, Git commit display name or valid hash is NOT an identity.
export async function inspectReceipts({ ledger, allowedActors }) {
  const accepted=[], rejected=[];
  if(!allowedActors?.length)return {accepted,rejected,complete:false,scan_error:'courier_actor_configuration_missing'};
  let list;
  try {
    list=await ledger.request('/contents/dispatcher/receipts?ref=main');
  }catch {
    return {accepted,rejected,complete:false,scan_error:'receipt_directory_unavailable'};
  }
  if(list.absent)return {accepted,rejected,complete:true};
  if(!Array.isArray(list)||list.length>=1000)
    return {accepted,rejected,complete:false,scan_error:'receipt_directory_not_bounded'};
  let complete=true;
  for(const entry of list) {
    if(entry.type!=='file'||!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;
    try {
      const meta=await ledger.request('/commits?path='+encodeURIComponent(entry.path)+'&per_page=1');
      const actor=meta?.[0]?.author?.login;
      if(!actor||!allowedActors.includes(actor)){
        rejected.push({file:entry.name,code:actor?'unapproved_git_actor':'unattributed_git_actor'});
        continue;
      }
      const blob=await ledger.request('/contents/'+entry.path+'?ref=main');
      if(typeof blob.content!=='string'||blob.content.length>40000){
        rejected.push({file:entry.name,code:'invalid_receipt_identity'});continue;
      }
      let receipt;
      try {
        receipt=JSON.parse(Buffer.from(blob.content.replace(/\s/g,''),'base64').toString('utf8'));
      }catch{
        rejected.push({file:entry.name,code:'invalid_receipt_identity'});continue;
      }
      const identity=receipt?.kind==='owner_notice'
        ? 'owner:'+receipt.notice_id+':'+receipt.notice_hash
        : receipt?.action_id+':'+receipt?.prompt_hash;
      if(sha(identity)+'.json'!==entry.name){
        rejected.push({file:entry.name,code:'invalid_receipt_identity'});continue;
      }
      accepted.push({receipt,actor,file:entry.name});
    }catch{
      complete=false;
      rejected.push({file:entry.name,code:'github_receipt_read_failed'});
    }
  }
  return {accepted,rejected,complete};
}

// Preserve the original public API for existing consumers.
export async function collectReceipts(options){
  return (await inspectReceipts(options)).accepted;
}

// A bad receipt must never block unrelated valid receipts or a trusted tick.
export function applyReceiptsSafely(state, inbox, actorMap) {
  let next=state;
  const rejected=[];
  for(const item of inbox){
    try{next=applyReceipts(next,[item],actorMap);}
    catch{if(item.file)rejected.push({file:item.file,code:'receipt_validation_failed'});}
  }
  return {state:next,rejected};
}

export function applyReceipts(state, inbox, actorMap) {
  let next = state;
  for (const {receipt, actor} of inbox) {
    const courier = actorMap[actor];
    if (!courier) continue;
    // Historical receipts stay in the inbox; never replay or revive cancelled actions.
    if (receipt.kind === 'owner_notice') {
      if (next.owner_alerts?.[receipt.notice_id]?.status !== 'planned') continue;
      next = acceptOwnerNoticeReceipt(next, receipt, { authenticatedCourier: courier });
      continue;
    }
    const action = next.actions?.[receipt.action_id];
    // After the PR appears, initial assignment receipts can arrive late.
    // Invalid legacy placeholder destinations (for example local-chatgpt URLs)
    // must not poison the entire inbox and prevent unrelated valid chat recovery.
    // Never mark those invalid receipts as delivered or trusted.
    const late = action?.status === 'cancelled_stale_head' && action.type === 'assign';
    // A stale continuation may have reached the browser before a newer PR head.
    // Record its verified historical receipt without reviving its authorization.
    const superseded = action?.status === 'cancelled_stale_head' &&
      action.type !== 'assign' && action.delivery?.intent === 'continue_existing_chat' &&
      !action.superseded_receipt;
    if (action?.status !== 'planned' && !late && !superseded) continue;
    if (late) {
      const task = next.tasks?.[action.task_id];
      // No historical receipt may stop unrelated tasks after its own PR closed,
      // approval changed, chat was already registered, or ownership diverged.
      if (!task || !task.approved || task.github_state !== 'open' ||
          !Number.isInteger(task.pr_number) || task.conversation_ref ||
          receipt.action_id !== 'assign:' + task.task_id ||
          action.task_id !== task.task_id ||
          task.branch !== 'feat/aicafe-task-' + task.task_id)
        continue;
      if (receipt.approval_hash !== task.approval_hash ||
          receipt.approval_hash !== action.delivery?.approval_hash ||
          !validConversationUrl(action.delivery?.provider, receipt.conversation_url)) {
        task.chat_recovery_blocker = 'invalid_or_unsigned_original_receipt';
        continue;
      }
    }
    next = acceptDeliveryReceipt(next, receipt, { authenticatedCourier: courier });
  }
  return next;
}
