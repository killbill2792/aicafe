#!/usr/bin/env node
// Trusted-main, read-only by default. --commit only updates a private GitHub ledger.
// Does NOT submit prompts, merge PRs or use model APIs.
import { readFileSync, appendFileSync } from "node:fs";
import { GitHubFacts } from "./github.mjs";
import { GitHubLedger, emptyLedger } from "./ledger.mjs";
import { validateQueue, dispatchFrontier, decideNudge, reconcileGithub, mergeGate } from "./core.mjs";

async function main() {
  const queue = JSON.parse(readFileSync(new URL("../../docs/plans/universal-supervisor-queue.json", import.meta.url), "utf8"));
  validateQueue(queue);
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
    return { snapshot, closedByPr };
  }
  function reconcile(state, observed) {
    const copy = reconcileGithub(state, observed.snapshot, observed.closedByPr);
    const assigned = dispatchFrontier(queue, copy.tasks);
    const nudges = [];
    const now = new Date().toISOString();
    for (const assignment of assigned) {
      const key = `assign:${assignment.task_id}`;
      if (copy.actions[key]) continue;
      copy.actions[key] = { ...assignment, status: "planned", created_at: now };
      copy.tasks[assignment.task_id] = { task_id: assignment.task_id, status: "assigned",
        agent: assignment.agent, base_branch: assignment.base_branch, approved: true,
        prompt_id: `task:${assignment.task_id}`, prompt_version: "v1" };
    }
    for (const [id, rec] of Object.entries(copy.tasks)) {
      const proposal = decideNudge(rec, Date.now());
      if (proposal.kind !== "propose") continue;
      if (!copy.actions[proposal.key]) {
        copy.actions[proposal.key] = { task_id: id, type: proposal.action,
          status: "planned", head_sha: rec.head_sha || null, created_at: now };
        nudges.push({ task_id: id, action: proposal.action });
      }
    }
    // Proposals persist for later authorized delivery, never sent by this script.
    return { state: copy, assigned, nudges };
  }
  const observed = await observe(current);
  const proposed = reconcile(current, observed);
  if (commit && ledger) {
    // A CAS retry reloads the state; it MUST also reload GitHub facts before writing.
    await ledger.transaction(async existing => reconcile(existing, await observe(existing)).state);
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
    `- Private durable state: **${commit ? "saved (no external actions)" : ledger ? "read-only" : "not configured"}**`,
    "- Browser submissions and merge actions: **DISABLED**.",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}
main().catch(error => { console.error(`Dispatcher failed: ${error.message}`); process.exitCode = 1; });
