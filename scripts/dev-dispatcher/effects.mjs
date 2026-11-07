// Trusted-main GitHub effects. Never execute PR code with the private queue token.
// Every irreversible action rechecks live GitHub facts; uncertainty blocks merging.
import { mergeGate } from './core.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';

export function verifyEvidence(record, evidence) {
  if (!evidence || evidence.head_sha !== record.head_sha ||
      evidence.base_sha !== record.base_sha || !Number.isSafeInteger(evidence.ci_run_id) ||
      !Number.isSafeInteger(evidence.acceptance_run_id) ||
      !Array.isArray(evidence.acceptance) || !evidence.acceptance.length ||
      evidence.acceptance.some(item => !item.id || !item.command || !item.job_url || !item.test_file || item.result !== 'passed'))
    return false;
  return true;
}

export function canMerge(record, predecessors, evidence) {
  return mergeGate({ ...record, acceptance_proven: verifyEvidence(record, evidence) }, predecessors);
}

export async function mergeApprovedPr({ github, record, predecessors = [], evidence, expectedAcceptance = [], enabled = false }) {
  if (!enabled) return { status: 'disabled' };
  if (!canMerge(record, predecessors, evidence).eligible) return { status: 'blocked', reasons: canMerge(record, predecessors, evidence).reasons };
  if (!expectedAcceptance.length || evidence.acceptance.length !== expectedAcceptance.length ||
      !expectedAcceptance.every((_, i) => evidence.acceptance[i]?.id === String(i + 1)))
    return { status: 'blocked', reasons: ['acceptance_scenarios_not_accounted_for'] };
  const run = await github.request(`/actions/runs/${evidence.ci_run_id}`);
  if (run.head_sha !== record.head_sha || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.event !== 'pull_request')
    return { status: 'blocked', reasons: ['unverified_ci_evidence'] };
  const jobs = await github.request(`/actions/runs/${run.id}/jobs?per_page=100`);
  if (jobs.total_count > 100 || !jobs.jobs?.some(j => j.conclusion === 'success' &&
      j.name === 'AI CAFE PR baseline'))
    return { status: 'blocked', reasons: ['required_baseline_not_verified'] };
  // The separate acceptance workflow runs the actual scenario files on the exact
  // immutable PR head. An author-supplied URL, path or "passed" assertion is never proof.
  const acceptedRun = await github.request('/actions/runs/' + evidence.acceptance_run_id);
  if (acceptedRun.name !== 'AI CAFE Acceptance Evidence' ||
      acceptedRun.head_sha !== record.head_sha || acceptedRun.event !== 'pull_request' ||
      acceptedRun.status !== 'completed' || acceptedRun.conclusion !== 'success')
    return { status: 'blocked', reasons: ['unverified_acceptance_run'] };
  const acceptedJobs = await github.request('/actions/runs/' + evidence.acceptance_run_id + '/jobs?per_page=100');
  if (acceptedJobs.total_count > 100) return {status:'blocked',reasons:['unverified_acceptance_pagination']};
  const accepted = acceptedJobs.jobs?.filter(j => j.name === 'AI CAFE acceptance evidence' &&
    j.status === 'completed' && j.conclusion === 'success' &&
    j.steps?.some(step => step.name === 'Run approved acceptance scenarios' &&
      step.status === 'completed' && step.conclusion === 'success')) || [];
  if (accepted.length !== 1) return {status:'blocked',reasons:['acceptance_job_did_not_execute']};
  const proof = await github.acceptanceProof(evidence.acceptance_run_id);
  if (!proof || proof.task_id !== record.task_id ||
      proof.run_id !== evidence.acceptance_run_id ||
      proof.head_sha !== record.head_sha || proof.base_sha !== record.base_sha ||
      proof.acceptance_digest !== acceptanceDigest(evidence.acceptance) ||
      !Array.isArray(proof.acceptance) || proof.acceptance.length !== expectedAcceptance.length ||
      !proof.acceptance.every((item,i) => item.id === String(i+1) &&
        item.command === evidence.acceptance[i].command &&
        item.test_file === evidence.acceptance[i].test_file && item.result === 'passed'))
    return { status:'blocked',reasons:['acceptance_artifact_mismatch'] };
  for (const item of evidence.acceptance) {
    if (item.job_url !== accepted[0].html_url)
      return { status: "blocked", reasons: ["unverified_acceptance_job_url"] };
    if (!/^(?:tests|e2e|lib|app|scripts)\/[a-zA-Z0-9_./-]+\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(item.test_file) ||
        item.test_file.includes('..')) return { status: 'blocked', reasons: ['unsafe_test_path'] };
    const file = await github.request(`/contents/${item.test_file}?ref=${record.head_sha}`);
    if (file.type !== 'file') return { status: 'blocked', reasons: ['test_file_missing'] };
  }
  const pr = await github.request(`/pulls/${record.pr_number}`);
  if (pr.merged || pr.state !== 'open' || pr.draft || pr.head.sha !== record.head_sha ||
      pr.base.sha !== record.base_sha || pr.base.ref !== record.base_branch)
    return { status: 'blocked', reasons: ['live_pr_changed'] };
  const live = await github.one(pr);
  if (live.ci_state !== 'success' || live.codex_state !== 'clean' ||
      !live.codex_reviewed_sha || !live.threads_resolved)
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
