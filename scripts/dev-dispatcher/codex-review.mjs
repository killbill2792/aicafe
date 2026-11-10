// Request one exact-head Codex review after all ready-state gates are verified.
// Never merge, create a draft, or infer review completion from a comment.
import { verifyEvidence } from './effects.mjs';
import { acceptanceDigest } from './acceptance-runner.mjs';

const sha40 = value => /^[a-f0-9]{40}$/.test(value || '');
const proven = status => ['integrated_proven','released_proven'].includes(status);
const marker = sha => '<!-- aicafe-dispatcher-codex-review:' + sha + ' -->';

export async function requestCodexReview({github,record,task,records = {}}) {
  const sha=record?.head_sha;
  if (!task || !sha40(sha) || !Number.isInteger(record.pr_number) ||
      record.github_state !== 'open' || record.draft !== false ||
      record.base_branch !== 'main' || record.base_current !== true ||
      record.approved !== true || record.coder_done !== true ||
      record.ci_state !== 'success' || record.threads_resolved !== true ||
      record.github_owner_question || record.owner_question ||
      record.codex_review_requested_sha === sha ||
      record.codex_reviewed_sha === sha ||
      !verifyEvidence(record,record.acceptance_evidence) ||
      !Array.isArray(task.acceptance) ||
      task.acceptance.length !== record.acceptance_evidence.acceptance.length ||
      (task.depends_on || []).some(id => !proven(records[id]?.status)))
    return {status:'held'};

  const pr=await github.request('/pulls/' + record.pr_number);
  if (pr.state !== 'open' || pr.draft || pr.head?.sha !== sha ||
      pr.base?.ref !== 'main' || pr.base?.sha !== record.base_sha) return {status:'stale'};
  const live=await github.one(pr);
  if (live.head_sha !== sha || live.ci_state !== 'success' ||
      !live.coder_done || !live.threads_resolved || live.github_owner_question ||
      !live.base_current || live.codex_reviewed_sha === sha ||
      !verifyEvidence(live,live.acceptance_evidence)) return {status:'held_live'};

  const evidence=live.acceptance_evidence;
  if (evidence.ci_run_id !== record.acceptance_evidence.ci_run_id ||
      evidence.acceptance_run_id !== record.acceptance_evidence.acceptance_run_id ||
      !task.acceptance.every((_,i)=>evidence.acceptance[i]?.id === String(i+1)))
    return {status:'evidence_changed'};
  const [ciRun,acceptanceRun] = await Promise.all([
    github.request('/actions/runs/' + evidence.ci_run_id),
    github.request('/actions/runs/' + evidence.acceptance_run_id)
  ]);
  if (ciRun.head_sha !== sha || ciRun.event !== 'pull_request' ||
      ciRun.status !== 'completed' || ciRun.conclusion !== 'success' ||
      acceptanceRun.head_sha !== sha || acceptanceRun.event !== 'pull_request' ||
      acceptanceRun.status !== 'completed' || acceptanceRun.conclusion !== 'success')
    return {status:'proof_not_green'};
  const [ciJobs, acceptanceJobs] = await Promise.all([
    github.workflowJobs(ciRun.id),github.workflowJobs(acceptanceRun.id)
  ]);
  if (!ciJobs.some(j=>j.name==='AI CAFE PR baseline' &&
      j.status==='completed' && j.conclusion==='success') ||
      !acceptanceJobs.some(j=>j.name==='AI CAFE acceptance evidence' &&
      j.status==='completed' && j.conclusion==='success' &&
      j.steps?.some(s=>s.name==='Run approved acceptance scenarios' &&
        s.status==='completed' && s.conclusion==='success')))
    return {status:'proof_jobs_missing'};
  const proof=await github.acceptanceProof(acceptanceRun.id);
  if (!proof || proof.task_id !== record.task_id || proof.run_id !== acceptanceRun.id ||
      proof.head_sha !== sha || proof.base_sha !== record.base_sha ||
      proof.acceptance_digest !== acceptanceDigest(evidence.acceptance) ||
      !Array.isArray(proof.acceptance) ||
      proof.acceptance.length !== task.acceptance.length ||
      !proof.acceptance.every((item,i)=>item.id === String(i+1) &&
        item.command === evidence.acceptance[i].command &&
        item.test_file === evidence.acceptance[i].test_file && item.result === 'passed'))
    return {status:'proof_invalid'};
  const comments=await github.paginated('/issues/' + record.pr_number + '/comments','');
  const existing=comments.some(c=>
    String(c.body || '').includes(marker(sha)) ||
    (/@codex\s+review\b/i.test(String(c.body || '')) &&
      ['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association) &&
      Date.parse(c.created_at || '') >= Date.parse(record.last_commit_at || '')));
  if (existing) return {status:'already_requested',head_sha:sha};
  const refreshed=await github.request('/pulls/' + record.pr_number);
  if (refreshed.head?.sha !== sha || refreshed.draft ||
      refreshed.base?.sha !== record.base_sha || refreshed.state !== 'open')
    return {status:'stale'};
  await github.request('/issues/' + record.pr_number + '/comments',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({body:'@codex review\n\n' + marker(sha) +
      '\nDispatcher verified the current head, green CI, acceptance proof and owner/dependency gates.'})
  });
  return {status:'requested',head_sha:sha};
}
