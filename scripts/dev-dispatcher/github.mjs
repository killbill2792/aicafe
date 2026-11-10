import { inflateRawSync } from 'node:zlib';
// Read-only GitHub facts. Never checks out or runs untrusted PR code.
export function parseTaskMarker(body) {
  if (typeof body !== 'string' || body.length > 100000) return null;
  const marks = [...body.matchAll(/<!-- aicafe-task-id\s+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\s*-->/g)];
  return marks.length === 1 ? marks[0][1] : null;
}
export function parseOwnerQuestion(body) {
  if (typeof body !== 'string' || body.length > 100000) return null;
  const matches = [...body.matchAll(/<!-- aicafe-owner-question\s+([\s\S]*?)\s*-->/g)];
  if (matches.length !== 1 || matches[0][1].length > 1200) return null;
  return matches[0][1].trim() || null;
}
// Only GitHub's authenticated Codex connector summary and an exact 40-digit head
// may establish a completed review. A short text receipt never grants merge.
export function parseCodexReviewState(body, sha) {
  if (typeof body !== 'string' || !/^[a-f0-9]{40}$/.test(sha || '')) return null;
  const match = body.match(/^<!-- codex-pull-request-review-summary -->\s*<!-- codex-review-state:v1 (\{[^\n]{1,1200}\}) -->/);
  if (!match) return null;
  try {
    const review = JSON.parse(match[1]).code_review;
    if (!review || review.commit_sha !== sha) return null;
    // A running newer review overrides an earlier clean review on the same SHA.
    if (review.status === 'running' || review.status === 'queued')
      return {state:'pending',sha};
    if (review.status !== 'completed' ||
        typeof review.has_any_findings !== 'boolean' ||
        typeof review.has_unresolved_findings !== 'boolean') return null;
    return { state: review.has_any_findings || review.has_unresolved_findings ? 'findings' : 'clean',
      sha };
  } catch { return null; }
}
export function parseAcceptanceEvidence(body) {
  if (typeof body !== "string" || body.length > 100000) return null;
  const match = body.match(/<!-- aicafe-acceptance-evidence\s*([\s\S]*?)\s*-->/);
  if (!match || match[1].length > 20000) return null;
  try { const value = JSON.parse(match[1]);
    return value && typeof value === "object" && Array.isArray(value.acceptance) ? value : null;
  } catch { return null; }
}
// GitHub artifact downloads are small ZIP archives. Only one fixed JSON filename is accepted.
export function decodeAcceptanceArchive(input, expectedFilename = 'acceptance-proof.json') {
  const zip = Buffer.from(input);
  if (zip.length > 262144 || zip.length < 30) throw new Error('Invalid acceptance archive size');
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 10) !== 1) throw new Error('Expected one proof artifact');
  const dir = zip.readUInt32LE(end + 16);
  if (dir + 46 > zip.length || zip.readUInt32LE(dir) !== 0x02014b50) throw new Error('Bad ZIP directory');
  const method = zip.readUInt16LE(dir + 10);
  const compressed = zip.readUInt32LE(dir + 20);
  const original = zip.readUInt32LE(dir + 24);
  const nameLength = zip.readUInt16LE(dir + 28);
  const name = zip.subarray(dir + 46, dir + 46 + nameLength).toString('utf8');
  const at = zip.readUInt32LE(dir + 42);
  if (name !== expectedFilename || original > 32768 || compressed > 65536 ||
      at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50 ||
      ![0, 8].includes(method)) throw new Error('Unexpected proof archive entry');
  const position = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  if (position + compressed > zip.length) throw new Error('Truncated acceptance proof');
  const source = zip.subarray(position, position + compressed);
  const decoded = method === 8 ? inflateRawSync(source, { maxOutputLength: 32768 }) : source;
  if (decoded.length !== original) throw new Error('Acceptance proof size mismatch');
  return JSON.parse(decoded.toString('utf8'));
}

// Only GitHub-verified changed paths classify a dispatcher governance/implementation
// PR as non-task maintenance. Titles, branches, PR markers and labels are NOT proof.
export function isDispatcherMaintenanceChange(files) {
  return Array.isArray(files) && files.length > 0 && files.every(file =>
    typeof file?.filename === 'string' && (
      file.filename === 'AGENTS.md' ||
      file.filename === '.claude/skills/aicafe-pr-lifecycle/SKILL.md' ||
      file.filename === '.github/workflows/ai-cafe-dev-dispatcher.yml' ||
      /^scripts\/dev-dispatcher\//.test(file.filename)));
}

export class GitHubFacts {
  constructor({ repo, token, fetchFn = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error("GitHub repo/token required");
    this.repo = repo; this.token = token; this.fetchFn = fetchFn;
  }
  async request(url, options = {}) {
    const response = await this.fetchFn(url.startsWith("https:") ? url : `https://api.github.com/repos/${this.repo}${url}`, {
      ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28", ...options.headers },
    });
    if (!response.ok) throw new Error(`GitHub request failed: ${response.status}`);
    if (response.status === 204) return { ok:true };
    return response.json();
  }
  // Collection pagination is mandatory for prompt proof transitions: stopping at
  // page one delays integrated_proven indefinitely on busy repositories.
  async paginated(path, key, maxPages = 20) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const result = await this.request(path + separator + 'per_page=100&page=' + page);
      const chunk = Array.isArray(result) ? result : result?.[key];
      if (!Array.isArray(chunk)) throw new Error('Invalid GitHub pagination: ' + key);
      items.push(...chunk);
      if (chunk.length < 100) return items;
    }
    throw new Error('GitHub pagination limit reached: ' + key);
  }
  async workflowRuns(workflow, filters = '') {
    if (!/^[a-z0-9-]+\.yml$/.test(workflow)) throw new Error('Invalid workflow');
    return this.paginated('/actions/workflows/' + workflow + '/runs' +
      (filters ? '?' + filters : ''), 'workflow_runs');
  }
  async workflowJobs(runId) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid workflow run');
    return this.paginated('/actions/runs/' + runId + '/jobs', 'jobs');
  }
  async proofArtifact(runId, artifactName, filename) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid proof run');
    const artifacts = await this.paginated('/actions/runs/' + runId + '/artifacts','artifacts');
    const matches = artifacts.filter(a => a.name === artifactName && !a.expired);
    if (matches.length !== 1) return null;
    const response = await this.fetchFn('https://api.github.com/repos/' + this.repo +
      '/actions/artifacts/' + matches[0].id + '/zip', {headers:{
        Authorization:'Bearer ' + this.token,
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'
      }});
    if (!response.ok) throw new Error('Proof artifact download failed: ' + response.status);
    return decodeAcceptanceArchive(Buffer.from(await response.arrayBuffer()), filename);
  }
  async acceptanceProof(runId) {
    return this.proofArtifact(runId, 'aicafe-acceptance-proof', 'acceptance-proof.json');
  }
  async integrationProof(runId) {
    return this.proofArtifact(runId, 'aicafe-main-integration-proof', 'integration-proof.json');
  }
  async transientBaselineRun(headSha) {
    if (!/^[a-f0-9]{40}$/.test(headSha || '')) throw new Error('Invalid CI head SHA');
    const result = await this.request('/actions/runs?head_sha=' + headSha +
      '&event=pull_request&per_page=100');
    if (result.total_count > 100) throw new Error('CI run pagination not verified');
    return (result.workflow_runs || []).filter(run =>
      run.name === 'AI CAFE Pull Request Baseline' &&
      run.head_sha === headSha && run.event === 'pull_request' &&
      run.status === 'completed' && run.conclusion === 'startup_failure')
      .sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
  }
  async rerunFailedJobs(runId) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid retry run');
    const response = await this.fetchFn('https://api.github.com/repos/' + this.repo +
      '/actions/runs/' + runId + '/rerun-failed-jobs', {method:'POST',headers:{
        Authorization:'Bearer ' + this.token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'
      }});
    if (!response.ok) throw new Error('Transient CI retry rejected: ' + response.status);
    return true;
  }
  async openPulls() {
    const results = [];
    for (let page = 1; page <= 10; page++) {
      const chunk = await this.request(`/pulls?state=open&per_page=100&page=${page}`);
      results.push(...chunk);
      if (chunk.length < 100) return results;
    }
    throw new Error("Too many open PRs; paginate before acting");
  }
  async unresolved(number) {
    const [owner, name] = this.repo.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100){ pageInfo{hasNextPage} nodes{isResolved} } } } }`;
    const result = await this.request("https://api.github.com/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, name, number } }),
    });
    if (result.errors?.length || !result.data?.repository?.pullRequest?.reviewThreads) return null;
    const threads = result.data.repository.pullRequest.reviewThreads;
    if (threads.pageInfo.hasNextPage) return null; // do not silently ignore further threads
    return threads.nodes.filter(t => !t.isResolved).length;
  }
  async ownerDecision(pr, comments = null) {
    if (!(pr.labels || []).some(label => label.name === 'needs-owner-decision'))
      return { question: null, url: null, approved: false };
    const inBody = parseOwnerQuestion(pr.body);
    // A newer authenticated owner approval resolves the decision even if the
    // label or structured question marker has not yet been removed.
    comments ??= await this.request(`/issues/${pr.number}/comments?per_page=100`);
    if (!Array.isArray(comments) || comments.length >= 100)
      throw new Error('Owner-question comments require verified pagination');
    const latestApproval = comments.filter(c => c.author_association === 'OWNER' &&
      /^\s*Owner approved\b/i.test(String(c.body || '')))
      .sort((a,b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))[0];
    const questionTime = comments.filter(c =>
      ['OWNER','MEMBER','COLLABORATOR'].includes(c.author_association) &&
      parseOwnerQuestion(c.body)).reduce((at,c) =>
        Math.max(at,Date.parse(c.created_at || '') || 0), 0);
    if (latestApproval && Date.parse(latestApproval.created_at || '') >= questionTime &&
        (!inBody || Date.parse(latestApproval.created_at || '') >= Date.parse(pr.updated_at || '') ||
          questionTime > 0))
      return { question: null, url: null, approved: true };
    if (inBody) return { question: inBody, url: pr.html_url || null };
    // Owners can request a decision in the PR conversation, not only in its body.
    // Only trusted repository contributors may supply an actionable question.
    const trusted = comments.filter(c =>
      ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association));
    const match = trusted.reverse().find(c => parseOwnerQuestion(c.body));
    if (match) return { question: parseOwnerQuestion(match.body), url: match.html_url || null };
    // Missing structured question must not silently turn a labeled PR mergeable.
    return { question: 'Owner decision requested on PR; check its discussion for the exact scope.',
      url: pr.html_url || null };
  }

  // Only unresolved human/Codex review threads are included in coder nudges.
  // This is GitHub evidence, not an instruction source or merge proof.
  async unresolvedComments(number) {
    const [owner,name]=this.repo.split('/');
    const query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:10){pageInfo{hasNextPage} nodes{body url}}}}}}}}';
    const result=await this.request('https://api.github.com/graphql',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query,variables:{owner,name,number}})});
    const threads=result.data?.repository?.pullRequest?.reviewThreads;
    if(result.errors?.length || !threads || threads.pageInfo.hasNextPage)
      return [];
    return threads.nodes.filter(t=>!t.isResolved).slice(0,4).map(t=>{
      const comment=t.comments?.nodes?.[0];
      return {body:String(comment?.body || 'Unresolved review thread')
        .replace(/\s+/g,' ').slice(0,160),url:comment?.url || null};
    });
  }
  async one(pr) {
    const sha = pr.head.sha;
    const [checks, reviews, unresolved, commit, comparison, comments] = await Promise.all([
      this.request(`/commits/${sha}/check-runs?per_page=100`),
      this.request(`/pulls/${pr.number}/reviews?per_page=100`),
      this.unresolved(pr.number),
      this.request(`/commits/${sha}`),
      this.request(`/compare/${encodeURIComponent(pr.base.sha)}...${encodeURIComponent(sha)}`),
      this.request(`/issues/${pr.number}/comments?per_page=100`),
    ]);
    if (!Array.isArray(comments) || comments.length >= 100)
      throw new Error('PR comments require verified pagination');
    const ownerDecision = await this.ownerDecision(pr, comments);
    if (checks.total_count > 100 || reviews.length >= 100) throw new Error("PR review/check pagination not verified");
    const baseline = checks.check_runs.find(c => c.name === "AI CAFE PR baseline");
    const ci = !baseline || baseline.status !== "completed" ? "pending" :
      baseline.conclusion === "success" ? "success" : "failure";
    const failingJob = checks.check_runs.find(c => c.conclusion === 'failure' &&
      c.name !== baseline?.name) || (ci === 'failure' ? baseline : null);
    const codexReviews = reviews.filter(r => /codex/i.test(r.user?.login || ""))
      .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
    // Preserve unresolved findings from an earlier revision for repair routing.
    // Clean merge permission still requires a final-head review under AGENTS.md.
    const codex = codexReviews.find(r => r.commit_id === sha);
    const botSummaries = comments.filter(c => c.user?.login === 'chatgpt-codex-connector[bot]')
      .map(c => ({ ...parseCodexReviewState(c.body, sha),
        at: c.updated_at || c.created_at,
        valid: Boolean(parseCodexReviewState(c.body, sha)) }))
      .filter(c => c.valid).sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0));
    const summary = botSummaries[0] || null;
    // A newer formal rejection/dismissal must override an earlier bot summary,
    // even if its findings are in a review body rather than an inline thread.
    const formalAt = Date.parse(codex?.submitted_at || '');
    const summaryAt = Date.parse(summary?.at || '');
    const useFormal = Boolean(codex) &&
      (!summary || !Number.isFinite(summaryAt) ||
       (Number.isFinite(formalAt) && formalAt >= summaryAt));
    const formalState = codex?.state === 'CHANGES_REQUESTED' ? 'findings' :
      codex?.state === 'APPROVED' ? 'clean' : 'pending';
    const latestState = useFormal ? formalState : summary?.state || 'pending';
    const reviewed = latestState !== 'pending' ? sha : null;
    // Historical unresolved threads remain an independent merge gate, but do
    // not override the newest authenticated Codex receipt for this head.
    const codexState = latestState;
    const unresolvedComments = codexState === 'findings'
      ? await this.unresolvedComments(pr.number).catch(()=>[]) : [];
    const trustedOwner = comments.filter(c=>c.author_association==='OWNER')
      .sort((a,b)=>Date.parse(b.created_at||0)-Date.parse(a.created_at||0))[0];
    return { pr_number: pr.number, head_sha: sha, base_branch: pr.base.ref,
      base_sha: pr.base.sha, base_current: comparison.behind_by === 0,
      acceptance_evidence: parseAcceptanceEvidence(pr.body),
      task_marker: parseTaskMarker(pr.body),
      github_owner_question: ownerDecision.question,
      owner_approved: ownerDecision.approved === true,
      github_owner_question_url: ownerDecision.url,
      coder_done: typeof pr.body === 'string' &&
        pr.body.includes('<!-- aicafe-coder-done -->'),
      latest_owner_comment: trustedOwner ? String(trustedOwner.body||'').slice(0,350) : null,
      latest_owner_comment_at: trustedOwner?.created_at || null,
      unresolved_codex_comments: unresolvedComments,
      ci_failure_job: ci === 'failure' ? (failingJob?.name || 'AI CAFE PR baseline') : null,
      ci_failure_url: ci === 'failure' ? (failingJob?.html_url || pr.html_url) : null,
      last_commit_at: commit.commit?.committer?.date || commit.commit?.author?.date || pr.updated_at,
      codex_review_at: useFormal ? codex?.submitted_at : summary?.at || null,
      branch: pr.head.ref, draft: pr.draft, last_github_activity: pr.updated_at,
      ci_state: ci, ci_failure_kind: baseline?.conclusion === 'startup_failure' ? 'startup_failure' : null,
      codex_state: codexState, codex_reviewed_sha: reviewed,
      threads_resolved: unresolved === 0,
      // GitHub's verified compare paths (not a PR marker) distinguish
      // dispatcher/AGENTS maintenance from unknown coding-task PRs.
      infrastructure_pr: isDispatcherMaintenanceChange(comparison.files),
      merged: false };
  }
  async snapshot() {
    const prs = await this.openPulls();
    // Read bounded batches to avoid hitting GitHub burst limits on busy public repositories.
    const output = [];
    for (let i = 0; i < prs.length; i += 4) {
      output.push(...await Promise.all(prs.slice(i, i + 4).map(pr => this.one(pr))));
    }
    return output;
  }
}
