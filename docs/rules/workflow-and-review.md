## 10. How to work
- One accountable implementer per PR.
- Auto-merge when CI is green and the Codex review is clean; PRs must be up to date with main before merging.
- **Small PRs, one concern**, ideally < 400 changed lines. Pure deletions go in their own PR with no
  behavior change. State the owner journey the PR enables.
- Before coding: read this file plus only the docs your task needs, and `PROGRESS.md` "Now".
- Stay in scope. Do not touch files the task does not need. If you find another bug, list it in the PR;
  do not fix it in the same PR unless it blocks the task.
- When you delete a file, update every import, test, script and `.github/workflows/*` that references it.
- **"Done" means:** `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` all pass on the
  final commit, with a link to the green CI run. Do not self-grade with DONE/PARTIAL tables in place
  of that.
- No new dependency without a one-line reason in the PR. No production migrations or deploys
  without the owner's explicit approval.
- `PROGRESS.md` keeps three short sections: **Now** (≤ 5), **Next**, **Done (last 10)**. Older history goes
  to `docs/history/`.

## Mandatory Muse handoff

**Every coding chat, every resumed turn, including drafts:** follow AGENTS.md rules 0a–0b.
The existing PR body is the shared status record (not a new database/queue).
Maintain ONE active human-readable status section and ONE machine-readable marker,
editing only the record and preserving the scope, history and comment disposition.
Before launching work, after every meaningful outcome, and before ending the turn,
report the current full head SHA, what is actually happening, run/review link, last
observed evidence and concrete next action. Never report that a pending run passed.

Example of a pending workflow handoff (replace all placeholders with real values):

```text
<!-- aicafe-workflow-handoff {"id":"ci-actual-run-id","head":"FULL_CURRENT_40_HEX_SHA","state":"waiting_ci","run_url":"https://github.com/killbill2792/aicafe/actions/runs/ACTUAL_RUN_ID","next":"Read final required CI, fix failures, then continue eligible Codex review."} -->
```

States: `working`, `waiting_ci`, `waiting_codex`, `waiting_luna`, `blocked_external`.
Use a distinct ID for each genuine workflow attempt/handoff, stable across reads of
the same wait. `run_url` is the same-repository Actions run URL or null where no
run exists (Codex uses its actual exact-head PR receipt). For Luna include the
actual shared run ID/URL; a manual/owner-comment workflow can run on trusted main
so ordinary PR CI cannot establish its outcome. If Luna run ID is not yet available,
report that precisely as an external blocker with the owner's grant comment link
in the human-readable status; Muse should look up the matching shared run using
the existing connector before changing the record. Do not launch a second paid run.
`next` is a short report of the safe next action, not permission or executable instructions.

When an owner decision is actually required, put ONE existing marker in the PR body
and add `needs-owner-decision`. Example:

```text
<!-- aicafe-owner-question Luna test authorization: Task 14C; exact head FULL_SHA, scenario 14c, maximum $0.20. Recommend one shared run; no provider spend until you approve. Post /aicafe-luna pr FULL_SHA 14c 0.20 on this PR. -->
```

The real SHA/scenario/budget must match the actual request and shared runner contract.
For architecture or merge-only authorization describe exactly what is being approved,
why needed, recommendation and consequences. Do NOT ask the owner to fix ordinary
CI/Codex failures. Muse reads the exact PR marker and can relay the request even
without any saved chat URL. A request is not approval; only actual owner decisions
under existing gates authorize consequential actions. No secret/personal data in PR text.
Once verified, remove the active question marker and label and preserve the original
decision/evidence in Comment disposition; update the workflow handoff. Muse then resumes
the same saved chat. For an actual workflow terminal result the coding chat must
verify full evidence and continue, never substitute a status suggestion for acceptance.

**Foreground rule:** after a push or CI/Codex/Luna launch, monitor the actual check
in the same execution session; check around every 20–30 seconds, remain for at least
60 seconds while pending where execution permits, and handle terminal results immediately.
Keep working while possible. If a genuine execution/tool limit forces a return,
publish the current handoff and exact next action first. No new background scheduler,
no unbounded execution claim, and no duplicate review or paid run merely to get status.
Muse's existing timer is the fallback, not a substitute for this duty.

## 11. Review rules
- Block any PR that: adds a reviewer LLM, persona agents or a keyword/intent router; uses `strict:false`
  tool schemas or JSON-envelope answers; rewrites model text outside the exceptions in section 6; adds a
  second reader, calculator, attention list, inbox or experiment system; hard-codes a currency; creates
  a table without RLS; writes to the POS; sends staff/supplier messages directly; or changes tests
  outside the rules in section 9.
- Verify the tool-call/output pairing, all budget boundaries, database-compatible status values and
  honest missing-data behavior.
- First review of a PR: review the whole PR once and report everything in that one review.
- P1 = would hurt a real café owner today: wrong money or numbers, lost or corrupted data, security or
  privacy leaks, broken migrations, crashes, or a main flow that stops working. Post P1s inline. Put every
  P2 and lower in one "P2 list" in the review summary.
- Later reviews: only lines changed since your last review. Raise a new P1 only if those lines caused it.
- When fixing review comments, fix all P1s in one round, re-run all checks, then say it is ready for
  review. Don't fix P2s unless the owner asks.
- Ignore scale edge cases, rare keyboard/screen-reader paths, test wording and style unless they cause a P1.

## 12. Do NOT build (tried and retired, or out of scope for now)
- `lib/ai/supervisor/investigation/*`, P1/P2/P3 runners, deterministic intent routers, persona sub-agents,
  a reviewer LLM, display-token citations, `askWhenStuck`.
- Rules that ban digits in model text, force every reply to `partial`, or replace model text with generic copy.
- Discover-before-read meta tools (`discover_tools`), `strict:false` tool schemas, JSON-envelope final
  answers that block streaming, the `owner_question` card and its state machine, `/progress` polling.
- POS write-back, direct staff/supplier messaging, money movement (see section 2).
- New standalone screens for things the chat can do, and standalone reports that only repeat what the
  POS already shows.
