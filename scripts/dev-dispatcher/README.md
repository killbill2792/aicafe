# AI CAFE development dispatcher — PR A (safe foundation)

This is a **development** coordinator, not the café Supervisor. It reuses the approved Universal Supervisor queue from `docs/plans/universal-supervisor-queue.json`; `AGENTS.md` and applicable repository skills remain binding. Nothing in PR A submits chat prompts, uses NVIDIA, edits branches, merges PRs, contacts café owners or handles browser authentication.

## How it works

GitHub (open PRs, actual head SHAs, baseline check-runs, reviews and unresolved threads)
→ deterministic queue and inactivity rules
→ optional private ledger `dispatcher/state.json`
→ GitHub Actions run summary. All produced actions remain **planned**, not sent.

`scripts/dev-dispatcher/core.mjs` makes pure decisions. `github.mjs` reads public GitHub facts (no PR branch checkout). `ledger.mjs` uses the GitHub Contents API blob SHA for compare-and-swap, with bounded retry and a private-repo check. `run.mjs` reconciles and prints a short status. The dedicated workflow's concurrency key serializes active runs; scheduled executions every five minutes are advisory and may be delayed, so replay is idempotent. No browsing or response reading.

## Current execution mode

- On PR changes: run the fast deterministic Node tests with **no secret**.
- On trusted `main` schedule: read GitHub state and print **dry-run** status; default does **not** persist ledger or deliver actions.
- Only a manual `workflow_dispatch` with `persist_private_ledger=true` may sync state **after** a separate private ledger repo and access token are configured. This still does not deliver prompts or merge.
- If the ledger is absent, the scheduled coordinator is *observability-only*. Durable orchestration is not enabled and must **not** be called unattended.
- Task records must have an approved architecture and exclusive file ownership. Current PR6–PR17 tasks are proposed with empty ownership, so no automatic assignments are authorized.

## Owner setup required later (not for reviewing this PR)

1. Create a **private** GitHub repository, for example `aicafe-dispatch-state`, with a `main` branch. It needs no server or credit card.
2. Create a narrowly scoped, revocable GitHub credential with **Contents: read/write** on that *private ledger repository only*. Store it as the **Actions secret** `DISPATCH_LEDGER_TOKEN` in `aicafe`; never paste credentials into Issues, PRs, ChatGPT messages or code.
3. Set Actions variable `DISPATCH_LEDGER_REPO` to the private repository's `owner/name`. Run the workflow manually with persist enabled to prove the private ledger write, then inspect it in the private repository. Do not configure until the owner is ready for this test.
4. The future browser worker (PR C) stays on the **owner's laptop**, with its browser profile on the laptop only. The laptop must remain on, online and not asleep. No browser sessions/cookies are uploaded to GitHub. Its exact permissions and safe action transport will be proven separately.
5. Any live ChatGPT/Claude conversation submission must use a permitted mechanism. If service permission or Google session recovery is unknown, keep browser dispatch disabled and record `needs_login` or `blocked_permission`.

## Failure boundaries

A Codex review of an older SHA never clears a new head. CI or review pending means hold. Pre-PR reminders require a separately confirmed not-busy browser state. New commits cancel **planned** old-head prompts but preserve `uncertain` send receipts. Closed PRs are checked for `merged_at`; merge alone is not `integrated_proven`. No duplicate action is executed blindly, and no NVIDIA call is needed to determine merge eligibility.

**Remaining implementation:** PR B optional NVIDIA, PR C authorized local browser worker with session-restoration test and action receipts, PR D integration/merge/recovery. This PR's tests prove the isolated deterministic foundation; they do not prove unattended prompt delivery.

## Dave/OpenClaw private handoff (separate review-gated PR)

See [bridge/README.md](bridge/README.md) for the minimal, project-neutral queue reader that works on the existing AWS Ubuntu instance and uses the authenticated OpenClaw Chrome extension. The trusted-main dispatcher can generate self-contained approved browser instructions in the **private ledger only**. Scheduled ledger writes are OFF by default and are enabled explicitly by Actions variable `DISPATCH_LEDGER_AUTO_PERSIST=true` **after** the private repository is verified. Dave receives only a read token on the private ledger, never an AI CAFE source repository token. Live sends and automatic merges remain OFF; browser delivery, conversation-URL registration and acknowledgement require separate real-VM proof.
