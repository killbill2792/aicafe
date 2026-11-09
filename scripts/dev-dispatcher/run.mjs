#!/usr/bin/env node
// Trusted-main, read-only by default. --commit only updates a private GitHub ledger.
// Does NOT submit prompts, merge PRs or use model APIs.
import { readFileSync, appendFileSync } from "node:fs";
import { GitHubFacts } from "./github.mjs";
import { GitHubLedger, emptyLedger } from "./ledger.mjs";
import { validateQueue, dispatchFrontier, decideNudge, reconcileGithub, mergeGate, architectureFoundationReady, predecessorsForMerge } from "./core.mjs";
import { approvalSignature, createDelivery } from "./delivery.mjs";
import { acceptanceDigest } from "./acceptance-runner.mjs";
import { revalidateQueuedActions, assignmentActionKey } from "./authorization.mjs";
import { linkPullRequests } from "./dependencies.mjs";
import { mergeApprovedPr, integrationStatus, safeUpdateBranch, retargetAfterIntegration, retryStartupFailure } from "./effects.mjs";
import { collectReceipts, applyReceipts } from "./inbox.mjs";
import { queueOwnerAlerts } from "./alerts.mjs";

async function main() {
  const queue = JSON.parse(readFileSync(new URL("../../docs/plans/universal-supervisor-queue.json", import.meta.url), "utf8"));
  validateQueue(queue);
  const taskById = new Map(queue.tasks.map(task => [task.id, task]));
  const repo = process.env.GITHUB_REPOSITORY;
  const githubToken = process.env.GITHUB_TOKEN;
  if (!repo || !githubToken) throw new Error("GITHUB_REPOSITORY/GITHUB_TOKEN required");
  const commit = process.argv.includes("--commit");
  const ledgerRepo = process.env.DISPATCH_LEDGER_REPO;
  const ledgerToken = process.env.DISPATCH_LEDGER_TOKEN;
  if (commit && (!ledgerRepo || !ledgerToken)) throw new Error("Cannot persist without private ledger repo and token");
  const ledger = ledgerRepo && ledgerToken ? new GitHubLedger({ repo: ledgerRepo, token: ledgerToken }) : null;
  const gh = new GitHubFacts({ repo, token: githubToken });
  const current = ledger ? (await ledger.verifyPrivate(), (await ledger.load()).state) : emptyLedger();
  async function observe(state) {
    const snapshot = await gh.snapshot();
    const closedByPr = {};
    const openNumbers = new Set(snapshot.map(x => x.pr_number));
    // Check actual merge metadata; disappearing from the open list is not proof of merge.
    for (const rec of Object.values(state.tasks)) {
      if (!Number.isInteger(rec.pr_number) || openNumbers.has(rec.pr_number)) continue;
      const closed = await gh.request(`/pulls/${rec.pr_number}`);
      closedByPr[rec.pr_number] = { merged: Boolean(closed.merged_at),
        merge_sha: closed.merged_at ? closed.merge_commit_sha || null : null };
    }
    const mainRef = await gh.request("/git/ref/heads/main");
    return { snapshot, closedByPr, mainSha: mainRef.object?.sha || null };
  }
  function reconcile(state, observed) {
    const linked = linkPullRequests(state, observed.snapshot);
    // First invalidate old-head actions, THEN process Muse receipts. A receipt
    // arriving during the same GitHub reconciliation must not revive old work.
    const live = reconcileGithub(linked.state, observed.snapshot, observed.closedByPr);
    const copy = queueOwnerAlerts(
      applyReceipts(live, inbox, actorMap),
      {unmappedPrs:linked.unmapped,queue});
    revalidateQueuedActions(copy, taskById, queue);

    const assigned = dispatchFrontier(queue, copy.tasks);
    const nudges = [];
    const now = new Date().toISOString();
    for (const assignment of assigned) {
      const key = assignmentActionKey(copy, assignment.task_id, queue);
      if (!key) continue;
      const record = { task_id: assignment.task_id, status: "assigned",
        agent: assignment.agent, branch: `feat/aicafe-task-${assignment.task_id}`, base_branch: assignment.base_branch, prerequisite_pr: assignment.prerequisite_pr, approved: true,
        approval_hash: approvalSignature(taskById.get(assignment.task_id)),
        prompt_id: `task:${assignment.task_id}`, prompt_version: "v1" };
      const delivery = createDelivery({ task: taskById.get(assignment.task_id), record,
        action: "assign", actionId: key });
      copy.actions[key] = { ...assignment, task_id: assignment.task_id,
        type: "assign", status: "planned", delivery_owner: "muse", created_at: now, delivery };
      copy.tasks[assignment.task_id] = record;
    }
    for (const [id, rec] of Object.entries(copy.tasks)) {
      // Never queue a second browser action while a prior delivery is pending or unverified.
      if (Object.values(copy.actions).some(a => a.task_id === id && ["planned", "claimed", "uncertain"].includes(a.status))) continue;
      const proposal = decideNudge(rec, Date.now());
      if (proposal.kind !== "propose") continue;
      if (!copy.actions[proposal.key]) {
        const task = taskById.get(id);
        // Only approved, exactly owned tasks from the trusted queue can reach Dave.
        if (!task || task.architecture_approval?.approved !== true ||
            !task.exclusive_files?.length || rec.approval_hash !== approvalSignature(task) ||
            (Number.isInteger(rec.pr_number) && rec.github_state !== "open")) continue;
        const delivery = createDelivery({ task, record: rec,
          action: proposal.action, actionId: proposal.key });
        rec.last_action_key = proposal.key;
        copy.actions[proposal.key] = { task_id: id, type: proposal.action,
          status: "planned", delivery_owner: "muse", head_sha: rec.head_sha || null, created_at: now, delivery };
        nudges.push({ task_id: id, action: proposal.action });
      }
    }
    // Proposals persist for later authorized delivery, never sent by this script.
    return { state: copy, assigned, nudges };
  }
  const actorMap = Object.fromEntries((process.env.DISPATCH_COURIER_ACTORS || "").split(",").filter(Boolean).map(part => {
    const [actor, courier] = part.split("=");
    if (!actor || !["muse", "dave"].includes(courier)) throw new Error("Invalid courier actor mapping");
    return [actor, courier];
  }));
  const inbox = ledger ? await collectReceipts({ ledger, allowedActors: Object.keys(actorMap) }) : [];
  const observed = await observe(current);
  const proposed = reconcile(current, observed);
  const unmappedPrs = linkPullRequests(current, observed.snapshot).unmapped;
  async function promoteIntegration(state) {
    const required = ["TypeScript", "ESLint", "Full regression tests",
      "Dispatcher regression tests", "Production build", "Capability integration scenarios"];
    for (const [id, rec] of Object.entries(state.tasks)) {
      if (rec.status !== "merged" || !rec.merge_sha) continue;
      const expected = taskById.get(id)?.acceptance;
      const submitted = rec.acceptance_evidence?.acceptance;
      if (!Array.isArray(expected) || !expected.length ||
          !Array.isArray(submitted) || submitted.length !== expected.length) continue;
      // Token-initiated squash merges require an explicit workflow_dispatch;
      // manual merges use push. Only an executed proof on exact merged SHA counts.
      const runs = await gh.request('/actions/workflows/ai-cafe-integration-proof.yml/runs?branch=main&per_page=100');
      if (runs.total_count > 100) continue; // never silently ignore pagination
      for (const run of runs.workflow_runs || []) {
        if (run.name !== 'AI CAFE Integration Proof' || run.head_branch !== 'main' ||
            !['push','workflow_dispatch'].includes(run.event) ||
            run.status !== 'completed' || run.conclusion !== 'success' ||
            (run.event === 'push' && run.head_sha !== rec.merge_sha)) continue;
        const jobs = await gh.request(`/actions/runs/${run.id}/jobs?per_page=100`);
        if (jobs.total_count > 100) continue;
        const job = jobs.jobs?.find(j => j.name === 'Required merged-main integration checks' &&
          j.status === 'completed' && j.conclusion === 'success');
        if (!job || !required.every(name => job.steps?.some(step => step.name === name &&
          step.status === 'completed' && step.conclusion === 'success'))) continue;
        const artifact = await gh.integrationProof(run.id);
        if (!artifact || artifact.task_id !== id || artifact.run_id !== run.id ||
            artifact.head_sha !== rec.merge_sha || artifact.base_sha !== rec.merge_sha ||
            artifact.acceptance_digest !== acceptanceDigest(submitted) ||
            !Array.isArray(artifact.acceptance) || artifact.acceptance.length !== expected.length ||
            !artifact.acceptance.every((item,i) => item.id === String(i+1) &&
              item.command === submitted[i].command && item.test_file === submitted[i].test_file &&
              item.result === 'passed')) continue;
        const proof = {main_sha:rec.merge_sha,merged_sha:rec.merge_sha,
          workflow_run_id:run.id,conclusion:'success',required_scenarios:artifact.acceptance};
        if (integrationStatus({merged_sha:rec.merge_sha,main_sha:rec.merge_sha,
          proof,expectedAcceptance:expected}) === 'integrated_proven') {
          rec.integration_proof = proof;
          rec.status = 'integrated_proven';
          break;
        }
      }
    }
  }

  let persisted = null;
  if (commit && ledger) {
    // Reconcile against fresh facts on every CAS attempt; do not write an
    // identical state every five minutes (avoids 288 empty commits per day).
    persisted = await ledger.transaction(async existing => {
      const latest = await observe(existing);
      const next = reconcile(existing, latest).state;
      await promoteIntegration(next);
      // Integration may become proven during this same pass: queue the owner
      // review with the actual saved chat URL without a second delayed cycle.
      const withNotices = queueOwnerAlerts(next,{queue});
      return JSON.stringify(withNotices) === JSON.stringify(existing) ? null : withNotices;
    });
  }
  // Only independently classified runner startup errors may be retried, once.
  if (commit && ledger && process.env.DISPATCH_TRANSIENT_CI_RETRY === "true") {
    for (const [id, rec] of Object.entries(proposed.state.tasks)) {
      const result = await retryStartupFailure({github:gh,ledger,taskId:id,record:rec,enabled:true});
      if (result.status === "retry_requested") console.log(`Retried verified CI startup failure for task ${id} (run ${result.run_id})`);
    }
  }
  // Optional branch maintenance never rebases, force-pushes or resolves conflicts.
  if (commit && process.env.DISPATCH_BRANCH_MAINTENANCE === "true") {
    for (const [id, rec] of Object.entries(proposed.state.tasks)) {
      if (rec.github_state !== "open" || !rec.pr_number) continue;
      const task = taskById.get(id);
      if (!task || !rec.approved) continue;
      const upstream = (task.depends_on || []).map(dep => proposed.state.tasks[dep])
        .filter(p => p?.branch === rec.base_branch && ["integrated_proven","released_proven"].includes(p.status));
      if (upstream.length === 1) {
        await retargetAfterIntegration({github:gh,dependent:rec,predecessor:upstream[0],enabled:true});
        continue; // recheck the changed base on next trusted reconciliation
      }
      if (rec.base_current === false && rec.base_branch === "main")
        await safeUpdateBranch({github:gh,record:rec,enabled:true});
    }
  }
  // Auto-merge is separately opt-in and requires independently verified acceptance evidence.
  // This is deliberately not enabled by merely persisting the queue.
  const autoMerge = process.env.DISPATCH_AUTO_MERGE === "true" && commit;
  if (autoMerge && ledger) {
    for (const [id, rec] of Object.entries(proposed.state.tasks)) {
      if (!rec.pr_number || rec.github_state !== "open") continue;
      const task = taskById.get(id);
      if (!task || !rec.approved || !rec.acceptance_evidence) continue;
      const predecessorRecords = predecessorsForMerge(task, queue, proposed.state.tasks);
      // Draft-to-ready and merge use the exact same executed proof gate.
      // A successful ready transition is NOT merged in this same stale snapshot;
      // GitHub must observe/review the ready PR again on the next run.
      const outcome = await mergeApprovedPr({ github: gh, record: rec, predecessors: predecessorRecords,
        evidence: rec.acceptance_evidence, expectedAcceptance: task.acceptance, enabled: true,
        action: rec.draft ? "ready" : "merge" });
      if (outcome.status === "ready_for_review") {
        console.log(`Verified PR #${rec.pr_number} for task ${id} is ready for review; merge awaits fresh GitHub reconciliation`);
        continue;
      }
      if (outcome.status === "merged_unproven") {
        await ledger.transaction(state => {
          const currentRec = state.tasks[id];
          if (!currentRec || currentRec.head_sha !== rec.head_sha) return null;
          currentRec.status = "merged"; currentRec.merge_sha = outcome.merge_sha;
          currentRec.github_state = "merged"; currentRec.integration_dispatch = outcome.integration_dispatch;
          return state;
        });
      }
    }
  }
  const gateCounts = { ready: 0, blocked: 0 };
  for (const rec of Object.values(proposed.state.tasks)) {
    const gate = mergeGate(rec);
    gateCounts[gate.eligible ? "ready" : "blocked"]++;
  }
  const effectiveState = persisted?.state || proposed.state;
  // The existing GitHub Actions summary is the owner-readable control surface.
  // Never expose private courier prompts or conversation URLs in public logs.
  const active = Object.entries(effectiveState.tasks).filter(([,rec])=>
    Number.isInteger(rec.pr_number) && rec.github_state === "open");
  const rows = active.sort(([,a],[,b])=>a.pr_number-b.pr_number).map(([id,rec])=>{
    const task = taskById.get(id);
    const dependencies = task ? predecessorsForMerge(task,queue,effectiveState.tasks) : [];
    const reasons = mergeGate(rec,dependencies).reasons;
    const outstanding = Object.values(effectiveState.actions).filter(action=>
      action.task_id === id && action.status === "planned")
      .sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||"")));
    const next = rec.owner_question || rec.github_owner_question ? "Owner decision + permitted coder fixes" :
      rec.ci_state === "failure" ? "Coder: repair CI" :
      rec.codex_state === "findings" ? "Coder: address review" :
      reasons.length ? "Coder/dispatcher: finish proof" : "GitHub: ready/merge gate";
    const action = outstanding[0];
    const pending = action ? action.type + " planned (Muse not verified)" : "none";
    return `| ${id} | [#${rec.pr_number}](https://github.com/${repo}/pull/${rec.pr_number}) | ${rec.draft ? "Draft" : "Open"} | ${rec.ci_state || "unknown"} | ${rec.codex_state || "unknown"} | ${next} | ${pending} | ${reasons.join(", ") || "eligible"} |`;
  });
  const foundationId = queue.dispatch_rules?.architecture_foundation_proof_task;
  const foundationRecord = effectiveState.tasks?.[foundationId];
  const foundationReviewPending = !!foundationId &&
    ["merged","integrated_proven","released_proven"].includes(foundationRecord?.status) &&
    !architectureFoundationReady(queue,effectiveState.tasks);
  const hasChatReceipt = !!foundationRecord?.conversation_ref;
  const summary = [
    "## AI CAFE development dispatcher — coordination status",
    `- Last persisted state: **${effectiveState.updated_at || "not yet saved"}** (an unchanged ledger alone is not a scheduler heartbeat)`,
    "- 10-minute code inactivity / 15-minute post-delivery checks are best-effort; GitHub scheduled runs may be delayed or dropped.",
    "",
    "### Current PRs and next responsible party",
    "| Task | PR | Stage | CI | Codex | Next actor | Muse action | Merge blockers |",
    "|---|---|---|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | — | — | — | — | No active tracked PR | — | — |"]),
    "",
    `- GitHub open PRs observed: **${observed.snapshot.length}**`,
    `- Unmapped PRs requiring owner/coder identification (never guessed): **${unmappedPrs.join(", ") || "none"}**`,
    `- Approved new assignments: **${proposed.assigned.length}**`,
    `- Eligible follow-ups (NOT sent): **${proposed.nudges.length}**`,
    `- Planned Muse owner notices (NOT sent): **${Object.values(effectiveState.owner_alerts || {}).filter(n=>n.status==="planned").length}**`,
    `- Architecture owner review pending: **${foundationReviewPending ? (hasChatReceipt ? "Muse notice queued or already submitted" : "waiting for verified ChatGPT conversation receipt") : "no"}**`,
    `- Tracked merge gates: ready **${gateCounts.ready}**, blocked **${gateCounts.blocked}**`,
    `- Private durable state: **${commit ? persisted?.committed ? "saved" : "unchanged" : ledger ? "read-only" : "not configured"} (no external actions)**`,
    "- Browser submissions: **not performed by GitHub**; courier execution is separate.",
    `- Auto-merge opt-in: **${autoMerge ? "enabled (strict gates enforced)" : "disabled"}**.`,
    `- Branch maintenance opt-in: **${commit && process.env.DISPATCH_BRANCH_MAINTENANCE === "true" ? "enabled" : "disabled"}**.`,
    `- Transient CI retry opt-in: **${commit && process.env.DISPATCH_TRANSIENT_CI_RETRY === "true" ? "enabled" : "disabled"}**.`,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
main().catch(error => { console.error(`Dispatcher failed: ${error.message}`); process.exitCode = 1; });
