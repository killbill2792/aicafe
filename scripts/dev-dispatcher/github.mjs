// Read-only GitHub facts. Never checks out or runs untrusted PR code.
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
    if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
    return response.json();
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
  async one(pr) {
    const sha = pr.head.sha;
    const [checks, reviews, unresolved] = await Promise.all([
      this.request(`/commits/${sha}/check-runs?per_page=100`),
      this.request(`/pulls/${pr.number}/reviews?per_page=100`),
      this.unresolved(pr.number),
    ]);
    if (checks.total_count > 100 || reviews.length >= 100) throw new Error("PR review/check pagination not verified");
    const baseline = checks.check_runs.find(c => c.name === "AI CAFE PR baseline");
    const ci = !baseline || baseline.status !== "completed" ? "pending" :
      baseline.conclusion === "success" ? "success" : "failure";
    const codex = reviews.filter(r => /codex/i.test(r.user?.login || "") && r.commit_id === sha)
      .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0];
    const codexState = !codex ? "pending" : unresolved === null ? "unknown" :
      unresolved > 0 || codex.state === "CHANGES_REQUESTED" ? "findings" : "clean";
    return { pr_number: pr.number, head_sha: sha, base_branch: pr.base.ref,
      branch: pr.head.ref, draft: pr.draft, last_github_activity: pr.updated_at,
      ci_state: ci, codex_state: codexState, codex_reviewed_sha: codex?.commit_id || null,
      threads_resolved: unresolved === 0, merged: false };
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
