import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQueue, dispatchFrontier, decideNudge, invalidateOnHeadChange, actionKey, mergeGate, reconcileGithub } from "./core.mjs";
import { emptyLedger, sanitizeLedger, GitHubLedger } from "./ledger.mjs";
import { GitHubFacts, parseAcceptanceEvidence } from "./github.mjs";

const task = (id, depends_on = [], state = "architecture_approved") => ({
  id, depends_on, state, acceptance: ["real proof"], brief: "docs/plans/brief.md",
  exclusive_files: [`scripts/owned-${id}.mjs`], architecture_approval: { approved: true },
});
const queue = (tasks) => ({ tasks, merged_code_only: [] });
const clock = Date.parse("2026-11-05T16:00:00Z");
const old = new Date(clock - 700000).toISOString();
const pr = (more = {}) => ({ task_id: "a", approved: true, conversation_ref: "private",
  pr_number: 101, head_sha: "abc", prompt_version: "v1",
  last_github_activity: old, last_commit_at: old, draft: false, ci_state: "success", codex_state: "clean", acceptance_evidence:{acceptance:[{id:'1'}]},
  codex_reviewed_sha: "abc", attempts: 0, ...more });

test("queue validates 32-task style DAG, rejects missing prerequisites and cycles", () => {
  assert.equal(validateQueue(queue([task("a"), task("b", ["a"])])).size, 2);
  assert.throws(() => validateQueue(queue([task("a", ["missing"])])), /Unknown prerequisite/);
  assert.throws(() => validateQueue(queue([task("a", ["b"]), task("b", ["a"])])), /cycle/i);
  assert.throws(() => validateQueue(queue([task("a"), task("a")])), /Duplicate/);
});
test("twelve events dispatch at most four ChatGPT and two Claude slots", () => {
  const all = queue(Array.from({ length: 12 }, (_, i) => task(`task${i}`)));
  const assigned = dispatchFrontier(all, {});
  assert.equal(assigned.length, 6);
  assert.deepEqual(assigned.map(x => x.agent), ["chatgpt", "chatgpt", "chatgpt", "chatgpt", "claude", "claude"]);
  assert.equal(assigned.every(x => x.base_branch === "main"), true);
  const records = Object.fromEntries(assigned.map(x => [x.task_id, { status: "assigned", agent: x.agent }]));
  assert.equal(dispatchFrontier(all, records).length, 0);
});
test("dependent branch is opened as stacked draft; unproven merged label cannot release", () => {
  const all = queue([task("a"), task("b", ["a"])]);
  const records = { a: { status: "draft_open", branch: "feat/a", pr_number: 100, agent: "chatgpt" } };
  const assigned = dispatchFrontier(all, records);
  assert.deepEqual(assigned, [{ type: "assign", task_id: "b", agent: "chatgpt", base_branch: "feat/a", prerequisite_pr: 100 }]);
  records.a.status = "merged";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), false);
  records.a.status = "integrated_proven";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), true);
});
test("pending CI/Codex, stale review or quiet interval blocks nudges", () => {
  assert.equal(decideNudge(pr({ ci_state: "pending" }), clock).kind, "hold");
  assert.equal(decideNudge(pr({ codex_state: "pending" }), clock).kind, "hold");
  assert.equal(decideNudge(pr({ codex_reviewed_sha: "old" }), clock).reason, "no_actionable_findings");
  assert.equal(decideNudge(pr({ last_commit_at: new Date(clock - 400000).toISOString() }), clock).reason, "not_quiet");
  assert.equal(decideNudge(pr(), clock).reason, "no_actionable_findings");
  assert.equal(decideNudge(pr({ ci_state: "failure" }), clock).action, "repair_ci");
  assert.equal(decideNudge(pr({ codex_state: "findings" }), clock).action, "repair_review");
  assert.equal(decideNudge(pr({ acceptance_evidence:null }), clock).action, "continue_pr");
  assert.equal(decideNudge(pr({ threads_resolved:false }), clock).action, "continue_pr");
});
test("pre-PR conversation cannot be nudged without known browser readiness", () => {
  const base = pr({ pr_number: null, last_submission_at: old, browser_busy: undefined });
  assert.equal(decideNudge(base, clock).reason, "not_quiet");
  assert.equal(decideNudge({ ...base, browser_busy: true }, clock).reason, "browser_confirmed_busy");
  assert.equal(decideNudge({ ...base, browser_busy: false }, clock).reason, "not_quiet");
  const ready = { ...base, browser_busy: false, last_submission_at: new Date(clock - 1900000).toISOString() };
  assert.equal(decideNudge(ready, clock).action, "pre_pr_reminder");
});
test("same state cannot be sent twice and uncertain submissions fail closed", () => {
  const record = pr({ci_state: "failure"});
  const choice = decideNudge(record, clock);
  assert.equal(choice.kind, "propose");
  assert.equal(decideNudge({ ...record, last_action_key: choice.key }, clock).kind, "hold");
  assert.equal(decideNudge({ ...record, submission_state: "uncertain" }, clock).kind, "hold");
  assert.equal(decideNudge({ ...record, submission_state: "needs_login" }, clock).kind, "hold");
  assert.notEqual(actionKey(record, "continue_pr"), actionKey({ ...record, head_sha: "new" }, "continue_pr"));
});
test("new commit invalidates stale checks and requires a fresh Codex review", () => {
  const changed = invalidateOnHeadChange(pr({ next_check_at: old, last_action_key: "old" }), "new", new Date(clock).toISOString());
  assert.equal(changed.head_sha, "new");
  assert.equal(changed.codex_state, "pending");
  assert.equal(changed.ci_state, "pending");
  assert.equal(changed.last_action_key, null);
  assert.equal(decideNudge(changed, clock).kind, "hold");
  assert.equal(invalidateOnHeadChange(pr({ submission_state: "uncertain" }), "new", old).submission_state, "uncertain");
});
test("merge requires final head, proven acceptance, branch and predecessors", () => {
  const ready = { ...pr(), threads_resolved: true, base_current: true, acceptance_proven: true };
  assert.equal(mergeGate(ready, [{ status: "integrated_proven" }]).eligible, true);
  assert.equal(mergeGate({ ...ready, base_current: false }).eligible, false);
  assert.deepEqual(mergeGate(ready, [{ status: "merged" }]).reasons, ["predecessor_not_proven"]);
  assert.equal(mergeGate({ ...ready, codex_reviewed_sha: null }).eligible, false);
});
test("ledger validates private-only state and rejects secret and response fields", () => {
  assert.deepEqual(sanitizeLedger(emptyLedger()).tasks, {});
  assert.throws(() => sanitizeLedger({ ...emptyLedger(), password: "bad" }), /Forbidden/);
  assert.throws(() => sanitizeLedger({ ...emptyLedger(), model_response: "bad" }), /Forbidden/);
});
test("ledger checks private visibility and retries optimistic CAS collisions", async () => {
  let put = 0;
  let state = { ...emptyLedger(), tasks: { a: { status: "assigned" } } };
  let sha = "old";
  const fetchFn = async (url, options) => {
    if (url.endsWith("/example/private")) return { ok: true, json: async () => ({ private: true }) };
    if (options.method === "PUT") {
      put++;
      if (put === 1) return { ok: false, status: 409 };
      state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
      sha = "new";
      return { ok: true, json: async () => ({ content: { sha } }) };
    }
    return { ok: true, json: async () => ({ sha, content: Buffer.from(JSON.stringify(state)).toString("base64") }) };
  };
  const ledger = new GitHubLedger({ repo: "example/private", token: "dummy", fetchFn });
  const result = await ledger.transaction(current => ({ ...current, tasks: { ...current.tasks, b: { status: "proposed" } } }));
  assert.equal(result.committed, true);
  assert.equal(put, 2);
  assert.equal(state.tasks.b.status, "proposed");
});
test("GitHub PR reads distinguish pending CI/review from success", async () => {
  const fetchFn = async (url, options) => {
    if (url.includes("/pulls?")) return { ok: true, json: async () => [{ number: 2, head: { sha: "abc", ref: "feat/b" }, base: { ref: "main", sha: "base" }, updated_at: old, draft: true }] };
    if (url.includes("check-runs")) return { ok: true, json: async () => ({ total_count: 1, check_runs: [{ name: "AI CAFE PR baseline", status: "completed", conclusion: "success" }] }) };
    if (url.includes("/reviews?")) return { ok: true, json: async () => [] };
    if (url.includes("/compare/")) return { ok: true, json: async () => ({ behind_by: 0 }) };
    if (url.includes("/commits/abc")) return { ok: true, json: async () => ({ commit: { committer: { date: old } } }) };
    if (url.includes("/graphql")) return { ok: true, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }) };
    throw new Error(url);
  };
  const facts = new GitHubFacts({ repo: "test/repo", token: "dummy", fetchFn });
  const entries = await facts.snapshot();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ci_state, "success");
  assert.equal(entries[0].codex_state, "pending");
});

test("concurrent head update cancels unsent old-head action and preserves receipts", () => {
  const ledger = { ...emptyLedger(), tasks: { a: { ...pr(), status: "draft_open" } },
    actions: { old: { task_id: "a", head_sha: "abc", status: "planned" },
      sent: { task_id: "a", head_sha: "abc", status: "uncertain" } } };
  const updated = reconcileGithub(ledger, [{ ...pr(), head_sha: "def", ci_state: "pending", codex_state: "pending", codex_reviewed_sha: null, branch: "feat/a" }]);
  assert.equal(updated.tasks.a.head_sha, "def");
  assert.equal(updated.tasks.a.ci_state, "pending");
  assert.equal(updated.actions.old.status, "cancelled_stale_head");
  assert.equal(updated.actions.sent.status, "uncertain");
});
test("disappearing PR is not automatically merged; verified merge remains distinct from integration", () => {
  const ledger = { ...emptyLedger(), tasks: { a: { ...pr(), status: "draft_open" } } };
  assert.equal(reconcileGithub(ledger, []).tasks.a.github_state, "not_open_unverified");
  const merged = reconcileGithub(ledger, [], { 101: true }).tasks.a;
  assert.equal(merged.status, "merged");
  const manual = reconcileGithub(ledger, [], {101:{merged:true,merge_sha:'squashed-main-sha'}}).tasks.a;
  assert.equal(manual.merge_sha,'squashed-main-sha');
  assert.equal(manual.status,'merged');
  assert.notEqual(merged.status, "integrated_proven");
  assert.equal(reconcileGithub(ledger, [], { 101: false }).tasks.a.status, "draft_open");
});

test("owner approval and exact nonoverlapping files are mandatory for dispatch", () => {
  const a = task("a"), b = task("b"), c = task("c");
  b.exclusive_files = [...a.exclusive_files];
  c.architecture_approval = { approved: false };
  assert.deepEqual(dispatchFrontier(queue([a, b, c]), {}).map(x => x.task_id), ["a"]);
  assert.deepEqual(dispatchFrontier(queue([b]), { a: { status: "draft_open", agent: "chatgpt" } }).map(x => x.task_id), ["b"]);
  assert.deepEqual(dispatchFrontier(queue([a]), { a: { status: "draft_open", agent: "chatgpt" } }), []);
  a.exclusive_files = ["scripts/**"];
  assert.deepEqual(dispatchFrontier(queue([a]), {}), []);
});

test("historical code merge must have integration proof before downstream starts", () => {
  const tasks = { tasks: [task("6", ["5"])], merged_code_only: [{ id: "5", pr: 378 }] };
  assert.equal(dispatchFrontier(tasks, { "5": { status: "merged" } }).length, 0);
  assert.deepEqual(dispatchFrontier(tasks, { "5": { status: "integrated_proven" } }).map(x => x.task_id), ["6"]);
});
test("failed private ledger PUT (including 404) cannot report successful persistence", async () => {
  const fake = async (url, options = {}) => {
    if (url.endsWith("/owner/private")) return { ok: true, json: async () => ({ private: true }) };
    if (options.method === "PUT") return { ok: false, status: 404 };
    return { ok: false, status: 404 };
  };
  const ledger = new GitHubLedger({ repo: "owner/private", token: "dummy", fetchFn: fake });
  await assert.rejects(ledger.transaction(s => ({ ...s, tasks: { a: { status: "assigned" } } })), /Ledger HTTP 404/);
});
test("CAS retries call reconciliation against newly loaded state each time", async () => {
  let puts = 0, calls = 0;
  const fake = async (url, options = {}) => {
    if (url.endsWith("/owner/private")) return { ok: true, json: async () => ({ private: true }) };
    if (options.method === "PUT") {
      puts++;
      if (puts === 1) return { ok: false, status: 409 };
      return { ok: true, json: async () => ({ content: { sha: "sha" } }) };
    }
    return { ok: true, json: async () => ({ sha: "sha", content: Buffer.from(JSON.stringify(emptyLedger())).toString("base64") }) };
  };
  const ledger = new GitHubLedger({ repo: "owner/private", token: "dummy", fetchFn: fake });
  await ledger.transaction(async state => { calls++; state.tasks.a = { status: "proposed", snapshot_version: calls }; return state; });
  assert.equal(puts, 2);
  assert.equal(calls, 2);
});

test("Claude receives only independent tasks and never routine nudges", () => {
  const all = queue([task("a"), task("b"), task("c"), task("d"), task("e", ["a"]), task("f")]);
  const assigned = dispatchFrontier(all, { a: { status: "integrated_proven" } }, { chatgpt: 0, claude: 2 });
  assert.equal(assigned.every(a => a.agent === "claude" && a.task_id !== "e"), true);
  assert.equal(decideNudge(pr({ agent: "claude" }), clock).reason, "claude_no_routine_nudges");
});
test("Codex findings wait ten minutes after review, not after PR comments", () => {
  const reviewed = new Date(clock - 400000).toISOString();
  const rec = pr({ codex_state: "findings", codex_review_at: reviewed, last_commit_at: old });
  assert.equal(decideNudge(rec, clock).reason, "not_quiet");
  assert.equal(decideNudge({ ...rec, codex_review_at: old }, clock).action, "repair_review");
});
test("merge gate rejects draft PR even with passing checks and evidence", () => {
  const ready = { ...pr(), threads_resolved: true, base_current: true, acceptance_proven: true };
  assert.equal(mergeGate({ ...ready, draft: true }).eligible, false);
});

test("PR acceptance metadata parses only bounded JSON",()=>{
 const body='Done\n<!-- aicafe-acceptance-evidence {"head_sha":"abc","acceptance":[{"id":"1"}]} -->';
 assert.equal(parseAcceptanceEvidence(body).head_sha,'abc');
 assert.equal(parseAcceptanceEvidence('<!-- aicafe-acceptance-evidence broken -->'),null);
 assert.equal(parseAcceptanceEvidence('not proof'),null);
});
