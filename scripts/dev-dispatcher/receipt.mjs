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
  const lateAssignment = action?.status === 'cancelled_stale_head' &&
    action?.type === 'assign' && action?.key !== 'other' &&
    action?.task_id === task?.task_id &&
    task?.github_state === 'open' && Number.isInteger(task?.pr_number) &&
    task?.branch === 'feat/aicafe-task-' + task.task_id &&
    !task?.conversation_ref;
  if (!action || !task || (action.status !== 'planned' && !lateAssignment) ||
      task.approved !== true)
    throw new Error('Action is not currently approved and planned');
  // Courier receipts may only be acknowledged by the action's assigned owner.
  if (action.delivery_owner !== authenticatedCourier)
    throw new Error('Receipt courier does not own approved action');
  const d = action.delivery;
  if (!d || d.action_id !== receipt.action_id || d.task_id !== action.task_id ||
      d.approval_hash !== task.approval_hash || hash(d.prompt) !== d.prompt_hash ||
      receipt.prompt_hash !== d.prompt_hash || !validConversationUrl(d.provider, receipt.conversation_url))
    throw new Error('Receipt does not match approved delivery');
  if (d.intent === 'continue_existing_chat' && receipt.conversation_url !== d.conversation_url)
    throw new Error('Follow-up destination changed');
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
  if (receipt.status && receipt.status !== 'submitted')
    throw new Error('Non-submission cannot be marked delivered');
  action.status = 'submitted';
  if (lateAssignment) action.recovered_original_chat_after_pr = true;
  action.submitted_at = receipt.submitted_at || new Date().toISOString();
  action.receipt = { courier: authenticatedCourier, prompt_hash: d.prompt_hash,
    conversation_url: receipt.conversation_url };
  task.conversation_ref = receipt.conversation_url;
  task.last_submission_at = action.submitted_at;
  task.submission_state = 'submitted';
  return next;
}
