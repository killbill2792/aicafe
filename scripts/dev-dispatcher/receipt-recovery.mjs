// Private, read-only courier handoff health. This DOES NOT authorize a send.
// File identity comes from the already approved private action, never
// from unauthenticated receipt contents or a claimed Git commit display name.
import {createHash} from 'node:crypto';
const SHA64=/^[a-f0-9]{64}$/;
const allowed=new Set(['unattributed_git_actor','unapproved_git_actor',
 'invalid_receipt_identity','receipt_validation_failed','github_receipt_read_failed',
 'assignment_receipt_missing']);
export const receiptFileForAction=(id,action)=>{
  const h=action?.delivery?.prompt_hash;
  return typeof id==='string'&&SHA64.test(h||'')
    ? createHash('sha256').update(id+':'+h).digest('hex')+'.json' : null;
};
const live=(action,task)=>action&&task?.approved===true&&
  task.github_state==='open'&&Number.isInteger(task.pr_number)&&
  action.status!=='submitted'&&!action.receipt &&
  action.delivery_owner==='muse';

export function reconcileReceiptFeedback(state, scan, now=new Date().toISOString()) {
  if(!state?.tasks||!state.actions)throw Error('Invalid courier ledger');
  const next=structuredClone(state);
  next.receipt_feedback ||= {};
  next.receipt_scan={complete:scan?.complete===true,checked_at:now,
    error:scan?.complete===true?null:(scan?.scan_error||'receipt_scan_incomplete')};
  const identities=new Map();
  for(const [id,action] of Object.entries(next.actions)){
    const name=receiptFileForAction(id,action);
    if(name)identities.set(name,id);
  }
  const problems=new Map();
  for(const rejected of scan?.rejected||[]){
    if(!allowed.has(rejected.code))continue;
    const id=identities.get(rejected.file);
    if(!id)continue;
    const action=next.actions[id],task=next.tasks[action.task_id];
    if(live(action,task))problems.set(id,rejected.code);
  }
  // A PR may appear before the initial receipt. If its original assignment
  // was cancelled as stale while the chat URL remains unknown, surface it.
  // Do not send a new assign and never assume that the browser did nothing.
  for(const [id,action] of Object.entries(next.actions)){
    if(action.type!=='assign'||action.status!=='cancelled_stale_head')continue;
    const task=next.tasks[action.task_id];
    if(live(action,task)&&!task.conversation_ref&&!problems.has(id)&&
       (scan?.complete===true || next.receipt_feedback[id]?.status!=='rejected'))
      problems.set(id,'assignment_receipt_missing');
  }
  for(const [id,code] of problems){
    const prior=next.receipt_feedback[id];
    next.receipt_feedback[id]={
      task_id:next.actions[id].task_id,status:'rejected',code,
      first_seen_at:prior?.status==='rejected'?prior.first_seen_at:now,
      last_checked_at:now,
      last_wake_at:prior?.status==='rejected'?prior.last_wake_at:now,
      wake_round:prior?.status==='rejected'?prior.wake_round||0:0
    };
  }
  for(const [id,feedback] of Object.entries(next.receipt_feedback)){
    if(problems.has(id)||feedback.status!=='rejected')continue;
    const action=next.actions[id],task=next.tasks[action?.task_id];
    if(action?.status==='submitted'||!live(action,task)){
      feedback.status='resolved';feedback.resolved_at=now;
    }else if(scan?.complete===true){
      // The bad file vanished or was rewritten but no verified receipt was
      // accepted. Preserve a visible hold; don't mark repair successful.
      feedback.code='assignment_receipt_missing';
      feedback.last_checked_at=now;
    }
  }
  return next;
}

// Reuse the EXISTING private-ledger + opaque signal cadence: no new action,
// browser attempt, service or public task-identifying signal.
export function wakeReceiptFeedback(state,nowMs,intervalMs=900000){
  for(const f of Object.values(state.receipt_feedback||{})){
    if(f.status!=='rejected')continue;
    const last=Date.parse(f.last_wake_at||f.first_seen_at||'');
    const delay=(f.wake_round||0)<4?intervalMs:3600000;
    if(!Number.isFinite(last)||nowMs-last<delay)continue;
    f.last_wake_at=new Date(nowMs).toISOString();
    f.wake_round=Math.min((f.wake_round||0)+1,1000);
  }
  return state;
}
