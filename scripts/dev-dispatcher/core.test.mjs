import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateQueue, dispatchFrontier, decideNudge, invalidateOnHeadChange, actionKey, mergeGate, readyGate, reconcileGithub, progressUpdatePolicy, predecessorsForMerge, overlappingPredecessorIds } from "./core.mjs";
import { emptyLedger, sanitizeLedger, GitHubLedger } from "./ledger.mjs";
import { GitHubFacts, parseAcceptanceEvidence, parseCodexReviewState } from "./github.mjs";
import { linkPullRequests } from "./dependencies.mjs";

const task = (id, depends_on = [], state = "architecture_approved") => ({
  id, depends_on, state, acceptance: ["real proof"], brief: "docs/plans/brief.md",
  exclusive_files: [`scripts/owned-${id}.mjs`], architecture_approval: { approved: true },
});
const queue = (tasks) => ({ tasks, merged_code_only: [] });
const clock = Date.parse("2026-11-05T16:00:00Z");
const old = new Date(clock - 700000).toISOString();
const pr = (more = {}) => ({ task_id: "a", approved: true, conversation_ref: "private",
  pr_number: 101, head_sha: "abc", base_branch:"main", prompt_version: "v1",
  last_github_activity: old, last_commit_at: old, draft: false, ci_state: "success", codex_state: "clean", acceptance_proven:true, acceptance_evidence:{acceptance:[{id:'1'}]},
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
  const all = { ...queue([{...task("POS0a"),test_kinds:["docs","read_only_audit"]}, task("POS0b",["POS0a"]),
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
  const ownerMergedDocs = {POS0a:{status:"merged",merge_sha:mergedSha}};
  assert.deepEqual(dispatchFrontier(approved,ownerMergedDocs)
    .map(x=>[x.task_id,x.base_branch]),[
      ["POS0b","main"],["POS0c","main"],["POS0d","main"]]);
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
  assert.equal(d4.future_order_recovery.proposed_prerequisites.length,7);
  assert.match(d4.future_order_recovery.proposed_prerequisites[6],/logical caf.*order|café\+restaurant\+Toast GUID/i);
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
  const d4c=d4.menu_publication_lifecycle_approved;
  assert.equal(d4c.status,"OWNER_APPROVED_BEHAVIOR_NOT_RUNTIME_IMPLEMENTATION");
  assert.equal(d4c.implementation_approved,false);
  assert.equal(d4c.future_owner,"POS0d");
  assert.equal(d4c.unchanged_version_full_menu_gets,0);
  assert.equal(d4c.auto_hard_delete,false);
  assert.match(d4c.verified_unpublish,/inactive/);
  assert.match(d4c.republish_same_guid,/reactivate/);
  assert.ok(d4c.unverified_snapshots_never_deactivate.includes("missing reference"));
  assert.equal(actual.tasks.find(t=>t.id==="POS0d").architecture_approval?.approved,true);
  assert.ok(actual.tasks.find(t=>t.id==="POS0d").acceptance.some(a=>a.includes("same GUID")));
  assert.equal(d4.independent_cost_queue_diagnostic.due_jobs,77);
  assert.equal(actual.dispatch_rules.architecture_foundation_proof_task,"POS0a");
  assert.equal(actual.dispatch_rules.architecture_foundation_implementation_approval.approved,true);
  assert.equal(actual.dispatch_rules.architecture_foundation_implementation_approval.merged_sha,
    "90e06ca57809ef0c29084d459d82a1be266b503a");
  const owners=new Map();
  for (const id of ["POS0e","POS0b","POS0c","POS0d","POS0f"]) {
    const t=actual.tasks.find(x=>x.id===id);
    assert.equal(t.architecture_approval?.approved,true,id);
    assert.equal(t.state,"architecture_approved",id);
    assert.ok(t.exclusive_files.length>=15,id);
    for (const path of t.exclusive_files) {
      assert.equal(owners.has(path),false,id+" overlaps "+owners.get(path)+": "+path);
      owners.set(path,id);
    }
  }
  assert.ok(owners.has("supabase/migrations/20261109000156_pos0e_shared_current_reader.sql"));
  // Shared source edits are legal in separate PR branches. Their verified
  // integration order, not early coding eligibility, protects main.
  assert.ok(validateQueue({...actual,tasks:actual.tasks.map(t=>t.id==="POS0c"
    ?{...t,exclusive_files:[...t.exclusive_files,"lib/pos/toast/redact.ts"]}:t)}));
  const docsMerged={POS0a:{status:"merged",merge_sha:"90e06ca57809ef0c29084d459d82a1be266b503a"}};
  assert.deepEqual(dispatchFrontier(actual,docsMerged).map(x=>x.task_id),["POS0e"]);
  const eOpen={...docsMerged,POS0e:{status:"draft_open",github_state:"open",
    pr_number:450,branch:"feat/aicafe-task-POS0e",agent:"chatgpt"}};
  assert.deepEqual(dispatchFrontier(actual,eOpen).map(x=>[x.task_id,x.agent,x.base_branch,x.prerequisite_pr]),[
    ["POS0b","chatgpt","feat/aicafe-task-POS0e",450],
    ["POS0c","chatgpt","feat/aicafe-task-POS0e",450],
    ["POS0d","chatgpt","feat/aicafe-task-POS0e",450]]);
  assert.equal(dispatchFrontier(actual,eOpen).some(x=>x.task_id==="POS0f"),false);
  const bcdOpen={...eOpen};
  for (const [id,n] of [["POS0b",451],["POS0c",452],["POS0d",453]])
    bcdOpen[id]={status:"draft_open",github_state:"open",
      pr_number:n,branch:"feat/aicafe-task-"+id,agent:"chatgpt"};
  assert.deepEqual(dispatchFrontier(actual,bcdOpen).filter(x=>x.task_id==="POS0f"),
    [{type:"assign",task_id:"POS0f",agent:"chatgpt",
      base_branch:"feat/aicafe-task-POS0d",prerequisite_pr:453}]);
  assert.equal(dispatchFrontier(actual,bcdOpen).some(x=>x.task_id==="6"),false);
  assert.deepEqual(actual.dispatch_rules.architecture_foundation_dependent_task_ids,
    ["POS0b","POS0c","POS0d","POS0e","POS0f"]);
  assert.equal(actual.dispatch_rules.priority_gate_task, "POS0f");
  assert.equal(actual.initial_parallel_candidates[0], "POS0e");
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

test("only a dedicated coordinator PR can change the shared progress checklist",()=>{
 assert.equal(progressUpdatePolicy(["lib/a.ts","docs/b.md"]).allowed,true);
 assert.equal(progressUpdatePolicy(["PROGRESS.md"]).allowed,true);
 assert.deepEqual(progressUpdatePolicy(["PROGRESS.md","lib/a.ts"]),{
  allowed:false,reason:"progress_requires_dedicated_coordination_change"});
 assert.equal(progressUpdatePolicy(["docs/other.md","PROGRESS.md"]).allowed,false);
 assert.equal(progressUpdatePolicy(null).allowed,false);
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
test("ledger validates private-only state and rejects secret and response fields", () => {
  assert.deepEqual(sanitizeLedger(emptyLedger()).tasks, {});
  assert.throws(() => sanitizeLedger({ ...emptyLedger(), password: "bad" }), /Forbidden/);
  assert.throws(() => sanitizeLedger({ ...emptyLedger(), model_response: "bad" }), /Forbidden/);
});
test("ledger checks private visibility and retries optimistic CAS collisions", async () => {
  let put = 0;
  let state = { ...emptyLedger(), tasks: { a: { status: "assigned" } } };
  let sha = "a".repeat(40);
  const fetchFn = async (url, options) => {
    if (url.endsWith("/example/private")) return { ok: true, json: async () => ({ private: true }) };
    if (options.method === "PUT") {
      put++;
      if (put === 1) return { ok: false, status: 409 };
      state = JSON.parse(Buffer.from(JSON.parse(options.body).content, "base64").toString("utf8"));
      sha = "b".repeat(40);
      return { ok: true, json: async () => ({ content: { sha } }) };
    }
    if(url.includes('/git/trees/main'))return {ok:true,json:async()=>({
      truncated:false,tree:[{path:'dispatcher/state.json',type:'blob',sha}]})};
    if(url.includes('/git/blobs/'))return {ok:true,json:async()=>({
      encoding:'base64',content:Buffer.from(JSON.stringify(state)).toString('base64')})};
    throw Error('Unexpected mock API path '+url);
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
    if (url.includes("/issues/2/comments?")) return { ok: true, json: async () => [] };
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

test("owner approval and exact authorized files remain mandatory while shared writes are parallel", () => {
  const a = task("a"), b = task("b"), c = task("c");
  b.exclusive_files = [...a.exclusive_files];
  c.architecture_approval = { approved: false };
  assert.deepEqual(dispatchFrontier(queue([a,b,c]),{}).map(x=>x.task_id),["a","b"]);
  assert.deepEqual(overlappingPredecessorIds(b,queue([a,b,c])),["a"]);
  b.exclusive_files = ["scripts/owned-b.mjs"];
  assert.deepEqual(dispatchFrontier(queue([a,b,c]),{}).map(x=>x.task_id),["a","b"]);
  assert.deepEqual(dispatchFrontier(queue([b]),{a:{status:"draft_open",agent:"chatgpt"}}).map(x=>x.task_id),["b"]);
  assert.deepEqual(dispatchFrontier(queue([a]),{a:{status:"draft_open",agent:"chatgpt"}}),[]);
  a.exclusive_files = ["scripts/**"];
  assert.throws(()=>dispatchFrontier(queue([a]),{}),/Invalid exclusive file ownership/);
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
    if (url.includes('/git/trees/main'))return {ok:true,json:async()=>({
      truncated:false,tree:[]})};
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
    if(url.includes('/git/trees/main'))return {ok:true,json:async()=>({
      truncated:false,tree:[{path:'dispatcher/state.json',type:'blob',sha:'a'.repeat(40)}]})};
    if(url.includes('/git/blobs/'))return {ok:true,json:async()=>({
      encoding:'base64',content:Buffer.from(JSON.stringify(emptyLedger())).toString('base64')})};
    throw Error('Unexpected mock API path '+url);
  };
  const ledger = new GitHubLedger({ repo: "owner/private", token: "dummy", fetchFn: fake });
  await ledger.transaction(async state => { calls++; state.tasks.a = { status: "proposed", snapshot_version: calls }; return state; });
  assert.equal(puts, 2);
  assert.equal(calls, 2);
});

test("PR acceptance metadata parses only bounded JSON",()=>{
 const body='Done\n<!-- aicafe-acceptance-evidence {"head_sha":"abc","acceptance":[{"id":"1"}]} -->';
 assert.equal(parseAcceptanceEvidence(body).head_sha,'abc');
 assert.equal(parseAcceptanceEvidence('<!-- aicafe-acceptance-evidence broken -->'),null);
 assert.equal(parseAcceptanceEvidence('not proof'),null);
});

test('dismissed Codex review cannot be treated as clean on current head',async()=>{
 const basePr={number:52,head:{sha:'abc',ref:'feat/approved'},base:{ref:'main',sha:'base'},updated_at:old,draft:false,body:''};
 const review={user:{login:'codex[bot]'},commit_id:'abc',state:'DISMISSED',submitted_at:old};
 const fake=async url=>{
  if(url.includes('/pulls?'))return {ok:true,json:async()=>[basePr]};
  if(url.includes('check-runs'))return {ok:true,json:async()=>({total_count:1,check_runs:[{name:'AI CAFE PR baseline',status:'completed',conclusion:'success'}]})};
  if(url.includes('/reviews?'))return {ok:true,json:async()=>[review]};
  if(url.includes('/compare/'))return {ok:true,json:async()=>({behind_by:0})};
  if(url.includes('/issues/52/comments?'))return {ok:true,json:async()=>[]};
  if(url.includes('/commits/abc'))return {ok:true,json:async()=>({commit:{committer:{date:old}}})};
  if(url.includes('/graphql'))return {ok:true,json:async()=>({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}}}}})};
  throw Error(url);
 };
 const [result]=await new GitHubFacts({repo:'owner/aicafe',token:'example',fetchFn:fake}).snapshot();
 assert.equal(result.codex_state,'pending');
});

test('owner question in trusted PR comment is published even when PR body has no marker',async()=>{
 const pr={number:404,body:'No question in description',html_url:'https://github.com/o/r/pull/404',
   labels:[{name:'needs-owner-decision'}]};
 const seen=[];
 const facts=new GitHubFacts({repo:'o/r',token:'fake',fetchFn:async url=>{
   seen.push(url);
   return {ok:true,json:async()=>[
     {author_association:'NONE',body:'<!-- aicafe-owner-question Fake approval? -->'},
     {author_association:'OWNER',body:'<!-- aicafe-owner-question May two tests be edited? -->',
       html_url:'https://github.com/o/r/pull/404#issuecomment-17'}]};
 }});
 const result=await facts.ownerDecision(pr);
 assert.equal(result.question,'May two tests be edited?');
 assert.equal(result.url,'https://github.com/o/r/pull/404#issuecomment-17');
 assert.equal(seen.length,1);
 const noticeState={tasks:{POS0e:{agent:'chatgpt',pr_number:404,
   github_owner_question:result.question,github_owner_question_url:result.url}},actions:{}};
 const {queueOwnerAlerts}=await import('./alerts.mjs');
 const notice=Object.values(queueOwnerAlerts(noticeState).owner_alerts)[0];
 assert.match(notice.question,/May two tests be edited\?/);
 assert.match(notice.question,/issuecomment-17/);
});

test('unstructured owner-decision label is blocking; ordinary PRs add no comments API call',async()=>{
 const pr={number:405,body:'No marker',html_url:'https://github.com/o/r/pull/405',
   labels:[{name:'needs-owner-decision'}]};
 const facts=new GitHubFacts({repo:'o/r',token:'fake',fetchFn:async()=>({
   ok:true,json:async()=>[]})});
 assert.match((await facts.ownerDecision(pr)).question,/Owner decision requested/);
 assert.deepEqual(await facts.ownerDecision({...pr,labels:[]}),{question:null,url:null,approved:false});
});

test('Codex connector summary is accepted only for exact current head and strict shape',()=>{
 const head='b'.repeat(40);
 const summary='<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+
  JSON.stringify({code_review:{commit_sha:head,status:'completed',
    has_any_findings:false,has_unresolved_findings:false}})+' -->';
 assert.deepEqual(parseCodexReviewState(summary,head),{state:'clean',sha:head});
 assert.equal(parseCodexReviewState(summary,'c'.repeat(40)),null);
 assert.equal(parseCodexReviewState('Codex Review: Didn\'t find any major issues '+head.slice(0,10),head),null);
 const flagged=summary.replace('has_any_findings":false','has_any_findings":true');
 assert.equal(parseCodexReviewState(flagged,head).state,'findings');
 const running=summary.replace('"status":"completed"','"status":"running"')
   .replace('"has_any_findings":false','"has_any_findings":null')
   .replace('"has_unresolved_findings":false','"has_unresolved_findings":null');
 assert.equal(parseCodexReviewState(running,head).state,'pending');
});

test('GitHub current-head Codex summary changes clean vs pending but unresolved threads still block',async()=>{
 const sha='c'.repeat(40),now='2026-11-09T21:10:00Z';
 const body='<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 '+
   JSON.stringify({code_review:{commit_sha:sha,status:'completed',
     has_any_findings:false,has_unresolved_findings:false}})+' -->';
 const pr={number:407,head:{sha,ref:'feat/menu'},base:{sha:'d'.repeat(40),ref:'main'},
   labels:[],body:'',draft:true,updated_at:now};
 const makeFacts=(unresolved=false,user='chatgpt-codex-connector[bot]')=>
  new GitHubFacts({repo:'o/r',token:'dummy',fetchFn:async(url)=>{
  let data;
  if(url.includes('/check-runs?'))data={total_count:0,check_runs:[]};
  else if(url.includes('/reviews?'))data=[];
  else if(url.includes('/comments?'))data=[{user:{login:user},body,updated_at:now}];
  else if(url.includes('/commits/'+sha))data={commit:{committer:{date:now}}};
  else if(url.includes('/compare/'))data={behind_by:0,files:[{filename:'src/menu.ts'}]};
  else if(url.endsWith('/graphql'))data={data:{repository:{pullRequest:{reviewThreads:{
    pageInfo:{hasNextPage:false},nodes:unresolved?[{isResolved:false}]:[]}}}}};
  else throw Error(url);
  return {ok:true,json:async()=>data};
 }});
 const clean=await makeFacts().one(pr);
 assert.equal(clean.codex_state,'clean');
 assert.equal(clean.codex_reviewed_sha,sha);
 assert.equal(clean.codex_review_at,now);
 const oldThread=await makeFacts(true).one(pr);
  assert.equal(oldThread.codex_state,'clean');
  assert.equal(oldThread.threads_resolved,false);
 assert.equal((await makeFacts(false,'untrusted-user').one(pr)).codex_state,'pending');
});
test('Dispatcher-only PR is not a mystery task while mixed PR remains unmapped',()=>{
 const state={tasks:{POS0e:{pr_number:404,branch:'feat/e'}}};
 const tasks=[{pr_number:404,branch:'feat/e',draft:true,base_branch:'main'},
   {pr_number:413,branch:'fix/dev',infrastructure_pr:true},
   {pr_number:414,branch:'feat/mixed',infrastructure_pr:false}];
 assert.deepEqual(linkPullRequests(state,tasks).unmapped,[414]);
});

test('a newly running Codex summary never reuses an earlier same-head clean review',async()=>{
 const sha='f'.repeat(40),now='2026-11-09T21:40:00Z';
 const body='<!-- codex-pull-request-review-summary -->\\n<!-- codex-review-state:v1 '+
  JSON.stringify({code_review:{commit_sha:sha,status:'running',
   has_any_findings:null,has_unresolved_findings:null}})+' -->';
 const pr={number:81,head:{sha,ref:'feat/test'},base:{sha:'d'.repeat(40),ref:'main'},
   labels:[],body:'',draft:true,updated_at:now};
 const facts=new GitHubFacts({repo:'o/r',token:'dummy',fetchFn:async url=>{
  let data;
  if(url.includes('/check-runs?'))data={total_count:0,check_runs:[]};
  else if(url.includes('/reviews?'))data=[{user:{login:'codex[bot]'},commit_id:sha,
    state:'COMMENTED',submitted_at:'2026-11-09T21:10:00Z'}];
  else if(url.includes('/comments?'))data=[{user:{login:'chatgpt-codex-connector[bot]'},body,updated_at:now}];
  else if(url.includes('/commits/'+sha))data={commit:{committer:{date:now}}};
  else if(url.includes('/compare/'))data={behind_by:0,files:[{filename:'src/code.ts'}]};
  else if(url.endsWith('/graphql'))data={data:{repository:{pullRequest:{reviewThreads:{
    pageInfo:{hasNextPage:false},nodes:[]}}}}};
  else throw Error(url);
  return {ok:true,json:async()=>data};
 }});
 const result=await facts.one(pr);
 assert.equal(result.codex_state,'pending');
 assert.equal(result.codex_reviewed_sha,null);
});

test('newer current-head Codex rejection outranks older clean bot summary, even without inline findings',async()=>{
 const sha='e'.repeat(40),now='2026-11-09T22:00:00Z';
 const summary='<!-- codex-pull-request-review-summary -->\\n<!-- codex-review-state:v1 '+
  JSON.stringify({code_review:{commit_sha:sha,status:'completed',
   has_any_findings:false,has_unresolved_findings:false}})+' -->';
 const pr={number:82,head:{sha,ref:'feat/code'},base:{sha:'d'.repeat(40),ref:'main'},
   labels:[],body:'',draft:true,updated_at:now};
 const facts=new GitHubFacts({repo:'o/r',token:'dummy',fetchFn:async url=>{
  let data;
  if(url.includes('/check-runs?'))data={total_count:0,check_runs:[]};
  else if(url.includes('/reviews?'))data=[{user:{login:'codex[bot]'},commit_id:sha,
    state:'CHANGES_REQUESTED',submitted_at:now,body:'Block on P1 risk'}];
  else if(url.includes('/comments?'))data=[{user:{login:'chatgpt-codex-connector[bot]'},
    body:summary,updated_at:'2026-11-09T21:00:00Z'}];
  else if(url.includes('/commits/'+sha))data={commit:{committer:{date:now}}};
  else if(url.includes('/compare/'))data={behind_by:0,files:[{filename:'src/code.ts'}]};
  else if(url.endsWith('/graphql'))data={data:{repository:{pullRequest:{reviewThreads:{
    pageInfo:{hasNextPage:false},nodes:[]}}}}};
  else throw Error(url);
  return {ok:true,json:async()=>data};
 }});
 const result=await facts.one(pr);
 assert.equal(result.codex_state,'findings');
 assert.equal(result.codex_reviewed_sha,sha);
 assert.equal(result.codex_review_at,now);
});

test('six-condition merge gate uses merged order, not coder_done, acceptance or integration',()=>{
  const candidate={pr_number:40,head_sha:'a'.repeat(40),draft:false,ci_state:'success',
    codex_state:'clean',codex_reviewed_sha:'a'.repeat(40),threads_resolved:true,
    mergeable:true,owner_question:'routine question',github_owner_question:'routine question',
    coder_done:false,acceptance_proven:false};
  assert.equal(mergeGate(candidate,[{status:'merged',merge_sha:'b'.repeat(40)}]).eligible,true);
  assert.equal(mergeGate(candidate,[{status:'integrated_proven',merge_sha:'b'.repeat(40)}]).eligible,true);
  assert.deepEqual(mergeGate(candidate,[{status:'draft_open'}]).reasons,['predecessor_not_merged']);
  assert.deepEqual(mergeGate({...candidate,sensitive_owner_block:true},[]).reasons,
    ['sensitive_owner_approval_required']);
  for (const [patch,reason] of [
    [{draft:true},'not_ready_for_review'],[{ci_state:'pending'},'ci_not_green'],
    [{codex_state:'findings'},'codex_review_missing_or_findings'],
    [{codex_reviewed_sha:'c'.repeat(40)},'codex_review_missing_or_findings'],
    [{threads_resolved:false},'unresolved_threads'],[{mergeable:false},'not_mergeable']]) {
    assert.ok(mergeGate({...candidate,...patch},[]).reasons.includes(reason));
  }
});
test('green draft becomes ready without coder-done, acceptance, review or integration proof',()=>{
  const rec={pr_number:77,head_sha:'c'.repeat(40),draft:true,ci_state:'success',
    coder_done:false,acceptance_proven:false,codex_state:'pending',owner_question:'routine'};
  assert.equal(readyGate(rec).eligible,true);
  assert.equal(readyGate({...rec,ci_state:'failure'}).eligible,false);
  assert.equal(readyGate({...rec,sensitive_owner_block:true}).eligible,false);
});
test('only actionable failures, findings and conflicts generate state-keyed coder prompts',()=>{
  const base={task_id:'T',approved:true,agent:'chatgpt',github_state:'open',
    conversation_ref:'https://chatgpt.com/c/abc-123',pr_number:9,
    head_sha:'a'.repeat(40),ci_state:'success',codex_state:'clean'};
  assert.equal(decideNudge(base,Date.now()).kind,'hold');
  assert.equal(decideNudge({...base,parent_merged_sha:'b'.repeat(40)},Date.now()).kind,'hold');
  assert.equal(decideNudge({...base,owner_answer_text:'Owner approved'},Date.now()).kind,'hold');
  const failed=decideNudge({...base,ci_state:'failure',ci_failure_job:'lint'},Date.now());
  assert.equal(failed.action,'ci_failed');
  assert.notEqual(failed.key,decideNudge({...base,ci_state:'failure',ci_failure_job:'build'},Date.now()).key);
  assert.equal(decideNudge({...base,codex_state:'findings'},Date.now()).action,'codex_comments');
  assert.equal(decideNudge({...base,mergeable:false},Date.now()).action,'repair_conflict');
  assert.equal(decideNudge({...base,ci_state:'failure',last_action_key:failed.key,
    submission_state:'submitted',ci_failure_job:'lint'},Date.now()).kind,'hold');
  assert.equal(decideNudge({...base,ci_state:'failure',submission_state:'uncertain'},Date.now()).kind,'hold');
});


test('independent shared-file tasks code in parallel but cannot merge out of order',()=>{
 const a={...task('a'),exclusive_files:['lib/shared.ts']};
 const b={...task('b'),exclusive_files:['lib/shared.ts']};
 const c={...task('c'),exclusive_files:['lib/unrelated.ts']};
 const q=queue([a,b,c]);
 assert.equal(validateQueue(q).size,3);
 assert.deepEqual(dispatchFrontier(q,{}, {chatgpt:3,claude:0}).map(x=>x.task_id),['a','b','c']);
 assert.deepEqual(overlappingPredecessorIds(b,q),['a']);
 assert.deepEqual(overlappingPredecessorIds(c,q),[]);
 const prior=predecessorsForMerge(b,q,{a:{status:'draft_open',merge_sha:null}});
 assert.deepEqual(mergeGate(pr({head_sha:'abc',codex_reviewed_sha:'abc',mergeable:true,
  threads_resolved:true}),prior).reasons,['predecessor_not_merged']);
 const verified=predecessorsForMerge(b,q,{a:{status:'merged',merge_sha:'f'.repeat(40)}});
 assert.equal(mergeGate(pr({head_sha:'abc',codex_reviewed_sha:'abc',mergeable:true,
  threads_resolved:true}),verified).eligible,true);
});

test('explicit dependency order takes precedence over queue order for shared files',()=>{
 const parent={...task('a',['b']),exclusive_files:['lib/shared.ts']};
 const child={...task('b'),exclusive_files:['lib/shared.ts']};
 const q=queue([parent,child]);
 assert.deepEqual(overlappingPredecessorIds(parent,q),['b']);
 assert.deepEqual(overlappingPredecessorIds(child,q),[]);
});


test('final Codex readiness is held on shared-file merge order, not coding eligibility',()=>{
 const a={...task('a'),exclusive_files:['lib/shared.ts']};
 const b={...task('b'),exclusive_files:['lib/shared.ts']};
 const q=queue([a,b]);
 const ready={draft:true,pr_number:51,head_sha:'a'.repeat(40),ci_state:'success'};
 assert.deepEqual(readyGate(ready,predecessorsForMerge(b,q,{
  a:{status:'draft_open'}})).reasons,['predecessor_not_merged']);
 assert.equal(readyGate(ready,predecessorsForMerge(b,q,{
  a:{status:'merged',merge_sha:'b'.repeat(40)}})).eligible,true);
 assert.deepEqual(dispatchFrontier(q,{}, {chatgpt:2,claude:0}).map(x=>x.task_id),['a','b']);
});


test('clean GitHub PR never asks ChatGPT to self-declare coder done',()=>{
 const head='e'.repeat(40),at='2026-11-11T09:00:00Z',now=Date.parse('2026-11-11T09:21:00Z');
 const r={task_id:'E2',approved:true,pr_number:436,github_state:'open',
  conversation_ref:'https://chatgpt.com/c/existing-123',
  head_sha:head,draft:false,ci_state:'success',codex_state:'clean',
  codex_reviewed_sha:head,threads_resolved:true,mergeable:true,
  codex_review_at:at,last_github_activity:at,last_submission_at:at,
  acceptance_proven:false,coder_done:false};
 assert.deepEqual(decideNudge(r,now),{kind:'hold',reason:'no_coder_work'});
 assert.equal(decideNudge({...r,acceptance_proven:true,coder_done:true},now).kind,'hold');
 assert.equal(decideNudge({...r,submission_state:'uncertain'},now).kind,'hold');
 assert.equal(decideNudge({...r,ci_state:'failure'},now).action,'ci_failed');
 assert.equal(decideNudge({...r,codex_state:'findings'},now).action,'codex_comments');
 assert.equal(decideNudge({...r,mergeable:false},now).action,'repair_conflict');
});


test('owner priority sorts new dispatch without changing signed shared-file merge order',()=>{
  const a=task('a'),b=task('b'),c=task('c');
  a.exclusive_files=['lib/shared.ts'];b.exclusive_files=['lib/shared.ts'];
  const q={...queue([a,b,c]),capacity:{chatgpt:3,claude:0}};
  const prefs={priority:{c:80,b:60},paused:new Set(['a'])};
  const selected=dispatchFrontier(q,{},null,prefs);
  assert.deepEqual(selected.map(x=>x.task_id),['c','b']);
  assert.deepEqual(q.tasks.map(x=>x.id),['a','b','c']);
  assert.deepEqual(overlappingPredecessorIds(b,q),['a']);
});
