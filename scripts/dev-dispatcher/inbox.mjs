import {settings} from './settings.mjs';
// Courier receipts are deposited as private GitHub files, never as public signals.
// GitHub verifies authenticated GitHub commit actor, exact action/hash/URL and CAS state.
import {receiptFilename} from './receipt-identity.mjs';
import { acceptDeliveryReceipt } from './receipt.mjs';
import { validConversationUrl } from './delivery.mjs';
import { acceptOwnerNoticeReceipt } from './alerts.mjs';
import { acceptMuseOwnerReply } from './self-heal.mjs';
import { applyMuseOwnerInstruction } from './owner-instruction-commands.mjs';


// The GitHub commit actor is the authentication boundary. A self-declared
// receipt author, Git commit display name or valid hash is NOT an identity.
export async function inspectReceipts({ ledger, allowedActors, processed = {} }) {
  const accepted=[], rejected=[];
  if(!allowedActors?.length)return {accepted,rejected,complete:false,scan_error:'courier_actor_configuration_missing'};
  let list;
  try {
    list=await ledger.request('/contents/'+settings.ledger.receipts_path+'?ref=main');
  }catch {
    return {accepted,rejected,complete:false,scan_error:'receipt_directory_unavailable'};
  }
  if(list.absent)return {accepted,rejected,complete:true};
  if(!Array.isArray(list)||list.length>=1000)
    return {accepted,rejected,complete:false,scan_error:'receipt_directory_not_bounded'};
  let complete=true;
  for(const entry of list) {
    if(entry.type!=='file'||!/^[a-f0-9]{64}\.json$/.test(entry.name))continue;
    // The directory listing supplies Git's exact blob identity. Skip only
    // previously validated AND reconciled receipts at that unchanged blob.
    if(/^[a-f0-9]{40}$/.test(entry.sha||'') && processed[entry.name]===entry.sha)continue;
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
      let expected;
      try{expected=receiptFilename(receipt);}
      catch{rejected.push({file:entry.name,code:'invalid_receipt_identity'});continue;}
      if(expected!==entry.name){
        rejected.push({file:entry.name,code:'invalid_receipt_identity'});continue;
      }
      accepted.push({receipt,actor,file:entry.name,sha:entry.sha||null});
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

// Receipt filenames are hashes, not chronological delivery order. Owner
// controls are applied in the owner's submission order, not GitHub directory
// order; the per-field watermark independently rejects late older receipts.
export function chronologicalOwnerReceipts(inbox){
 const commands=inbox.filter(item=>item.receipt?.kind==='owner_instruction')
   .sort((a,b)=>{
     const ta=Date.parse(a.receipt?.submitted_at||'');
     const tb=Date.parse(b.receipt?.submitted_at||'');
     const timeA=Number.isFinite(ta)?ta:-Infinity;
     const timeB=Number.isFinite(tb)?tb:-Infinity;
     return timeA-timeB||
       String(a.receipt?.event_id||'').localeCompare(String(b.receipt?.event_id||''));
   });
 return [...commands,...inbox.filter(item=>item.receipt?.kind!=='owner_instruction')];
}

// A bad receipt must never block unrelated valid receipts or a trusted tick.
export function applyReceiptsSafely(state, inbox, actorMap) {
  let next=state;
  const rejected=[];
  for(const item of chronologicalOwnerReceipts(inbox)){
    try{next=applyReceipts(next,[item],actorMap);}
    catch{if(item.file)rejected.push({file:item.file,code:'receipt_validation_failed'});}
  }
  return {state:next,rejected};
}

export function applyReceipts(state, inbox, actorMap) {
  let next = state;
  for (const {receipt, actor} of chronologicalOwnerReceipts(inbox)) {
    const courier = actorMap[actor];
    if (!courier) continue;
    // Historical receipts stay in the inbox; never replay or revive cancelled actions.
    if(receipt.kind==='owner_instruction'){
      // Only a GitHub-verified commit actor explicitly mapped to Muse may
      // exercise the owner's delegated bounded command channel. The words
      // 'owner said' and a JSON author field alone never authenticate anyone.
      if(courier!=='muse'||!receipt.target||typeof receipt.text!=='string'||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.event_id||''))
        throw Error('Unverified owner instruction');
      if(next.owner_instruction_events?.[receipt.event_id])continue;
      next=applyMuseOwnerInstruction(next,receipt,{actor,now:new Date().toISOString()});
      // Preserve the existing independent verified chat registration use case.
      const url=receipt.chat_url||receipt.text.trim();
      if(validConversationUrl('chatgpt',url)&&typeof receipt.target.branch==='string'&&
         /^[a-zA-Z0-9_./-]{1,160}$/.test(receipt.target.branch)){
        next.branch_chat_links||={};
        next.branch_chat_links[receipt.target.branch]={branch:receipt.target.branch,
          conversation_url:url,updated_at:receipt.submitted_at||new Date().toISOString(),
          source:'verified_muse'};
        const event=next.owner_instruction_events[receipt.event_id];
        event.chat_registered=true;
        if(event.reason==='unsupported_owner_command'){
          event.status='RECORDED';event.reason='verified_chat_url_registered';
        }
      }
      continue;
    }
    if (receipt.kind === 'owner_reply') {
      if(validConversationUrl('chatgpt',receipt.text?.trim())&&
        (courier==='muse'||actor===settings.owner.login)&&receipt.target?.branch){
        next=structuredClone(next);next.branch_chat_links||={};
        next.branch_chat_links[receipt.target.branch]={branch:receipt.target.branch,
          conversation_url:receipt.text.trim(),updated_at:receipt.submitted_at||new Date().toISOString(),source:'owner_or_muse'};
      }else{
        next = acceptMuseOwnerReply(next,receipt,{authenticatedCourier:courier});
      }
      continue;
    }
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
          (receipt.action_id !== 'assign:' + task.task_id &&
           receipt.action_id !== 'assign:' + task.task_id + ':approval-' + task.approval_hash) ||
          action.delivery?.action_id !== receipt.action_id ||
          action.task_id !== task.task_id ||
          task.branch !== settings.naming.branch_prefix + task.task_id)
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
