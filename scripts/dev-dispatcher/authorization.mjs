import { approvalSignature } from './delivery.mjs';

// One authoritative check before the private document is written.
// Records in a private queue are NOT evergreen owner approvals.
export function revalidateQueuedActions(state, taskById, queue = null) {
  const gate = queue?.dispatch_rules?.priority_gate_task;
  const allow = new Set(queue?.dispatch_rules?.priority_gate_allow_task_ids || []);
  const gateProven = !gate || ['integrated_proven', 'released_proven'].includes(state.tasks?.[gate]?.status);
  for (const [id, rec] of Object.entries(state.tasks)) {
    const task = taskById.get(id);
    const currentSignature = task && task.architecture_approval?.approved === true &&
      ['architecture_approved', 'ready'].includes(task.state) &&
      Array.isArray(task.exclusive_files) && task.exclusive_files.length > 0
      ? approvalSignature(task) : null;
    const revoked = !currentSignature || rec.approval_hash !== currentSignature;
    const prClosed = Number.isInteger(rec.pr_number) && rec.github_state !== 'open';
    // A persisted assignment from BEFORE a new priority gate is not approval to
    // send it after the gate is installed. Preserve already-started PR/chat work.
    const priorityHeld = !gateProven && !allow.has(id) &&
      !Number.isInteger(rec.pr_number) && !rec.conversation_ref;
    if (priorityHeld && rec.status === 'assigned') {
      rec.status = 'proposed';
      rec.priority_deferred = true;
      rec.last_action_key = null;
    }
    if (revoked) {
      rec.approved = false;
      // Historical merged-code prerequisites have no current task definition.
      // Revoking browser delivery is NOT revoking proven integration/release.
      if (!['merged', 'integrated_proven', 'released_proven'].includes(rec.status))
        rec.status = 'blocked_needs_owner';
    }
    for (const action of Object.values(state.actions)) {
      if (action.task_id !== id || action.status !== 'planned') continue;
      if (revoked || priorityHeld || (prClosed && action.type !== 'assign')) {
        action.status = revoked ? 'cancelled_approval_changed' :
          priorityHeld ? 'cancelled_priority_gate' : 'cancelled_pr_closed';
      }
    }
  }
  return state;
}

// Preserve cancelled action history. A new deterministic action key may be issued
// only after the priority gate is independently integrated, never for uncertain
// or submitted sends. A pre-existing key is never overwritten or replayed.
export function assignmentActionKey(state, taskId, queue) {
  const original = 'assign:' + taskId;
  const action = state.actions?.[original];
  if (!action) return original;
  const gate = queue?.dispatch_rules?.priority_gate_task;
  if (!gate || action.status !== 'cancelled_priority_gate' ||
      !['integrated_proven','released_proven'].includes(state.tasks?.[gate]?.status) ||
      action.receipt || action.claimed_at || action.submitted_at ||
      action.delivery_claim || state.tasks?.[taskId]?.conversation_ref ||
      Number.isInteger(state.tasks?.[taskId]?.pr_number)) return null;
  const key = original + ':after-' + gate;
  return state.actions[key] ? null : key;
}
