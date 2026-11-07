# AI CAFE shared Muse/Dave development coordinator (PR #392)

This is the **development coordinator**, not café Supervisor. The approved 19-rule acceptance checklist is in PR #392. AGENTS.md, PROGRESS.md, the approved task queue and repository skills are binding. Code and simulated tests are not proof of live browser delivery.

## One shared data path

Approved task → trusted GitHub dispatcher reads PR/CI/Codex state → private `dispatcher/state.json` with approval, exclusive files, exact prompt and courier owner → opaque public `signal.json` → Muse primary or explicitly assigned Dave fallback → authenticated private receipt → coding ChatGPT/Claude → GitHub verification → squash merge → actual merged-main scenario evidence → `integrated_proven` and dependent release.

The GitHub scheduler is shared. Dave retains his existing five-minute OpenClaw/Chrome queue reader; it is not another task scheduler. GitHub never reads coding conversations or browser transcripts.

## Execution and opt-ins

- `.github/workflows/ai-cafe-dev-dispatcher.yml` is the **only** dispatcher workflow. Its original best-effort five-minute cron remains at UTC minutes 02/07/12/…/57, and a trusted **main push** also reconciles immediately. For owner questions published while a draft PR remains open, the **same workflow** now reconciles after the existing `AI CAFE Pull Request Baseline` completes for a same-repository PR, after the existing `AI CAFE Acceptance Evidence` workflow completes on PR-body edits or `needs-owner-decision` label changes (label-only runs skip expensive acceptance execution), or when an OWNER/MEMBER/COLLABORATOR posts a PR comment. No second scheduler, polling process, browser sender or competing ledger writer is created. Every credential-bearing run checks out **main only** and invokes the same CAS ledger; fork PRs, anonymous PR comments and raw `pull_request` events never receive secrets. `DISPATCH_LEDGER_AUTO_PERSIST=true` is still required for automatic writes and wake-up signals. GitHub can delay/drop cron events: neither its schedule nor a green PR test guarantees a five-minute SLA. Existing actions and notices remain deduplicated on retries.
- `DISPATCH_LEDGER_REPO` is a private GitHub repository; `DISPATCH_LEDGER_TOKEN` is its narrowly scoped secret. `DISPATCH_COURIER_ACTORS` maps authenticated GitHub accounts to `muse` or `dave`.
- `DISPATCH_SIGNAL_SECRET` (at least 32 characters) protects the public HMAC fingerprint. Public `signal.json` has only version, pending count and fingerprint, never prompts, URLs, task IDs or owner questions.
- `DISPATCH_LEDGER_AUTO_PERSIST`, `DISPATCH_TRANSIENT_CI_RETRY`, `DISPATCH_BRANCH_MAINTENANCE` and `DISPATCH_AUTO_MERGE` are separate opt-ins, **OFF until verified**.
- The one-time CI retry applies only to GitHub-confirmed `startup_failure`. A retry is reserved durably before its GitHub API call. Compile/test failures go to the coder; uncertain retry effects are not blindly replayed.
- No branch deletion, production deploy, owner permissions change or café business effect is authorized.

## Courier, signal and receipt

One approved `planned` action includes provider, project, branch/base, exact prompt, approval hash, prompt SHA-256, destination conversation URL and `delivery_owner`. GitHub and Dave validate ownership; Dave live send requires explicit reassignment. Couriers must verify the actual browser provider/project/URL and idle composer, and must not guess tab IDs or read model replies.

A coding receipt is a private file `dispatcher/receipts/<sha256(action_id + ':' + prompt_hash)>.json`. GitHub validates the authenticated GitHub actor against the assigned courier, exact prompt and approval hashes, provider, project, URL and current status. Uncertain submissions remain held, never replayed.

Owner decisions, confirmed Claude usage limits and unmapped PRs are queued and deduplicated in the **same** private ledger under `owner_alerts`. Once POS0a is merged, integration-proven, and awaiting a separate owner sign-off on its exact architecture SHA, the dispatcher automatically queues one Muse-owned `architecture_approval` notice: **"Your approval is needed. ChatGPT chat: <verified existing conversation URL>"**. It uses only the authenticated/recorded `conversation_ref` in the private ledger, never a guessed URL; when no verified chat URL exists, it holds the notice and surfaces that blocker in the dispatcher summary. The notice is deduplicated by architecture SHA, cancelled if approved/revised before sending, included in the existing opaque wake-up signal, and acknowledged through the same authenticated Muse owner-notice receipt path. An owner question on an existing chat also includes its recorded ChatGPT link. **A Muse delivery receipt proves only notification submission; it is NOT owner approval or authorization to release B–F.** They contribute only an opaque HMAC signal. Muse is responsible for actual owner delivery; the GitHub side does not claim delivery without an authenticated receipt. Owner notice receipts use `sha256('owner:' + notice_id + ':' + notice_hash)` filenames, with `kind=owner_notice`, `notice_id`, `notice_hash` and `status=submitted`. Only an authenticated Muse account can acknowledge these. The `needs-owner-decision` PR label plus one `<!-- aicafe-owner-question ... -->` supplies the exact owner question. One `<!-- aicafe-task-id ID -->` marker allows safe manual-PR linking; unknowns are never guessed.

**Muse-owned, not implemented/proven here:** live project-aware browser send, idle inspection, once-only browser acceptance/receipt test, and the 3-minute quiet / 10-minute maximum batching window. Dave is dry-run until its fallback browser test passes.

## Development rules

Approved dependencies, exact exclusive files and up to five ChatGPT/two Claude slots are coordinated centrally. Claude only gets independent tasks and no routine reminders. ChatGPT pre-PR inspection starts after 15 minutes. Head commits reset the ten-minute inactivity clock; pending CI/Codex halts nudges. Review findings, failed code CI, stale bases and missing acceptance work lead to focused instructions for the **existing** coder conversation after Muse confirms the browser is idle.

Existing GitHub configuration is expected to trigger initial Codex review; the dispatcher does not request paid review on every commit. Final relevant head review and resolved threads are still required by AGENTS.md. Review automation has to be verified live before unattended release.

## Exact CI acceptance and main integration proof

A PR carries one `<!-- aicafe-acceptance-evidence {JSON} -->` comment with `task_id`, head/base SHA and ordered rows (`id`, `command`, `test_file`, `result=passed`). Only exact `node --test PATH` or `npx vitest run PATH` are allowed. The separate `AI CAFE Acceptance Evidence` workflow uses the runner from protected main and tests the exact PR head, with no shell evaluation of submitted commands or persisted checkout credentials. It uploads `aicafe-acceptance-proof`. After CI completes, coder records `ci_run_id`, `acceptance_run_id` and the acceptance job URL(s). The merge gate validates both successful runs, job execution, artifact digest, live SHAs, approved criteria, CI, Codex and threads. Test-file existence or an author claim alone cannot pass.

The `AI CAFE Integration Proof` workflow runs typecheck, lint, full regressions, dispatcher tests, build and the merged task's exact scenario tests on the merged `main` SHA, uploading `aicafe-main-integration-proof`. A tracked merged PR (including a manual merge with GitHub-confirmed merge SHA) becomes `integrated_proven` only if the dispatcher verifies that artifact and every required scenario. Dependents are held otherwise.

Branch maintenance can attempt nonconflicting updates and safely retarget integrated predecessors, but cannot force-push, resolve semantic conflicts or replace a coder's rebase. A new base/head requires fresh applicable CI and final review. Squash auto-merge remains separately disabled until the acceptance and integration proof paths have been demonstrated.

## Release boundary

Before live activation: latest-head CI, Codex findings addressed, current base, real acceptance job artifact, successful merged-main scenario checks, configured private tokens/actors, Muse delivery and receipt test, and Dave fallback test. Missing evidence means **not proven**. No production deployment is implied.

## Parallel ChatGPT stacks and merge order

The queue defines up to five active ChatGPT coding chats (plus two independent Claude tasks); a deferred task without a conversation or PR does not consume a slot. Approved dependent drafts open against an **open prerequisite PR branch**, not after the predecessor merges. A task with several open prerequisites must have one explicit `stack_base_task` in the approved DAG; that branch is the draft PR base, but all other prerequisites remain binding before merge. This is an opening base choice, not permission to pretend missing code is integrated. Never assume an upstream assigned task has an actual GitHub branch/PR. Every task still requires owner-approved source/key/scope and exact nonoverlapping files; POS0b–POS0f are not preapproved by the capacity change.

## Coding prompt and early draft rule (same coordinator)

The trusted-main `delivery.mjs` is the only prompt builder. Every authorized new ChatGPT/Claude task opens a draft PR promptly, independent (base main) or stacked on an open upstream PR's actual branch. Unmerged prerequisites block downstream **merges**, not authorized coding. A separate approved source/architecture gate (POS0a) still blocks implementation before approval. The generated prompt always asks the coder to read current `AGENTS.md`, `PROGRESS.md`, the Supervisor queue/operations/delivery plan, exact task brief, binding rules and all three `aicafe-*` PR skills. It requires actual earlier integration proof, same-chat CI/Codex fixes and final-head re-review. Coding prompts do **not** mention couriers or browser mechanisms.

Inactivity recovery uses the same existing `decideNudge`: after 10 minutes without a new draft PR commit it may prepare one continuation for the existing chat, even if a draft has no Codex review; after 15 minutes without a PR it may prepare a pre-PR continuation. Explicit owner questions are held and reported through the existing owner-alert path, never misdiagnosed as stale. Pending/uncertain unacknowledged sends stay held, and the existing courier must verify the composer is idle before submitting. This is not a second monitoring loop.

Only one coordination owner may update `PROGRESS.md`, on latest main after merge/integration, in a **dedicated PROGRESS-only PR**. Coding PRs may only read it; the existing Repo guard blocks a simultaneous shared-progress edit mixed with implementation files. Each coding agent records proof in its own PR/task record instead of ticking other tasks' checkboxes.

Vercel PR preview builds/deployments remain disabled by owner decision; do not re-enable them. E2 remains proposed behind POS0f and will eventually run local app/seeded disposable DB/Playwright inside GitHub Actions, never in a Vercel preview.
