// Trusted-main GitHub effects. Never execute PR code with the private queue token.
// Every irreversible action rechecks live GitHub facts; uncertainty blocks merging.
import { mergeGate } from './core.mjs';

export function verifyEvidence(record, evidence) {
  if (!evidence || evidence.head_sha !== record.head_sha ||
      evidence.base_sha !== record.base_sha || evidence.ci_run_id == null ||
      !Array.isArray(evidence.acceptance) || !evidence.acceptance.length ||
      evidence.acceptance.some(item => !item.id || !item.command || !item.job_url || item.result !== 'passed'))
    return false;
  return true;
}

export function canMerge(record, predecessors, evidence) {
  return mergeGate({ ...record, acceptance_proven: verifyEvidence(record, evidence) }, predecessors);
}

export async function mergeApprovedPr({ github, record, predecessors = [], evidence, enabled = false }) {
  if (!enabled) return { status: 'disabled' };
  if (!canMerge(record, predecessors, evidence).eligible) return { status: 'blocked', reasons: canMerge(record, predecessors, evidence).reasons };
  const pr = await github.request(`/pulls/${record.pr_number}`);
  if (pr.merged || pr.state !== 'open' || pr.draft || pr.head.sha !== record.head_sha ||
      pr.base.sha !== record.base_sha || pr.base.ref !== record.base_branch)
    return { status: 'blocked', reasons: ['live_pr_changed'] };
  const live = await github.one(pr);
  if (live.ci_state !== 'success' || live.codex_state !== 'clean' ||
      live.codex_reviewed_sha !== record.head_sha || !live.threads_resolved)
    return { status: 'blocked', reasons: ['live_checks_changed'] };
  // Re-fetch base SHA immediately before merge to reject intervening main changes.
  const latest = await github.request(`/pulls/${record.pr_number}`);
  if (latest.head.sha !== record.head_sha || latest.base.sha !== record.base_sha ||
      latest.mergeable !== true) return { status: 'blocked', reasons: ['merge_conflict_or_stale_base'] };
  const result = await github.request(`/pulls/${record.pr_number}/merge`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash', sha: record.head_sha,
      commit_title: `AI CAFE approved task ${record.task_id} (#${record.pr_number})` })
  });
  if (result.merged !== true || !result.sha) throw new Error('GitHub did not confirm merge');
  return { status: 'merged_unproven', merge_sha: result.sha };
}

// Only an independently verified integration run on the merged main SHA can release dependents.
// No "merged" or author checklist is equivalent to integration proof.
export function integrationStatus({ merged_sha, main_sha, proof }) {
  if (!merged_sha || !main_sha || !proof || proof.main_sha !== main_sha ||
      proof.merged_sha !== merged_sha || proof.conclusion !== 'success' ||
      !proof.workflow_run_id || !Array.isArray(proof.required_scenarios) ||
      !proof.required_scenarios.length || proof.required_scenarios.some(s => s.result !== 'passed'))
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

export async function retargetAfterIntegration({github,dependent,predecessor,enabled=false}) {
  if(!enabled)return {status:'disabled'};
  if(!dependent?.pr_number || !predecessor?.branch ||
      !['integrated_proven','released_proven'].includes(predecessor.status))
    return {status:'blocked',reason:'predecessor_not_integrated'};
  const pr=await github.request(`/pulls/${dependent.pr_number}`);
  if(pr.state!=='open' || pr.base.ref!==predecessor.branch ||
     pr.head.sha!==dependent.head_sha) return {status:'blocked',reason:'unexpected_pr'};
  await github.request(`/pulls/${dependent.pr_number}`,{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({base:'main'})
  });
  return {status:'retargeted',reason:'all_ci_codex_and_evidence_must_be_rechecked'};
}
