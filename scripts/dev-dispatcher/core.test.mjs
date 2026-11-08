import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateQueue, dispatchFrontier, decideNudge, invalidateOnHeadChange, actionKey, mergeGate, reconcileGithub, progressUpdatePolicy } from "./core.mjs";
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
  pr_number: 101, head_sha: "abc", base_branch:"main", prompt_version: "v1",
  last_github_activity: old, last_commit_at: old, draft: false, ci_state: "success", codex_state: "clean", acceptance_evidence:{acceptance:[{id:'1'}]},
  codex_reviewed_sha: "abc", attempts: 0, ...more });

test("queue validates 32-task style DAG, rejects missing prerequisites and cycles", () => {
  assert.equal(validateQueue(queue([task("a"), task("b", ["a"])])).size, 2);
  assert.throws(() => validateQueue(queue([task("a", ["missing"])])), /Unknown prerequisite/);
  assert.throws(() => validateQueue(queue([task("a", ["b"]), task("b", ["a"])])), /cycle/i);
  assert.throws(() => validateQueue(queue([task("a"), task("a")])), /Duplicate/);
});
test("twelve events dispatch at most five ChatGPT and two Claude slots", () => {
  const all = { ...queue(Array.from({ length: 12 }, (_, i) => task(`task${i}`))),
    capacity: { chatgpt: 5, claude: 2 } };
  const assigned = dispatchFrontier(all, {});
  assert.equal(assigned.length, 7);
  assert.deepEqual(assigned.map(x => x.agent),
    ["chatgpt", "chatgpt", "chatgpt", "chatgpt", "chatgpt", "claude", "claude"]);
  assert.equal(assigned.every(x => x.base_branch === "main"), true);
  const records = Object.fromEntries(assigned.map(x => [x.task_id, { status: "assigned", agent: x.agent }]));
  assert.equal(dispatchFrontier(all, records).length, 0);
  assert.deepEqual(dispatchFrontier({ ...all, capacity: { chatgpt: 2, claude: 0 } }, {})
    .map(a => a.agent), ["chatgpt", "chatgpt"]);
  assert.throws(() => dispatchFrontier({ ...all, capacity: { chatgpt: 6, claude: 2 } }, {}),
    /Invalid dispatcher capacity/);
});
test("unstarted owner-blocked PR6 does not occupy an active ChatGPT slot", () => {
  const all = { ...queue(Array.from({length:5}, (_,i)=>task(`a${i}`))),
    capacity:{chatgpt:5,claude:0} };
  const records = { "6": {status:"blocked_needs_owner",agent:"chatgpt",approved:false,priority_deferred:true} };
  assert.equal(dispatchFrontier(all, records).length,5);
  records["6"].conversation_ref = "https://chatgpt.com/c/existing";
  assert.equal(dispatchFrontier(all, records).length,4);
});
test("dependent branch is opened as stacked draft; unproven merged label cannot release", () => {
  const all = queue([task("a"), task("b", ["a"])]);
  const records = { a: { status: "draft_open", github_state: "open", branch: "feat/a", pr_number: 100, agent: "chatgpt" } };
  const assigned = dispatchFrontier(all, records);
  assert.deepEqual(assigned, [{ type: "assign", task_id: "b", agent: "chatgpt", base_branch: "feat/a", prerequisite_pr: 100 }]);
  records.a.status = "review_fixing";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), true);
  records.a.github_state = "not_open_unverified";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), false);
  records.a.github_state = "open";
  records.a.status = "merged";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), false);
  records.a.status = "integrated_proven";
  assert.equal(dispatchFrontier(all, records).some(a => a.task_id === "b"), true);
});
test("fan-in dependencies open a stacked draft on an explicit parent, but do not release merges", () => {
  const a=task("a"), b=task("b",["a"]), c=task("c",["a"]), d=task("d",["a"]);
  const e=task("e",["b","c","d"]);
  e.stack_base_task="d";
  const all=queue([a,b,c,d,e]);
  const records={
    a:{status:"integrated_proven"},
    b:{status:"review_fixing",github_state:"open",branch:"feat/b",pr_number:101,agent:"chatgpt"},
    c:{status:"draft_open",github_state:"open",branch:"feat/c",pr_number:102,agent:"chatgpt"},
    d:{status:"review_fixing",github_state:"open",branch:"feat/d",pr_number:103,agent:"chatgpt"},
  };
  assert.deepEqual(dispatchFrontier(all,records).map(x=>[x.task_id,x.base_branch,x.prerequisite_pr]),
    [["e","feat/d",103]]);
  // A real open ready PR is a valid stack parent; an assigned branch without a PR is not.
  const missingPr={...records,d:{...records.d,pr_number:null}};
  assert.deepEqual(dispatchFrontier(all,missingPr),[]);
  const closed={...records,d:{...records.d,github_state:"merged"}};
  assert.deepEqual(dispatchFrontier(all,closed),[]);
  const noBase={...all,tasks:all.tasks.map(t=>t.id==="e"?{...t,stack_base_task:null}:t)};
  assert.deepEqual(dispatchFrontier(noBase,records),[]);
  const bad={...all,tasks:all.tasks.map(t=>t.id==="e"?{...t,stack_base_task:"a"}:t)};
  assert.throws(()=>validateQueue(bad),/Invalid stack base/);
  // Existing merge gate never treats draft predecessors as proven.
  const blocked=mergeGate({task_id:"e",pr_number:104,approved:true,draft:false,ci_state:"success",
    codex_state:"clean",head_sha:"head",codex_reviewed_sha:"head",base_branch:"main",
    base_current:true,review_base_current:true,threads_resolved:true,acceptance_proven:true},
    [records.b,records.c,records.d]);
  assert.equal(blocked.eligible,false);
});
test("Toast architecture foundation requires owner-reviewed merged-main proof before downstream assignment", () => {
  const all = { ...queue([task("POS0a"), task("POS0b",["POS0a"]),
      task("POS0c",["POS0a"]), task("POS0d",["POS0a"])]),
    dispatch_rules: {
      architecture_foundation_proof_task:"POS0a",
      architecture_foundation_dependent_task_ids:["POS0b","POS0c","POS0d"],
      architecture_foundation_implementation_approval:{
        approved:false,merged_sha:null,owner_review_url:null} },
    capacity:{chatgpt:5,claude:0} };
  const draft = { POS0a:{status:"draft_open",branch:"feat/a",pr_number:395,agent:"chatgpt"} };
  assert.equal(dispatchFrontier(all,draft).length,0);
  assert.equal(dispatchFrontier(all,{POS0a:{status:"merged",pr_number:395}}).length,0);
  const mergedSha="a".repeat(40);
  const integrated={POS0a:{status:"integrated_proven",merge_sha:mergedSha}};
  // The audit's initial read-only approval cannot approve its resulting design.
  assert.deepEqual(dispatchFrontier(all,integrated),[]);
  const approved={...all,dispatch_rules:{...all.dispatch_rules,
    architecture_foundation_implementation_approval:{
      approved:true,merged_sha:mergedSha,
      owner_review_url:"https://github.com/killbill2792/aicafe/pull/395#issuecomment-123"}}};
  assert.deepEqual(dispatchFrontier(approved,integrated)
    .map(x=>[x.task_id,x.base_branch]),[
      ["POS0b","main"],["POS0c","main"],["POS0d","main"]]);
  // A review of any other source revision is not an approval of this merged architecture.
  assert.deepEqual(dispatchFrontier(approved,{POS0a:{status:"integrated_proven",merge_sha:"b".repeat(40)}}),[]);
  assert.throws(()=>validateQueue({...approved,dispatch_rules:{...approved.dispatch_rules,
    architecture_foundation_implementation_approval:{approved:true,merged_sha:mergedSha,owner_review_url:null}}}),
    /Invalid architecture foundation proof gate/);
  assert.throws(()=>validateQueue({ ...all,
    dispatch_rules:{...all.dispatch_rules,architecture_foundation_proof_task:"missing"} }),
    /Invalid architecture foundation proof gate/);
  assert.throws(()=>validateQueue({ ...all,
    dispatch_rules:{...all.dispatch_rules,architecture_foundation_dependent_task_ids:["unknown"]} }),
    /Invalid architecture foundation proof gate/);
});
test("priority proof gate blocks unrelated dispatch even when gate PR is draft or merged", () => {
  const all = {
    ...queue([task("audit"), task("collect", ["audit"]), task("proof", ["collect"]),
      task("worker", ["proof"]), task("unrelated")]),
    dispatch_rules: { priority_gate_task: "proof",
      priority_gate_allow_task_ids: ["audit", "collect", "proof"] },
  };
  const draft = { proof: { status: "draft_open", branch: "feat/proof", agent: "chatgpt" } };
  assert.deepEqual(dispatchFrontier(all, draft).map(x => x.task_id), ["audit"]);
  assert.equal(dispatchFrontier(all, { proof: { status: "merged" } }).some(x => x.task_id === "unrelated"), false);
  assert.equal(dispatchFrontier(all, { proof: { status: "assigned" } }).some(x => x.task_id === "worker"), false);
  const stacked = { ...draft, audit: { status: "draft_open", github_state: "open", branch: "feat/audit", pr_number: 123, agent: "chatgpt" } };
  assert.deepEqual(dispatchFrontier(all, stacked), [{
    type: "assign", task_id: "collect", agent: "chatgpt", base_branch: "feat/audit", prerequisite_pr: 123,
  }]);
  assert.deepEqual(dispatchFrontier(all, { proof: { status: "integrated_proven" } })
    .map(x => x.task_id), ["audit", "worker", "unrelated"]);
  assert.deepEqual(dispatchFrontier(all, { proof: { status: "released_proven" } })
    .map(x => x.task_id), ["audit", "worker", "unrelated"]);
  assert.throws(() => validateQueue({ ...all,
    dispatch_rules: { priority_gate_task: "typo", priority_gate_allow_task_ids: ["audit"] } }),
  /Invalid priority proof gate/);
  assert.throws(() => validateQueue({ ...all,
    dispatch_rules: { priority_gate_task: "proof", priority_gate_allow_task_ids: ["audit", "unknown"] } }),
  /Invalid priority proof gate/);
});

test("the actual Supervisor queue holds PR6 and other roots until POS0f proven", () => {
  const actual = JSON.parse(readFileSync(
    new URL("../../docs/plans/universal-supervisor-queue.json", import.meta.url), "utf8"));
  validateQueue(actual);
  assert.equal(actual.capacity.chatgpt, 5);
  // Owner-corrected sequence: repair the single reader first so new source families
  // cannot publish data that the existing Supervisor still cannot access.
  const reader = actual.tasks.find(t=>t.id==="POS0e");
  assert.deepEqual(reader.depends_on, ["POS0a"]);
  assert.equal(reader.stack_base_task, undefined);
  for (const id of ["POS0b","POS0c","POS0d"]) {
    const source = actual.tasks.find(t=>t.id===id);
    assert.ok(source.depends_on.includes("POS0e"), id);
    assert.equal(source.stack_base_task, "POS0e");
  }
  const release = actual.tasks.find(t=>t.id==="POS0f");
  assert.deepEqual(release.depends_on, ["POS0e","POS0b","POS0c","POS0d"]);
  assert.equal(release.stack_base_task, "POS0d");
  assert.equal(actual.dispatch_rules.pos_source_authority.mandatory_first_read, "AGENTS.md");
  assert.equal(actual.dispatch_rules.pos_source_authority.mandatory_pos_rule_second_read, "docs/rules/pos-data.md");
  assert.equal(actual.dispatch_rules.pos_source_authority.legacy_diagnostic_only.includes("toast_raw_samples"), true);
  const d4=actual.dispatch_rules.pos_d4_contract;
  assert.match(d4.architecture_approach,/D4A_APPROVED_B_change_driven/);
  assert.equal(d4.implementation_approved,false);
  assert.deepEqual(d4.must_preserve_merged_prs,[189,203,264,297]);
  assert.equal(d4.future_order_recovery.dispatchable,false);
  const identity=d4.order_guid_processing_metadata_approved;
  assert.match(identity.status,/OWNER_APPROVED_LOGICAL_ASSOCIATION/);
  assert.deepEqual(identity.source_identity,["authorized business_id","restaurant_guid","Toast order GUID"]);
  assert.deepEqual(identity.logical_stages,[
    "received","raw_saved","parsed_validated","canonical_promoted","metric_reconciled"
  ]);
  assert.equal(identity.no_status_column_or_table_claimed,true);
  assert.match(identity.normal_same_day_retry,/15-minute full business-day ordersBulk/);
  assert.match(identity.unwritten_or_missing_guid_fallback,/no saved-row status possible/);
  assert.ok(!actual.tasks.some(t=>t.id==="POS0-order-recovery"));
  assert.deepEqual(d4.future_order_recovery.owned_files_reserved,[]);
  assert.equal(d4.future_order_recovery.proposed_prerequisites.length,6);
  assert.match(d4.future_order_recovery.proposed_prerequisites[2],/competing editors/);
  assert.match(d4.future_order_recovery.file_scope_status,/no conflict-free exclusive ownership/);
  assert.match(d4.future_order_recovery.sql_scope_status,/owner approval pending/);
  assert.ok(!actual.tasks.some(t=>t.id==="POS0-order-recovery"));
  // Do not invalidate the active POS0a chat's signed approval hash just to
  // document the separately approved two audit-only files.
  assert.deepEqual(actual.tasks.find(t=>t.id==="POS0a").exclusive_files,[
    "docs/plans/toast-standard-api-coverage-matrix.md"
  ]);
  const extension=actual.dispatch_rules.pos0a_owner_approved_audit_scope_extension;
  assert.equal(extension.existing_saved_assignment_signature_must_not_be_invalidated,true);
  assert.deepEqual(extension.additional_paths,[
    "scripts/toast-standard-api-coverage.test.mjs",
    "docs/plans/toast-openapi-spec-snapshot.json"
  ]);
  assert.equal(extension.runtime_or_merge_approval,false);
  assert.equal(d4.independent_cost_queue_diagnostic.due_jobs,77);
  assert.equal(actual.dispatch_rules.architecture_foundation_proof_task,"POS0a");
  assert.equal(actual.dispatch_rules.architecture_foundation_implementation_approval.approved,false);
  assert.deepEqual(actual.dispatch_rules.architecture_foundation_dependent_task_ids,
    ["POS0b","POS0c","POS0d","POS0e","POS0f"]);
  assert.equal(actual.dispatch_rules.priority_gate_task, "POS0f");
  assert.equal(actual.initial_parallel_candidates[0], "POS0a");
  for (const id of ["E2", "6", "9", "10"]) {
    assert.ok(actual.tasks.find(t => t.id === id)?.depends_on.includes("POS0f"), id);
  }
  const original = actual.tasks.find(t => t.id === "6");
  const pretendApproved = { ...actual, tasks: actual.tasks.map(t => t.id === "6" ?
    { ...original, exclusive_files: ["scripts/fake-worker.mjs"] } : t) };
  const records = { "5": { status: "integrated_proven" },
    POS0f: { status: "draft_open", branch: "feat/pos0f", pr_number: 999, agent: "chatgpt" } };
  assert.equal(dispatchFrontier(pretendApproved, records).some(x => x.task_id === "6"), false);
  records.POS0f = { status: "integrated_proven" };
  assert.equal(dispatchFrontier(pretendApproved, records).some(x => x.task_id === "6"), true);
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
test("draft PR gets same-chat continuation after ten quiet minutes even if Codex is not ready", () => {
  const pending = pr({draft:true,ci_state:"pending",codex_state:"pending",
    acceptance_evidence:null});
  assert.equal(decideNudge(pending,clock).action,"continue_pr");
  assert.equal(decideNudge({...pending,codex_state:"unknown"},clock).action,"continue_pr");
  assert.equal(decideNudge({...pending,ci_state:"unknown"},clock).action,"continue_pr");
  assert.equal(decideNudge({...pending,last_commit_at:new Date(clock-590000).toISOString()},clock).reason,"not_quiet");
  assert.equal(decideNudge({...pending,owner_question:"Approve exact source mapping?"},clock).reason,"owner_decision_required");
  assert.equal(decideNudge({...pending,submission_state:"uncertain"},clock).reason,"uncertain");
  assert.equal(decideNudge({...pending,conversation_ref:null},clock).reason,"unapproved_or_missing_chat");
  const earlyClean=pr({draft:true,ci_state:"success",codex_state:"clean",
    acceptance_evidence:{acceptance:[{id:"1"}]}});
  assert.equal(decideNudge(earlyClean,clock).action,"continue_pr");
  const picked=decideNudge(pending,clock);
  assert.equal(decideNudge({...pending,last_action_key:picked.key},clock).reason,"already_sent_or_capped");
  assert.equal(decideNudge({...pending,agent:"claude"},clock).reason,"claude_no_routine_nudges");
});
test("only a dedicated coordinator PR can change the shared progress checklist",()=>{
 assert.equal(progressUpdatePolicy(["lib/a.ts","docs/b.md"]).allowed,true);
 assert.equal(progressUpdatePolicy(["PROGRESS.md"]).allowed,true);
 assert.deepEqual(progressUpdatePolicy(["PROGRESS.md","lib/a.ts"]),{
  allowed:false,reason:"progress_requires_dedicated_coordination_change"});
 assert.equal(progressUpdatePolicy(["docs/other.md","PROGRESS.md"]).allowed,false);
 assert.equal(progressUpdatePolicy(null).allowed,false);
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
  assert.deepEqual(mergeGate({ ...ready, base_branch: "feat/predecessor" }).reasons, ["non_main_destination"]);
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

test('owner question blocks nudges and retains exclusive-file ownership',()=>{
 const blocked={...pr(),owner_question:'Which files are authorized?',status:'blocked_needs_owner',agent:'chatgpt'};
 assert.equal(decideNudge(blocked,clock).reason,'owner_decision_required');
 const a=task('a'),b=task('b');
 b.exclusive_files=[...a.exclusive_files];
 // An already-started coding chat with an owner question still retains its file lock.
 const assigned=dispatchFrontier(queue([a,b]),{a:{status:'blocked_needs_owner',agent:'chatgpt',conversation_ref:'https://chatgpt.com/c/existing'}});
 assert.equal(assigned.some(item=>item.task_id==='b'),false);
 const state={...emptyLedger(),tasks:{a:blocked}};
 const prInfo={...blocked,pr_number:101,head_sha:'abc',github_owner_question:'Decision requested',draft:false};
 assert.equal(reconcileGithub(state,[prInfo]).tasks.a.status,'blocked_needs_owner');
});

test('base SHA changes invalidate merge review until a later relevant review',()=>{
 const old='2026-11-05T12:00:00Z',later='2026-11-05T13:00:00Z';
 const before={...pr(),base_sha:'old-base',status:'review_fixing'};
 const state={...emptyLedger(),tasks:{a:before}};
 const next={...before,base_sha:'new-base',base_current:true,
   last_github_activity:old,codex_review_at:'2026-11-05T11:00:00Z'};
 const changed=reconcileGithub(state,[next],{},old).tasks.a;
 assert.equal(changed.review_base_current,false);
 assert.equal(mergeGate({...changed,acceptance_proven:true,threads_resolved:true}).eligible,false);
 assert.equal(decideNudge({...changed,last_commit_at:'2026-11-05T11:00:00Z'},Date.parse(later)).action,'continue_pr');
 const refreshed=reconcileGithub({...emptyLedger(),tasks:{a:changed}},
   [{...next,codex_review_at:later}]).tasks.a;
 assert.equal(refreshed.review_base_current,true);
});

test('dismissed Codex review cannot be treated as clean on current head',async()=>{
 const basePr={number:52,head:{sha:'abc',ref:'feat/approved'},base:{ref:'main',sha:'base'},updated_at:old,draft:false,body:''};
 const review={user:{login:'codex[bot]'},commit_id:'abc',state:'DISMISSED',submitted_at:old};
 const fake=async url=>{
  if(url.includes('/pulls?'))return {ok:true,json:async()=>[basePr]};
  if(url.includes('check-runs'))return {ok:true,json:async()=>({total_count:1,check_runs:[{name:'AI CAFE PR baseline',status:'completed',conclusion:'success'}]})};
  if(url.includes('/reviews?'))return {ok:true,json:async()=>[review]};
  if(url.includes('/compare/'))return {ok:true,json:async()=>({behind_by:0})};
  if(url.includes('/commits/abc'))return {ok:true,json:async()=>({commit:{committer:{date:old}}})};
  if(url.includes('/graphql'))return {ok:true,json:async()=>({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}}}}})};
  throw Error(url);
 };
 const [result]=await new GitHubFacts({repo:'owner/aicafe',token:'example',fetchFn:fake}).snapshot();
 assert.equal(result.codex_state,'pending');
});
