import {settings} from './settings.mjs';
// Pure receipt verification. The trusted GitHub-side writer must authenticate courier
// receipts before calling this function; this module never accepts anonymous writes.
import { createHash } from 'node:crypto';
import { validConversationUrl } from './delivery.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

export function acceptDeliveryReceipt(state, receipt, { authenticatedCourier } = {}) {
  if (!['muse', 'dave'].includes(authenticatedCourier)) throw new Error('Trusted courier identity required');
  if (!receipt || typeof receipt.action_id !== 'string') throw new Error('Missing action ID');
  const next = structuredClone(state);
  const action = next.actions?.[receipt.action_id];
  const task = next.tasks?.[action?.task_id];
  // A draft PR can appear before Muse's original, authenticated browser
  // receipt is reconciled. Head reconciliation cancels the pending assignment
  // as stale, but the receipt is still valuable as a *chat destination*.
  // Recover ONLY that original same-task assignment, never a cancelled
  // continuation, revoked scope, or a second conversation.
  const supersededContinuation = action?.status === 'cancelled_stale_head' &&
    action?.type !== 'assign' && !action?.superseded_receipt &&
    action?.delivery?.intent === 'continue_existing_chat';
  // An early draft PR can supersede either the legacy initial assignment or
  // its hash-bound reissued form. Both are the SAME approved browser send;
  // never accept arbitrary action keys or an old approval signature.
  const originalAssignment = task && (
    receipt.action_id === 'assign:' + task.task_id ||
    receipt.action_id === 'assign:' + task.task_id + ':approval-' + task.approval_hash);
  const lateAssignment = action?.status === 'cancelled_stale_head' &&
    action?.type === 'assign' && originalAssignment &&
    action?.delivery?.action_id === receipt.action_id &&
    action?.delivery?.approval_hash === task?.approval_hash &&
    action?.task_id === task?.task_id &&
    task?.github_state === 'open' && Number.isInteger(task?.pr_number) &&
    task?.branch === settings.naming.branch_prefix + task.task_id &&
    !task?.conversation_ref;
  const planning=['scope_plan','scope_plan_update'].includes(action?.type)&&
    task?.planning_approved===true&&task?.approved!==true&&
    task?.status==='scope_planning'&&
    action.proposal_source_sha===task.proposal_source_sha;
  if (!action || !task ||
      (action.status !== 'planned' && !lateAssignment && !supersededContinuation) ||
      (!supersededContinuation && task.approved !== true && !planning))
    throw new Error('Action is not currently approved and planned');
  // Courier receipts may only be acknowledged by the action's assigned owner.
  if (action.delivery_owner !== authenticatedCourier)
    throw new Error('Receipt courier does not own approved action');
  const d = action.delivery;
  if (!d || d.action_id !== receipt.action_id || d.task_id !== action.task_id ||
      (!supersededContinuation && d.approval_hash !== task.approval_hash) ||
      hash(d.prompt) !== d.prompt_hash ||
      receipt.prompt_hash !== d.prompt_hash ||
      (receipt.approval_hash != null && receipt.approval_hash !== d.approval_hash) ||
      (lateAssignment && receipt.approval_hash !== d.approval_hash) ||
      !validConversationUrl(d.provider, receipt.conversation_url))
    throw new Error('Receipt does not match approved delivery');
  const continuation = d.intent === 'continue_existing_chat' &&
    receipt.conversation_url !== d.conversation_url;
  // Muse may recover a stale browser chat, but only when its authenticated
  // receipt binds the NEW URL to the EXACT old approved destination.
  if (continuation && !(authenticatedCourier === 'muse' &&
      receipt.continuation_of === d.conversation_url &&
      receipt.continuation_reason === 'stale_chat'))
    throw new Error('Follow-up destination changed');
  if (receipt.task_id!=null&&receipt.task_id!==task.task_id)throw Error('Receipt task mismatch');
  if (receipt.branch!=null&&receipt.branch!==task.branch)throw Error('Receipt branch mismatch');
  if (d.intent === 'start_new_chat' && task.conversation_ref)
    throw new Error('Task already has a conversation');
  // Existing courier records used {project:{id:'aicafe',name:'AI CAFE'}};
  // the initial validator only understood the flat project_id field. Either
  // shape identifies the *same approved destination*, never a second project.
  // Reject ambiguous/conflicting identities rather than silently choosing one.
  const flatPresent = Object.hasOwn(receipt, 'project_id');
  const nestedPresent = Object.hasOwn(receipt, 'project');
  if ((!flatPresent && !nestedPresent) ||
      (flatPresent && (typeof receipt.project_id !== 'string' ||
        receipt.project_id !== d.project.id)) ||
      (nestedPresent && (!receipt.project || typeof receipt.project !== 'object' ||
        Array.isArray(receipt.project) || receipt.project.id !== d.project.id)) ||
      receipt.provider !== d.provider)
    throw new Error('Receipt project/provider mismatch');
  if (d.effort && receipt.effort != null && receipt.effort !== d.effort)
    throw new Error('Receipt effort mismatches delivery');
  if (receipt.status && receipt.status !== 'submitted')
    throw new Error('Non-submission cannot be marked delivered');
  if (supersededContinuation) {
    // Audit only: this delivery cannot advance task state, eligibility, or
    // the post-submission inactivity clock on a newer PR head.
    action.superseded_receipt = { courier: authenticatedCourier,
      prompt_hash: d.prompt_hash, submitted_at: receipt.submitted_at || new Date().toISOString(),
      conversation_url: receipt.conversation_url };
    return next;
  }
  action.status = 'submitted';
  if (planning) {task.status='scope_plan_sent';task.scope_plan_completed=true;}
  if (lateAssignment) action.recovered_original_chat_after_pr = true;
  action.submitted_at = receipt.submitted_at || new Date().toISOString();
  action.receipt = { courier: authenticatedCourier, prompt_hash: d.prompt_hash,
    conversation_url: receipt.conversation_url,
    ...(d.effort ? {effort:d.effort} : {}),
    ...(continuation ? {continuation_of:d.conversation_url} : {}) };
  task.conversation_ref = receipt.conversation_url;
  task.conversation_url = receipt.conversation_url;
  if(task.branch){
    next.branch_chat_links||={};
    next.branch_chat_links[task.branch]={task_id:task.task_id,branch:task.branch,
      conversation_url:receipt.conversation_url,updated_at:action.submitted_at};
  }
  if (d.effort) task.effort = d.effort;
  if (Number.isInteger(task.pr_number)) {
    next.pr_chat_links ||= {};
    next.pr_chat_links[String(task.pr_number)] = {
      task_id:task.task_id,conversation_url:receipt.conversation_url,
      head_sha:task.head_sha || null,updated_at:action.submitted_at
    };
  }
  if (action.type === 'dependency_proven' && action.dependency_signature)
    task.last_dependency_proven_signature = action.dependency_signature;
  task.last_submission_at = action.submitted_at;
  // Verified prompt receipt anchors the PR head; do not infer push progress from commit author timestamps.
  task.last_prompt_head_sha = task.head_sha || action.head_sha || null;
  task.submission_state = 'submitted';
  return next;
}
