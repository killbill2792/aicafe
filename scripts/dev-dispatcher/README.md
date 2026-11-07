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

## Shared Muse/Dave coordinator rollout (feature branch)

Both couriers consume the SAME private `dispatcher/state.json` actions; Muse is primary and Dave remains dry-run/manual fallback. `delivery` includes `base_branch`, full skills-aware `prompt`, existing authorization `approval_hash`, and separate SHA-256 `prompt_hash`. Existing Dave's bridge validates these fields and never reads conversation transcripts. A courier must verify the target tab and avoid sending if the coding chat is still generating.

`signal.mjs` publishes only `{version,pending_count,fingerprint}` to `signal.json` on the existing `muse-signal` branch. The fingerprint is HMAC-SHA256 over approved pending action IDs and prompt hashes. It changes only when the eligible pending set changes, not when CI status or ledger timestamps change. Scheduled five-minute runs naturally batch nearby changes; GitHub schedule timing is not guaranteed. A 3-minute quiet/10-minute maximum Muse-side batching policy still needs to be implemented and tested by the browser courier.

**Required before publishing:** configure the Actions secret `DISPATCH_SIGNAL_SECRET` with at least 32 random characters. The workflow will fail closed if this secret is missing, and never write the signal on a PR-triggered run. Publishing is not active until this PR merges and the secret is configured.

**Not yet implemented or activated:** trusted automatic courier receipt ingestion/claim locking, automatic PR-to-task discovery, safe branch retarget/update, Codex request automation, acceptance-evidence ingestion, auto squash-merge, and on-main integration verification. The existing `mergeGate` is a deterministic eligibility calculation, not a merge action. Do not call this unattended end-to-end orchestration. No live Dave sends are enabled, and no production changes are authorized.
