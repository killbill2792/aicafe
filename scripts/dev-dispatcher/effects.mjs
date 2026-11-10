import {settings} from './settings.mjs';
// Trusted-main GitHub effects. Never execute PR code with the private queue token.
// Every irreversible action rechecks live GitHub facts; uncertainty blocks merging.
import { mergeGate, readyGate } from './core.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';
import {verifyLiveCarryOver} from './codex-carryover.mjs';

export function verifyEvidence(record, evidence) {
  if (!evidence || evidence.head_sha !== record.head_sha ||
      evidence.base_sha !== record.base_sha || !Number.isSafeInteger(evidence.ci_run_id) ||
      !Number.isSafeInteger(evidence.acceptance_run_id) ||
      !Array.isArray(evidence.acceptance) || !evidence.acceptance.length ||
      evidence.acceptance.some(item => !item.id || !item.command || !item.job_url || !item.test_file || item.result !== 'passed'))
    return false;
  return true;
}

// Same landing workflow as normal main pushes. GITHUB_TOKEN merges suppress
// automatic push-triggered Actions, so dispatch only AFTER a confirmed merge.
export async function dispatchLandingCheck(github, mergedSha) {
  if (!/^[a-f0-9]{40}$/.test(mergedSha||'')) return 'invalid_merge_sha';
  try {
    await github.request('/actions/workflows/landing-check.yml/dispatches',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ref:'main',inputs:{merged_sha:mergedSha}})
    });
    return 'requested';
  } catch {
    return 'failed_needs_retry';
  }
}
export function canMerge(record, predecessors) {
  return mergeGate(record, predecessors);
}

// The owner-approved coding lifecycle has exactly six merge conditions:
// current-head required checks, clean newest exact-head Codex receipt, no
// unresolved threads, ready (not draft), GitHub mergeability, merge order.
// Privileged paid/live/prod/secret labels remain an explicit owner hold.
export async function mergeApprovedPr({ github, record, predecessors = [],
  enabled = false, action = 'merge' }) {
  if (!enabled) return {status:'disabled'};
  if (!['ready','merge'].includes(action))
    return {status:'blocked',reasons:['invalid_lifecycle_action']};
  const prepareReady = action === 'ready';
  if (!prepareReady && record?.adhoc) {
    if (record.dispatcher_only)
      return {status:'blocked',reasons:['owner_merge_required']};
    if (record.base_branch !== 'main')
      return {status:'blocked',reasons:['adhoc_parent_base_not_main']};
  }
  const gate = prepareReady ? readyGate(record) : canMerge(record,predecessors);
  if (!gate.eligible) return {status:'blocked',reasons:gate.reasons};
  // Never trust stale ledger state for irreversible effects.
  const pr=await github.request(`/pulls/${record.pr_number}`);
  if (pr.state !== 'open' || pr.merged || pr.draft !== prepareReady ||
      pr.head?.sha !== record.head_sha || pr.base?.sha !== record.base_sha ||
      (!prepareReady && pr.mergeable !== true))
    return {status:'blocked',reasons:['live_pr_changed']};
  const live=await github.one(pr);
  // Recheck the actual GitHub base and changed paths: an adopted stacked PR
  // cannot merge into its open parent (or trigger main integration proof).
  if (!prepareReady && record.adhoc &&
      (pr.base?.ref !== 'main' || live.base_branch !== 'main' ||
       live.dispatcher_only))
    return {status:'blocked',reasons:['adhoc_base_or_owner_merge_changed']};
  const directClean=live.codex_state==='clean' && live.codex_reviewed_sha===record.head_sha;
  const carriedClean=!prepareReady && !directClean &&
    live.codex_state!=='findings' && live.codex_in_progress_sha!==live.head_sha &&
    await verifyLiveCarryOver({github,record,live});
  if (live.head_sha !== record.head_sha || live.ci_state !== 'success' ||
      live.repo_marker_mismatch || live.sensitive_owner_block || (!prepareReady &&
        ((!directClean && !carriedClean) || live.threads_resolved !== true)))
    return {status:'blocked',reasons:['live_checks_changed']};
  // Head and base may move between the first and final GitHub reads.
  const latest=await github.request(`/pulls/${record.pr_number}`);
  if (!prepareReady && record.adhoc && latest.base?.ref !== 'main')
    return {status:'blocked',reasons:['adhoc_parent_base_not_main']};
  if (latest.state !== 'open' || latest.head?.sha !== record.head_sha ||
      latest.base?.sha !== record.base_sha || latest.draft !== prepareReady ||
      (!prepareReady && latest.mergeable !== true) ||
      (latest.labels || []).some(label =>
        /(?:^|[-_])(paid|live|prod|production|secret|secrets)(?:$|[-_])/i.test(label.name || '') &&
        !/^(?:approved|owner-approved)/i.test(label.name || '')))
    return {status:'blocked',reasons:['merge_conflict_or_stale_base']};
  if (prepareReady) {
    if (!latest.node_id) return {status:'blocked',reasons:['missing_github_pr_node_id']};
    const ready=await github.request('https://api.github.com/graphql',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query:'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}',
        variables:{id:latest.node_id}})
    });
    if (ready.errors?.length ||
        ready.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false)
      return {status:'blocked',reasons:['github_ready_not_verified']};
    return {status:'ready_for_review'};
  }
  const result = await github.request(`/pulls/${record.pr_number}/merge`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    // Preserve parent commits so stacked child branches retain their ancestry.
    // Squash rewrites that ancestry and can make an open child unmergeable.
    body: JSON.stringify({ merge_method: 'merge', sha: record.head_sha,
      commit_title: `${settings.chatgpt.project_name} approved task ${record.task_id} (#${record.pr_number})` })
  });
  if (result.merged !== true || !result.sha) throw new Error('GitHub did not confirm merge');
  // GITHUB_TOKEN pushes do not trigger push workflows. workflow_dispatch does.
  // Keep merge distinct from integration proof, even when dispatch fails.
  let integration_dispatch = 'requested';
  try {
    await github.request('/actions/workflows/'+settings.workflows.integration+'/dispatches', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ref:'main',inputs:{merged_sha:result.sha}}),
    });
  } catch { integration_dispatch = 'failed_needs_retry'; }
  const landing_dispatch=await dispatchLandingCheck(github,result.sha);
  return { status: 'merged_unproven', merge_sha: result.sha, integration_dispatch, landing_dispatch };
}

// Only a GitHub-confirmed runner startup failure is retried; no guessing from a red CI badge.
// Reserve the single retry durably *before* requesting the external effect (fail-closed on crashes).
export async function retryStartupFailure({github, ledger, taskId, record, enabled = false}) {
  if (!enabled) return {status:'disabled'};
  if (!record?.approved || record.github_state !== 'open' ||
      record.ci_state !== 'failure' || record.ci_failure_kind !== 'startup_failure' ||
      !record.head_sha || !Number.isInteger(record.pr_number))
    return {status:'not_verified_infrastructure_failure'};
  const run = await github.transientBaselineRun(record.head_sha);
  if (!run) return {status:'not_verified_infrastructure_failure'};
  const reserved = await ledger.transaction(state => {
    const current = state.tasks?.[taskId];
    if (!current || current.head_sha !== record.head_sha ||
        current.transient_ci_retry?.run_id === run.id) return null;
    current.transient_ci_retry = {run_id:run.id,head_sha:record.head_sha,
      reserved_at:new Date().toISOString(),status:'reserved'};
    return state;
  });
  if (!reserved.committed) return {status:'already_reserved'};
  await github.rerunFailedJobs(run.id);
  return {status:'retry_requested',run_id:run.id};
}

// Only an independently verified integration run on the merged main SHA can release dependents.
// No "merged" or author checklist is equivalent to integration proof.
export function integrationStatus({ merged_sha, main_sha, proof, expectedAcceptance = [] }) {
  if (!merged_sha || !main_sha || !proof || proof.main_sha !== main_sha ||
      proof.merged_sha !== merged_sha || proof.conclusion !== 'success' ||
      !proof.workflow_run_id || !Array.isArray(proof.required_scenarios) ||
      !proof.required_scenarios.length || proof.required_scenarios.some(s => s.result !== 'passed') ||
      (expectedAcceptance.length > 0 &&
       !(proof.proof_basis==='exact_sha_required_checks'&&
         proof.required_scenarios.length===proof.required_checks?.length&&
         proof.required_scenarios.every(s=>s.check&&s.result==='passed')) &&
       (proof.required_scenarios.length !== expectedAcceptance.length ||
        !proof.required_scenarios.every((s,i) => s.id === String(i+1) && !!s.test_file && !!s.command))))
    return 'merged_unproven';
  return 'integrated_proven';
}

export async function safeUpdateBranch({ github, record, enabled = false }) {
  if (!enabled) return { status:'disabled' };
  if (!record?.pr_number || !record?.head_sha || record.github_state !== 'open')
    return { status:'blocked', reason:'unverified_pr' };
  const pr=await github.request(`/pulls/${record.pr_number}`);
  if (pr.state!=='open' || pr.head.sha!==record.head_sha ||
      pr.base.ref!==record.base_branch || pr.merged) return {status:'blocked',reason:'live_pr_changed'};
  if (pr.mergeable===false) return {status:'blocked',reason:'conflict_needs_coder'};
  await github.request(`/pulls/${record.pr_number}/update-branch`, {
    method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({expected_head_sha:record.head_sha})
  });
  return {status:'updating',reason:'recheck_new_head_and_all_checks'};
}

// Compatibility entrypoint: one actual retarget/update path, never a lighter gate.
export async function retargetAfterIntegration({github,dependent,predecessor,enabled=false}) {
  if (!enabled) return {status:'disabled'};
  return updateChildAfterParentMerge({github,dependent,predecessor});
}

// Trusted-main branch maintenance is NOT a merge or integration proof gate.
// Verify actual parent merge before changing a child, then request update-branch.
// A conflict is reported to the same child chat rather than force-pushed.
export async function updateChildAfterParentMerge({github,dependent,predecessor}) {
  if (!dependent?.pr_number || !dependent?.head_sha ||
      dependent.github_state !== 'open' ||
      !predecessor?.pr_number || !predecessor?.merge_sha ||
      !predecessor?.branch || !['merged','integrated_proven','released_proven'].includes(predecessor.status))
    return {status:'blocked',reason:'unverified_predecessor_or_child'};
  const parent = await github.request('/pulls/' + predecessor.pr_number);
  if (!parent.merged_at || parent.merge_commit_sha !== predecessor.merge_sha ||
      parent.head?.ref !== predecessor.branch)
    return {status:'blocked',reason:'parent_merge_not_verified_live'};
  let child = await github.request('/pulls/' + dependent.pr_number);
  if (child.state !== 'open' || child.merged || child.head.sha !== dependent.head_sha ||
      ![predecessor.branch,'main'].includes(child.base.ref))
    return {status:'blocked',reason:'child_live_head_or_base_changed'};
  if (child.base.ref === predecessor.branch) {
    await github.request('/pulls/' + dependent.pr_number,{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({base:'main'})
    });
    child = await github.request('/pulls/' + dependent.pr_number);
    if (child.state !== 'open' || child.head.sha !== dependent.head_sha ||
        child.base.ref !== 'main')
      return {status:'blocked',reason:'retarget_not_verified'};
  }
  // Don't force-push or override a fresh branch head. Any 422/conflict is
  // surfaced and the existing same-chat nudge tells the coder to resolve it.
  try {
    await github.request('/pulls/' + dependent.pr_number + '/update-branch',{
      method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({expected_head_sha:dependent.head_sha})
    });
    return {status:'update_requested',parent_merge_sha:predecessor.merge_sha};
  } catch {
    return {status:'update_failed_needs_coder',parent_merge_sha:predecessor.merge_sha};
  }
}
