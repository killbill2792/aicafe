# AI CAFE shared Muse/Dave development coordinator (PR #392)

This is the **development coordinator**, not café Supervisor. The approved 19-rule acceptance checklist is in PR #392. AGENTS.md, PROGRESS.md, the approved task queue and repository skills are binding. Code and simulated tests are not proof of live browser delivery.

## One shared data path

Approved task → trusted GitHub dispatcher reads PR/CI/Codex state → private `dispatcher/state.json` with approval, exclusive files, exact prompt and courier owner → opaque public `signal.json` → Muse primary or explicitly assigned Dave fallback → authenticated private receipt → coding ChatGPT/Claude → GitHub verification → squash merge → actual merged-main scenario evidence → `integrated_proven` and dependent release.

The GitHub scheduler is shared. Dave retains his existing five-minute OpenClaw/Chrome queue reader; it is not another task scheduler. GitHub never reads coding conversations or browser transcripts.

## Execution and opt-ins

- `.github/workflows/ai-cafe-dev-dispatcher.yml` is the **only** dispatcher workflow. Its best-effort five-minute cron uses the UTC 02/07/12/…/57 offset (`2/5 * * * *`), and a trusted **main push** also reconciles immediately. For owner questions published while a draft PR remains open, the **same workflow** now reconciles after the existing `AI CAFE Pull Request Baseline` completes for a same-repository PR, after `AI CAFE Acceptance Evidence` completes for PR-body or label activity (label-only runs skip expensive acceptance execution), and independently after `AI CAFE Integration Proof` completes for merged-main verification, or when an OWNER/MEMBER/COLLABORATOR posts a PR comment. No second scheduler, polling process, browser sender or competing ledger writer is created. Every credential-bearing run checks out **main only** and invokes the same CAS ledger; fork PRs, anonymous PR comments and raw `pull_request` events never receive secrets. `DISPATCH_LEDGER_AUTO_PERSIST=true` is still required for automatic writes and wake-up signals. GitHub can delay/drop cron events: neither its schedule nor a green PR test guarantees a five-minute SLA. Existing actions and notices remain deduplicated on retries.
- `DISPATCH_LEDGER_REPO` is a private GitHub repository; `DISPATCH_LEDGER_TOKEN` is its narrowly scoped secret. `DISPATCH_COURIER_ACTORS` maps authenticated GitHub accounts to `muse` or `dave`.
- `DISPATCH_SIGNAL_SECRET` (at least 32 characters) protects the public HMAC fingerprint. Public `signal.json` has only version, pending count and fingerprint, never prompts, URLs, task IDs or owner questions.
- `DISPATCH_LEDGER_AUTO_PERSIST` and `DISPATCH_TRANSIENT_CI_RETRY` remain independent opt-ins. Branch maintenance retargets an open child after a verified parent merge; no routine parent-merge chat prompt is sent. Green coding drafts are automatically marked ready; dispatcher-only infrastructure drafts remain draft and owner-merge only. The separate `DISPATCH_AUTO_MERGE` setting governs merging, which requires current-head green checks, newest clean exact-head Codex receipt, resolved review threads, non-draft PR, GitHub mergeability, and verified predecessor merges. Routine owner questions, coder-done, acceptance artifacts, and predecessor `integrated_proven` are not merge gates. Paid/live/prod/secret work remains owner-held.
- The one-time CI retry applies only to GitHub-confirmed `startup_failure`. A retry is reserved durably before its GitHub API call. Compile/test failures go to the coder; uncertain retry effects are not blindly replayed.
- No branch deletion, production deploy, owner permissions change or café business effect is authorized.

## Courier, signal and receipt

One approved `planned` action includes a combined status/checklist for the same PR, provider, project, branch/base, exact prompt, approval hash, prompt SHA-256, destination conversation URL and `delivery_owner`. GitHub and Dave validate ownership; Dave live send requires explicit reassignment. Couriers must verify the actual browser provider/project/URL and idle composer, and must not guess tab IDs or read model replies.

An authenticated courier receipt also records the current conversation URL against its PR in the private ledger and private owner view (never the public status). A coding receipt is a private file `dispatcher/receipts/<sha256(action_id + ':' + prompt_hash)>.json`. GitHub validates the authenticated GitHub actor against the assigned courier, exact prompt and approval hashes, provider, project, URL and current status. Uncertain submissions remain held, never replayed.

Owner decisions, confirmed Claude usage limits and unmapped PRs are queued and deduplicated in the **same** private ledger under `owner_alerts`. Once POS0a is merged, integration-proven, and awaiting a separate owner sign-off on its exact architecture SHA, the dispatcher automatically queues one Muse-owned `architecture_approval` notice: **"Your approval is needed. ChatGPT chat: <verified existing conversation URL>"**. It uses only the authenticated/recorded `conversation_ref` in the private ledger, never a guessed URL; when no verified chat URL exists, it holds the notice and surfaces that blocker in the dispatcher summary. The notice is deduplicated by architecture SHA, cancelled if approved/revised before sending, included in the existing opaque wake-up signal, and acknowledged through the same authenticated Muse owner-notice receipt path. An owner question on an existing chat also includes its recorded ChatGPT link. **A Muse delivery receipt proves only notification submission; it is NOT owner approval or authorization to release B–F.** They contribute only an opaque HMAC signal. Muse is responsible for actual owner delivery; the GitHub side does not claim delivery without an authenticated receipt. Owner notice receipts use `sha256('owner:' + notice_id + ':' + notice_hash)` filenames, with `kind=owner_notice`, `notice_id`, `notice_hash` and `status=submitted`. Only an authenticated Muse account can acknowledge these. The `needs-owner-decision` PR label plus one `<!-- aicafe-owner-question ... -->` supplies the exact owner question. One `<!-- aicafe-task-id ID -->` marker allows safe manual-PR linking; unknowns are never guessed.

**Muse-owned, not implemented/proven here:** live project-aware browser send, idle inspection, once-only browser acceptance/receipt test, and the 3-minute quiet / 10-minute maximum batching window. Dave is dry-run until its fallback browser test passes.

## Development rules

Approval signatures are versioned: v2 signs the write scope but not read-only `uses`; compatible v1 signatures and original receipt hashes remain valid. Dependency and exclusive write scopes still govern task assignment, while merge order now requires predecessor **merged** status, not Integration Proof completion.

The dispatcher requests Codex only on a **stable, non-draft, current-head green** PR with no pending/existing exact-head request. It waits at least five minutes after the last push, PR opening as non-draft, or transition from draft to ready, because Codex automatic review is enabled on PR open and ready transition (not on pushes/update-branch). One manual request per head, never during red CI or mid-push. Dispatcher-only infrastructure PRs stay draft and owner-merge only, without automatic ready or Codex requests. The merge gate requires an authenticated clean Codex receipt for the exact merging head, directly or by verified **case B carry-over**, and zero unresolved threads. Coder-done, routine owner-decision labels, acceptance artifact and predecessor Integration Proof are no longer merge prerequisites. Paid/live/prod/secret labels continue to block.

## Exact CI acceptance and main integration proof

Acceptance evidence remains available as optional operational proof, but the coding-PR **merge gate** no longer requires `aicafe-coder-done`, acceptance comments, proof artifact digests, or a separate acceptance run. All required CI checks must pass on the current head. The exact-head Codex and review-thread requirements remain mandatory.

`AI CAFE Integration Proof` continues to verify merged-main scenarios and record `integrated_proven` with paginated proof discovery. It is post-merge evidence, not a prerequisite for dependent **merges**. Dependencies are visible in the private ledger and next actionable prompt; a newly proven predecessor does not generate a routine chat message.

Branch maintenance may retarget/update child branches after verified parent merges without force-push. It does not send routine chat nudges. GitHub conflicts trigger a coder-work prompt. Every changed head must rerun exact-head required checks. Codex follows the owner policy below; a valid case B is the only exception to requesting fresh Codex.

### Codex review change classification — owner Nov 10, 11:35–11:40 AM PT
After each new PR head, the trusted dispatcher records case letter, before/after `git patch-id --stable` values over the PR-only GitHub compare patches, intersecting changed filenames from intervening main commits, reviewed head/base and verified branch-update provenance in the **private ledger**:
- **A — PR added its own commits or changed its own patch:** fresh Codex after stable-head CI green.
- **B — GitHub accepted a conflict-free update onto main, the PR patch-id stayed identical, and intervening main commits touch none of the PR's changed files:** record `codex_carried_over` from the previously clean reviewed head; no additional request. This is checked again from live GitHub evidence before any merge.
- **C — Same patch as B, but intervening main commits touch a PR file:** fresh Codex.
- **D — Hand-resolved conflicts:** fresh Codex even if the final patch-id matches.
If patch data, ancestry, or conflict-free update provenance cannot be verified, fail closed to a fresh review; never infer a B receipt. Automatic Codex is enabled on PR opening and ready transition; neither pushes nor branch updates trigger it. The five-minute grace prevents wasteful `@codex review` duplicates. No new gate, label, scheduler or human step is introduced.

## Release boundary

Before live activation: latest-head CI, Codex findings addressed, current base, real acceptance job artifact, successful merged-main scenario checks, configured private tokens/actors, Muse delivery and receipt test, and Dave fallback test. Missing evidence means **not proven**. No production deployment is implied.

## Parallel ChatGPT stacks and merge order

The queue defines up to five active ChatGPT coding chats (plus two independent Claude tasks); a deferred task without a conversation or PR does not consume a slot. Approved dependent drafts open against an **open prerequisite PR branch**, not after the predecessor merges. A task with several open prerequisites must have one explicit `stack_base_task` in the approved DAG; that branch is the draft PR base, but all other prerequisites remain binding before merge. This is an opening base choice, not permission to pretend missing code is integrated. Never assume an upstream assigned task has an actual GitHub branch/PR. Every task still requires owner-approved source/key/scope and exact nonoverlapping files; POS0b–POS0f are not preapproved by the capacity change.

## Coding prompt and early draft rule (same coordinator)

The trusted-main `delivery.mjs` builds the single signed checklist for an existing PR, regenerating an unsent checklist when actionable state changes. A prompt is queued only when a check fails, Codex reports findings or a merge conflict requires coder work. Clean PRs, owner comments, parent merges, dependency proof updates and idle passage do not create follow-ups. Initial approved task assignment still starts one chat. Prompt size warns above 4096 UTF-8 bytes but does not reject solely for length.

`decideNudge` is now work-triggered rather than time-triggered: `ci_failed`, `codex_comments`, or `repair_conflict`. The key includes the current head and relevant failure/review/merge state. An obsolete *planned* action is cancelled and regenerated; claimed/uncertain deliveries remain held to prevent duplicates. No idle, parent-merge, owner-answer, dependency-proven or clean-PR prompts are sent.

Only one coordination owner may update `PROGRESS.md`, on latest main after merge/integration, in a **dedicated PROGRESS-only PR**. Coding PRs may only read it; the existing Repo guard blocks a simultaneous shared-progress edit mixed with implementation files. Each coding agent records proof in its own PR/task record instead of ticking other tasks' checkboxes.

Vercel PR preview builds/deployments remain disabled by owner decision; do not re-enable them. E2 remains proposed behind POS0f and will eventually run local app/seeded disposable DB/Playwright inside GitHub Actions, never in a Vercel preview.

## V2 owner visibility and private prompt retention

Pending unverified Muse deliveries remain visible in the private queue and retain the exact prompt/hash until authenticated receipt. Current chat URLs remain private. Older prompt/acceptance behavior is not a coding-PR merge gate; the six owner-approved conditions above are authoritative.
