import { editableFiles } from './core.mjs';
import { approvalMatches } from './delivery.mjs';
import { architectureFoundationReady } from './core.mjs';

// One authoritative check before the private document is written.
// Records in a private queue are NOT evergreen owner approvals.
export function revalidateQueuedActions(state, taskById, queue = null) {
  const gate = queue?.dispatch_rules?.priority_gate_task;
  const allow = new Set(queue?.dispatch_rules?.priority_gate_allow_task_ids || []);
  const gateProven = !gate || ['integrated_proven', 'released_proven'].includes(state.tasks?.[gate]?.status);
  const foundationDependents = new Set(queue?.dispatch_rules?.architecture_foundation_dependent_task_ids || []);
  const foundationProven = architectureFoundationReady(queue, state.tasks);
  for (const [id, rec] of Object.entries(state.tasks)) {
    const task = taskById.get(id);
    const stillApproved = task && task.architecture_approval?.approved === true &&
      ['architecture_approved', 'ready'].includes(task.state) &&
      editableFiles(task).length > 0;
    const revoked = !stillApproved || !approvalMatches(task, rec.approval_hash);
    const prClosed = Number.isInteger(rec.pr_number) && rec.github_state !== 'open';
    // A persisted assignment from BEFORE a new priority gate is not approval to
    // send it after the gate is installed. Preserve already-started PR/chat work.
    const notStarted = !Number.isInteger(rec.pr_number) && !rec.conversation_ref;
    const priorityHeld = !gateProven && !allow.has(id) && notStarted;
    const architectureHeld = !foundationProven && foundationDependents.has(id) && notStarted;
    if ((priorityHeld || architectureHeld) && rec.status === 'assigned') {
      rec.status = 'proposed';
      if (priorityHeld) rec.priority_deferred = true;
      if (architectureHeld) rec.architecture_deferred = true;
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
      if (revoked || priorityHeld || architectureHeld || (prClosed && action.type !== 'assign')) {
        action.status = revoked ? 'cancelled_approval_changed' :
          priorityHeld ? 'cancelled_priority_gate' :
          architectureHeld ? 'cancelled_architecture_gate' : 'cancelled_pr_closed';
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
  const architectureCancelled = action.status === 'cancelled_architecture_gate';
  const gate = architectureCancelled
    ? queue?.dispatch_rules?.architecture_foundation_proof_task
    : action.status === 'cancelled_priority_gate'
      ? queue?.dispatch_rules?.priority_gate_task : null;
  if (!gate || (architectureCancelled
      ? !architectureFoundationReady(queue, state.tasks)
      : !['integrated_proven','released_proven'].includes(state.tasks?.[gate]?.status)) ||
      action.receipt || action.claimed_at || action.submitted_at ||
      action.delivery_claim || state.tasks?.[taskId]?.conversation_ref ||
      Number.isInteger(state.tasks?.[taskId]?.pr_number)) return null;
  const key = original + ':after-' + gate;
  return state.actions[key] ? null : key;
}
