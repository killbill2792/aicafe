import { approvalSignature } from './delivery.mjs';

// One authoritative check before the private document is written.
// Records in a private queue are NOT evergreen owner approvals.
export function revalidateQueuedActions(state, taskById) {
  for (const [id, rec] of Object.entries(state.tasks)) {
    const task = taskById.get(id);
    const currentSignature = task && task.architecture_approval?.approved === true &&
      ['architecture_approved', 'ready'].includes(task.state) &&
      Array.isArray(task.exclusive_files) && task.exclusive_files.length > 0
      ? approvalSignature(task) : null;
    const revoked = !currentSignature || rec.approval_hash !== currentSignature;
    const prClosed = Number.isInteger(rec.pr_number) && rec.github_state !== 'open';
    if (revoked) {
      rec.approved = false;
      rec.status = 'blocked_needs_owner';
    }
    for (const action of Object.values(state.actions)) {
      if (action.task_id !== id || action.status !== 'planned') continue;
      if (revoked || (prClosed && action.type !== 'assign')) {
        action.status = revoked ? 'cancelled_approval_changed' : 'cancelled_pr_closed';
      }
    }
  }
  return state;
}
