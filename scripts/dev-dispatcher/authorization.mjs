import {createHash} from 'node:crypto';
import { editableFiles } from './core.mjs';
import { approvalMatches, approvalSignature } from './delivery.mjs';
import { proposalSourceHash } from './proposal-stage.mjs';
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
    const landingAllowed=action=>rec.github_state==='merged' &&
      action.type==='landing_failed' && action.head_sha===rec.merge_sha &&
      typeof rec.landing_failure==='string' && rec.landing_failure.length>0;
    if (rec.adhoc === true) {
      for (const action of Object.values(state.actions)) {
        if (action.task_id === id && action.status === 'planned' &&
            ((rec.github_state !== 'open' && !landingAllowed(action)) ||
             !['ci_failed','codex_comments','repair_conflict','no_push_after_prompt','landing_failed'].includes(action.type)))
          action.status = 'cancelled_adhoc_invalid';
      }
      continue;
    }
    const task = taskById.get(id);
    // A signed YES to an unscoped proposal permits planning but never writes.
    if(rec.planning_approved){
      const current=task?.state==='proposed' &&
        task.architecture_approval?.approved!==true &&
        rec.proposal_source_sha===proposalSourceHash(task);
      if(current&&['scope_planning','scope_plan_sent'].includes(rec.status)){
        rec.approved=false;
        for(const a of Object.values(state.actions))
          if(a.task_id===id&&!['scope_plan','scope_plan_update'].includes(a.type)&&a.status==='planned')
            a.status='cancelled_approval_changed';
        continue;
      }
      if(task?.architecture_approval?.approved===true &&
         ['architecture_approved','ready'].includes(task.state) &&
         editableFiles(task).length>0){
        for(const a of Object.values(state.actions))
          if(a.task_id===id&&['scope_plan','scope_plan_update'].includes(a.type)&&a.status==='planned')
            a.status='cancelled_approval_changed';
        rec.scope_plan_completed=Boolean(rec.conversation_ref)&&
          (rec.scope_plan_completed===true||rec.status==='scope_plan_sent');
        rec.planning_approved=false;
        rec.approved=true;rec.approval_hash=approvalSignature(task);
        rec.status='proposed';
        continue;
      }
      for(const a of Object.values(state.actions))
        if(a.task_id===id&&a.status==='planned')
          a.status='cancelled_approval_changed';
      rec.planning_approved=false;rec.approved=false;
      rec.status='blocked_needs_owner';
      continue;
    }
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
      if (revoked || priorityHeld || architectureHeld || (prClosed && action.type !== 'assign' && !landingAllowed(action))) {
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
  const rec=state.tasks?.[taskId];
  const existingPlanChat=rec?.scope_plan_completed===true&&Boolean(rec.conversation_ref);
  if(!rec?.approved||rec.status!=='proposed'||
     (rec.conversation_ref&&!existingPlanChat)||
     Number.isInteger(rec.pr_number)||!/^([a-f0-9]{64})$/.test(rec.approval_hash||''))return null;
  // A previous claim, uncertain submission or receipt is never replay-safe,
  // even when a later action ID exists or a new approval signature is signed.
  const history=Object.values(state.actions||{}).filter(a=>
    a.task_id===taskId&&['assign','begin_scoped_coding'].includes(a.type));
  if(history.some(a=>a.receipt||a.claimed_at||a.submitted_at||
    a.delivery_claim||['planned','claimed','uncertain','submitted','needs_login'].includes(a.status)))
    return null;
  const architectureCancelled=action.status==='cancelled_architecture_gate';
  const priorityCancelled=action.status==='cancelled_priority_gate';
  const approvalCancelled=action.status==='cancelled_approval_changed';
  if(!architectureCancelled&&!priorityCancelled&&!approvalCancelled)return null;
  const gate=architectureCancelled?queue?.dispatch_rules?.architecture_foundation_proof_task:
    priorityCancelled?queue?.dispatch_rules?.priority_gate_task:null;
  if(gate&&(architectureCancelled
    ? !architectureFoundationReady(queue,state.tasks)
    : !['integrated_proven','released_proven'].includes(state.tasks?.[gate]?.status)))return null;
  // Existing post-gate action IDs are retained for compatibility. A changed
  // approval gets a deterministic new key, never overwriting cancelled history.
  const key=approvalCancelled&&existingPlanChat&&
    typeof rec.scope_approval_event_id==='string'&&rec.scope_approval_event_id
      ? original+':scope-'+createHash('sha256').update(
          rec.scope_approval_event_id+':'+rec.approval_hash).digest('hex')
      : approvalCancelled
      ? original+':approval-'+rec.approval_hash
      : original+':after-'+gate;
  return Object.hasOwn(state.actions,key)?null:key;
}
