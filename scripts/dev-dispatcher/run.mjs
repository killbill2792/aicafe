#!/usr/bin/env node
// Trusted-main, read-only by default. --commit only updates a private GitHub ledger.
// Does NOT submit prompts, merge PRs or use model APIs.
import { readFileSync, appendFileSync } from "node:fs";
import { GitHubFacts } from "./github.mjs";
import { GitHubLedger, emptyLedger } from "./ledger.mjs";
import { validateQueue, dispatchFrontier, decideNudge, reconcileGithub, mergeGate } from "./core.mjs";
import { approvalSignature, createDelivery } from "./delivery.mjs";
import { revalidateQueuedActions } from "./authorization.mjs";
import { linkPullRequests } from "./dependencies.mjs";
import { mergeApprovedPr, integrationStatus } from "./effects.mjs";

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
      closedByPr[rec.pr_number] = Boolean(closed.merged_at);
    }
    const mainRef = await gh.request("/git/ref/heads/main");
    return { snapshot, closedByPr, mainSha: mainRef.object?.sha || null };
  }
  function reconcile(state, observed) {
    const linked = linkPullRequests(state, observed.snapshot);
    const copy = reconcileGithub(linked.state, observed.snapshot, observed.closedByPr);
    revalidateQueuedActions(copy, taskById);

    const assigned = dispatchFrontier(queue, copy.tasks);
    const nudges = [];
    const now = new Date().toISOString();
    for (const assignment of assigned) {
      const key = `assign:${assignment.task_id}`;
      if (copy.actions[key]) continue;
      const record = { task_id: assignment.task_id, status: "assigned",
        agent: assignment.agent, base_branch: assignment.base_branch, prerequisite_pr: assignment.prerequisite_pr, approved: true,
        approval_hash: approvalSignature(taskById.get(assignment.task_id)),
        prompt_id: `task:${assignment.task_id}`, prompt_version: "v1" };
      const delivery = createDelivery({ task: taskById.get(assignment.task_id), record,
        action: "assign", actionId: key });
      copy.actions[key] = { ...assignment, task_id: assignment.task_id,
        type: "assign", status: "planned", created_at: now, delivery };
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
          status: "planned", head_sha: rec.head_sha || null, created_at: now, delivery };
        nudges.push({ task_id: id, action: proposal.action });
      }
    }
    // Proposals persist for later authorized delivery, never sent by this script.
    return { state: copy, assigned, nudges };
  }
  const observed = await observe(current);
  const proposed = reconcile(current, observed);
  async function promoteIntegration(state, mainSha) {
    for (const rec of Object.values(state.tasks)) {
      if (rec.status !== "merged" || !rec.integration_proof) continue;
      const proof = rec.integration_proof;
      if (integrationStatus({ merged_sha: rec.merge_sha, main_sha: mainSha, proof }) !== "integrated_proven") continue;
      const run = await gh.request(`/actions/runs/${proof.workflow_run_id}`);
      if (run.head_sha === mainSha && run.status === "completed" &&
          run.conclusion === "success" && run.event === "push" &&
          run.name === "AI CAFE Integration Proof") rec.status = "integrated_proven";
    }
  }
  let persisted = null;
  if (commit && ledger) {
    // Reconcile against fresh facts on every CAS attempt; do not write an
    // identical state every five minutes (avoids 288 empty commits per day).
    persisted = await ledger.transaction(async existing => {
      const latest = await observe(existing);
      const next = reconcile(existing, latest).state;
      await promoteIntegration(next, latest.mainSha);
      return JSON.stringify(next) === JSON.stringify(existing) ? null : next;
    });
  }
  // Auto-merge is separately opt-in and requires independently verified acceptance evidence.
  // This is deliberately not enabled by merely persisting the queue.
  const autoMerge = process.env.DISPATCH_AUTO_MERGE === "true" && commit;
  if (autoMerge && ledger) {
    for (const [id, rec] of Object.entries(proposed.state.tasks)) {
      if (!rec.pr_number || rec.github_state !== "open" || rec.draft) continue;
      const task = taskById.get(id);
      if (!task || !rec.approved || !rec.acceptance_evidence) continue;
      const predecessorRecords = (task.depends_on || []).map(dep => proposed.state.tasks[dep] || {status:"unknown"});
      const outcome = await mergeApprovedPr({ github: gh, record: rec, predecessors: predecessorRecords,
        evidence: rec.acceptance_evidence, enabled: true });
      if (outcome.status === "merged_unproven") {
        await ledger.transaction(state => {
          const currentRec = state.tasks[id];
          if (!currentRec || currentRec.head_sha !== rec.head_sha) return null;
          currentRec.status = "merged"; currentRec.merge_sha = outcome.merge_sha;
          currentRec.github_state = "merged";
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
  const summary = [
    "## AI CAFE development dispatcher — dry-run coordination",
    `- GitHub open PRs observed: **${observed.snapshot.length}**`,
    `- Approved new assignments: **${proposed.assigned.length}**`,
    `- Eligible follow-ups (NOT sent): **${proposed.nudges.length}**`,
    `- Tracked merge gates: ready **${gateCounts.ready}**, blocked **${gateCounts.blocked}**`,
    `- Private durable state: **${commit ? persisted?.committed ? "saved" : "unchanged" : ledger ? "read-only" : "not configured"} (no external actions)**`,
    "- Browser submissions and merge actions: **DISABLED**.",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
main().catch(error => { console.error(`Dispatcher failed: ${error.message}`); process.exitCode = 1; });
