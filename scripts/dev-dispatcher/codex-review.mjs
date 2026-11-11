import {settings} from './settings.mjs';
import { parseCodexReviewState } from './github.mjs';
// Request one exact-head Codex review after all ready-state gates are verified.
// Never merge, create a draft, or infer review completion from a comment.

const sha40 = value => /^[a-f0-9]{40}$/.test(value || '');
const marker = sha => '<!-- '+settings.naming.marker_prefix+'-dispatcher-codex-review:' + sha + ' -->';
// New commits may trigger Codex only after all required CI checks finish green.
// The ready transition already triggers automatic review; no CI-parallel timer.

export async function requestCodexReview({github,record,task,records = {},autoMissFallback=false}) {
  const sha=record?.head_sha;
  // Green current head is enough to start Codex. No coder-done,
  // acceptance artifact, integrated dependency or routine owner hold.
  if ((!task && !record?.adhoc) || (record?.adhoc && record?.dispatcher_only) ||
      record?.draft===true || !sha40(sha) || !Number.isInteger(record.pr_number) ||
      record.github_state !== 'open' || record.ci_state !== 'success' ||
      (record.codex_review_requested_sha === sha && !autoMissFallback) ||
      (autoMissFallback && (record.codex_review_requested_sha !== sha ||
        record.codex_fallback_requested_sha === sha ||
        !Number.isFinite(Date.parse(record.ready_transition_at||'')))) ||
      record.codex_in_progress_sha === sha ||
      record.codex_reviewed_sha === sha ||
      record.codex_state === 'clean' || record.codex_state === 'findings')
    return {status:'held'};
  const pr=await github.request('/pulls/' + record.pr_number);
  if (pr.state !== 'open' || pr.head?.sha !== sha)
    return {status:'stale'};
  if(pr.draft)return {status:'draft_not_ready'};
  const live=await github.one(pr);
  if (live.head_sha !== sha || live.ci_state !== 'success' ||
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

// Check GitHub receipts on the existing dispatcher tick. A timed-out request
// escalates to the referee; unchanged code is never requested again.
const codexActor=login=>/^(?:chatgpt-codex-connector(?:\[bot\])?|codex(?:\[bot\])?)$/i.test(login||'');
const trustedRequester=c=>['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association)||
  c.user?.login==='github-actions[bot]';
export function codexWatchMinutes(value) {
  if(value==null||value==='')return 20;
  const n=Number(value);
  return Number.isInteger(n)&&n>=1&&n<=1440?n:20;
}
const isRequest=(c,head,lastCommitAt)=>{
  if(!trustedRequester(c))return false;
  const body=String(c.body||'');
  return body.includes(marker(head))||
    (/@codex\s+review\b/i.test(body)&&Date.parse(c.created_at||'')>=Date.parse(lastCommitAt||''));
};
export function codexWatchDecision({record,comments=[],reviews=[],reactions=[],now=Date.now(),minutes=20}) {
  const head=record?.head_sha;
  if(!sha40(head)||!Number.isInteger(record.pr_number)||
     record.github_state!=='open'||record.codex_review_requested_sha!==head||
     record.codex_reviewed_sha===head||['clean','findings'].includes(record.codex_state))
    return {status:'held'};
  const requests=comments.filter(c=>isRequest(c,head,record.last_commit_at))
    .sort((a,b)=>Date.parse(a.created_at||'')-Date.parse(b.created_at||''));
  if(reviews.some(r=>r.commit_id===head&&codexActor(r.user?.login))||
     comments.some(c=>codexActor(c.user?.login)&&parseCodexReviewState(c.body||'',head))||
     reactions.some(r=>codexActor(r.user?.login)))return {status:'receipt'};
  // GitHub's verified draft -> Ready transition automatically requests Codex.
  // It has no @codex comment, so use its recorded current-head timestamp for
  // the SAME missing-review watchdog, without requesting a second review.
  const readyAt=record.draft===false&&record.codex_review_requested_sha===head
    ? Date.parse(record.ready_transition_at||'') : NaN;
  // Once there is a real @codex request, restart the watchdog from that
  // authenticated GitHub comment rather than the earlier Ready transition.
  const first=requests.length
    ? Math.min(...requests.map(c=>Date.parse(c.created_at||'')).filter(Number.isFinite))
    : readyAt;
  if(!Number.isFinite(first))return {status:'no_verified_request'};
  if(!Number.isFinite(now)||now-first<minutes*60_000)
    return {status:'pending'};
  // An Actions-bot Ready transition is not evidence that Codex received a
  // request. Permit one explicit fallback only when no actual request exists.
  // A second missed manual request is escalated, never repeated.
  return {status:requests.length?'escalate':'auto_review_missing',head_sha:head};
}
export async function inspectCodexWatch({github,record,now=Date.now(),minutes=20}) {
  if(!sha40(record?.head_sha)||record?.github_state!=='open'||
     record.codex_review_requested_sha!==record.head_sha)return {status:'held'};
  const pr=await github.request('/pulls/'+record.pr_number);
  if(pr.state!=='open'||pr.head?.sha!==record.head_sha)return {status:'stale'};
  if(pr.draft===true)return {status:'held'};
  const [comments,reviews]=await Promise.all([
    github.paginated('/issues/'+record.pr_number+'/comments','comments'),
    github.paginated('/pulls/'+record.pr_number+'/reviews','reviews')
  ]);
  const readyAt=record.draft===false&&record.codex_review_requested_sha===record.head_sha
    ? Date.parse(record.ready_transition_at||'') : NaN;
  const first=Math.min(...[
    ...comments.filter(c=>isRequest(c,record.head_sha,record.last_commit_at))
      .map(c=>Date.parse(c.created_at||'')),readyAt
  ].filter(Number.isFinite));
  const reactions=[];
  if(Number.isFinite(first)) {
    const issue=await github.paginated('/issues/'+record.pr_number+'/reactions','reactions');
    reactions.push(...issue.filter(r=>Date.parse(r.created_at||'')>=first));
  }
  for(const c of comments.filter(c=>isRequest(c,record.head_sha,record.last_commit_at)))
    if(Number.isInteger(c.id))
      reactions.push(...await github.paginated('/issues/comments/'+c.id+'/reactions','reactions'));
  return codexWatchDecision({record,comments,reviews,reactions,now,minutes});
}
