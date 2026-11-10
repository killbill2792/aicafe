import { parseCodexReviewState } from './github.mjs';
// Request one exact-head Codex review after all ready-state gates are verified.
// Never merge, create a draft, or infer review completion from a comment.

const sha40 = value => /^[a-f0-9]{40}$/.test(value || '');
const marker = sha => '<!-- aicafe-dispatcher-codex-review:' + sha + ' -->';
const SETTLE_MS=5*60*1000;
export const settled=(at,now=Date.now())=>Number.isFinite(Date.parse(at||'')) &&
  now-Date.parse(at)>=SETTLE_MS;

export async function requestCodexReview({github,record,task,records = {}}) {
  const sha=record?.head_sha;
  // Green current head is enough to start Codex. No coder-done,
  // acceptance artifact, integrated dependency or routine owner hold.
  if ((!task && !record?.adhoc) || (record?.adhoc && record?.dispatcher_only) ||
      record?.draft===true || !settled(record?.last_commit_at) ||
      !settled(record?.ready_transition_at || '2000-01-01T00:00:00Z') || !sha40(sha) || !Number.isInteger(record.pr_number) ||
      record.github_state !== 'open' || record.ci_state !== 'success' ||
      record.codex_review_requested_sha === sha ||
      record.codex_in_progress_sha === sha ||
      record.codex_reviewed_sha === sha ||
      record.codex_state === 'clean' || record.codex_state === 'findings')
    return {status:'held'};
  const pr=await github.request('/pulls/' + record.pr_number);
  if (pr.state !== 'open' || pr.head?.sha !== sha)
    return {status:'stale'};
  if(pr.draft || !settled(pr.created_at || '2000-01-01T00:00:00Z'))
    return {status:'automatic_review_grace'};
  const live=await github.one(pr);
  if (live.head_sha !== sha || live.ci_state !== 'success' ||
      !settled(live.last_commit_at || record.last_commit_at) ||
      live.codex_reviewed_sha === sha || live.codex_in_progress_sha === sha ||
      live.codex_state === 'clean' ||
      live.codex_state === 'findings' || live.sensitive_owner_block)
    return {status:'held_live'};
  const comments=await github.paginated('/issues/' + record.pr_number + '/comments','');
  // A running/queued authenticated Codex connector receipt is already a
  // review request for the immutable head: never post a duplicate trigger.
  const running=comments.some(c=>
    c.user?.login === 'chatgpt-codex-connector[bot]' &&
    parseCodexReviewState(String(c.body || ''),sha)?.state === 'pending');
  if (running) return {status:'already_running',head_sha:sha};
  const existing=comments.some(c=>
    String(c.body || '').includes(marker(sha)) ||
    (/@codex\s+review\b/i.test(String(c.body || '')) &&
      ['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association) &&
      Date.parse(c.created_at || '') >= Date.parse(record.last_commit_at || '')));
  if (existing) return {status:'already_requested',head_sha:sha};
  const refreshed=await github.request('/pulls/' + record.pr_number);
  if (refreshed.head?.sha !== sha || refreshed.state !== 'open')
    return {status:'stale'};
  await github.request('/issues/' + record.pr_number + '/comments',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({body:'@codex review\n\n' + marker(sha) +
      '\nDispatcher verified the current head and green required checks.'})
  });
  return {status:'requested',head_sha:sha};
}
