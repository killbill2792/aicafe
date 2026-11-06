#!/usr/bin/env node
// Trusted-main, read-only by default. --commit only updates a private GitHub ledger.
// Does NOT submit prompts, merge PRs or use model APIs.
import { readFileSync, appendFileSync } from "node:fs";
import { GitHubFacts } from "./github.mjs";
import { GitHubLedger, emptyLedger } from "./ledger.mjs";
import { validateQueue, dispatchFrontier, decideNudge, invalidateOnHeadChange, mergeGate } from "./core.mjs";

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
  const snapshot = await gh.snapshot();
  const current = ledger ? (await ledger.verifyPrivate(), (await ledger.load()).state) : emptyLedger();
  function reconcile(state) {
    const copy = structuredClone(state);
    const open = new Set(snapshot.map(x => x.pr_number));
    for (const [id, rec] of Object.entries(copy.tasks)) {
      if (Number.isInteger(rec.pr_number) && !open.has(rec.pr_number)) {
        // Absence from open PRs is NOT proof of merge. Hold until verified by a later merge query.
        copy.tasks[id] = { ...rec, github_state: "not_open_unverified" };
      }
    }
    for (const pr of snapshot) {
      for (const [id, rec] of Object.entries(copy.tasks)) {
        if (rec.pr_number !== pr.pr_number) continue;
        const updated = invalidateOnHeadChange(rec, pr.head_sha, pr.last_github_activity);
        copy.tasks[id] = { ...updated, ...pr, task_id: id,
          github_state: "open", submission_state: updated.submission_state };
      }
    }
    const assigned = dispatchFrontier(queue, copy.tasks);
    const nudges = [];
    for (const [id, rec] of Object.entries(copy.tasks)) {
      const proposal = decideNudge(rec, Date.now());
      if (proposal.kind !== "propose") continue;
      if (!copy.actions[proposal.key]) {
        copy.actions[proposal.key] = { task_id: id, type: proposal.action,
          status: "planned", head_sha: rec.head_sha || null, created_at: new Date().toISOString() };
        nudges.push({ task_id: id, action: proposal.action });
      }
    }
    // Task assignments are suggestions only. No task approved => no dispatch.
    return { state: copy, assigned, nudges };
  }
  const proposed = reconcile(current);
  if (commit && ledger) {
    await ledger.transaction(existing => reconcile(existing).state);
  }
  const gateCounts = { ready: 0, blocked: 0 };
  for (const rec of Object.values(proposed.state.tasks)) {
    const gate = mergeGate(rec);
    gateCounts[gate.eligible ? "ready" : "blocked"]++;
  }
  const summary = [
    "## AI CAFE development dispatcher — dry-run coordination",
    `- GitHub open PRs observed: **${snapshot.length}**`,
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
