# Muse lightweight owner coordination — GitHub legacy retired
**Owner decision (November 17, 2026):** Muse's existing host monitor and private dashboard
are the active development coordinator. The legacy GitHub cron/reconciler, Codex
request/ready/merge writer, self-wake/failure publisher, landing PR-comment bot
and public Owner Operations status dashboard are retired. Do not restart them.
GitHub PR CI and real Codex review receipts remain evidence, not instructions.
Past signed receipts and the private queue are audit history, not live coordination.

**Goal:** Muse monitors GitHub PR facts and coordinates existing ChatGPT chats using its existing timer/browser. ChatGPT codes and verifies CI/Codex; the owner approves architecture. No new scheduler, database, code-effect authority or production action.
## Source and records
- One read-only GitHub GraphQL query reads open PR heads, commit time, aggregate checks, exact-head Codex bot summaries and verified merges. Missing/stale/rate-limited data never counts as green; local 429/403/401 cooldown applies. Aggregate green is not merge clearance.
- Muse's private local `notes.json` stores task ID, PR, real ChatGPT URL, informal stage, text, actor, timestamp and **CAS revision**. Stale concurrent edits fail; local notes work without GitHub Actions.
- `github-facts.json` holds a timestamped snapshot and `events.json` holds once-per-situation suggestions, **not browser delivery proof**. Authenticated loopback dashboard `127.0.0.1:7359` supports owner/Muse `GET/POST /api/notes` plus read-only `/api/muse-status`, `/api/muse-actions`. Muse cannot edit approvals or real CI/Codex/merge facts.
## Muse host launch (existing timer)
```bash
GITHUB_REPOSITORY=killbill2792/aicafe GITHUB_TOKEN=<Muse-read-only-token> node scripts/dev-dispatcher/muse-lite.mjs
```
Rules: one suggestion for 10-minute no-commit stall, CI failure, exact-head Codex findings, clean+green verification, seven-minute owner reminder, or verified merge → next-task planning. Suppress ordinary nudges while CI/review/owner decision is pending. Never blindly resend an uncertain browser message.
## Read-only evidence inbox (open and merged PRs)
The existing Muse GitHub reader now retains source-linked Conversation comments and unresolved
inline review threads from open and recently merged PRs. It recognizes the exact owner-request
marker **and** high-confidence ordinary-language approval/decision requests without labels.
All valid-source comments remain available in `github-facts.json`; classification is an
attention filter, never an approval, instruction, or permission for GitHub to initiate work.
Review threads, CI/Codex observations, merge details and integration reports remain separate
facts. Incomplete pagination is visible as UNKNOWN, never treated as no requests.

The same `owner-questions.json` stores original comment ID, request text, source link,
local answer, delivery receipt and immutable history. A later trusted explicit comment
reference may mark a request `resolved_reported` or `superseded_reported`, not approved.
When a PR merges, earlier *development-only* scope questions are archived, not counted as
active, and never retroactively labeled approved. Explicit release, production, paid-run
and post-merge execution grants remain visible until settled. A bounded round-robin read
of PRs already in local question history reconciles older merges beyond the recent list;
it uses the existing read-only GitHub token, not the retired dispatcher.

The existing dashboard's **PR evidence and owner attention** table shows PR, state,
number of outstanding owner questions with source links, unresolved review threads,
integration report status and source. The existing question section shows active records
first and keeps archived/resolved records in collapsible history. Muse can change its
notification, timing and continuation policy without a code/PR change; GitHub does not
publish next-step commands or authorize any owner effect.

Post-merge ChatGPT verification reports use the `aicafe-integration-result:v1`
comment marker on the ORIGINAL merged PR, exact 40-hex merge SHA and status
`PROVEN|FAILED|NOT_PROVEN|BLOCKED|ACTION_REQUIRED`, with source URLs and human explanation.
Until the independent scenario, database, runtime and provider receipts are verified,
that is a **reported claim** only. Existing `AI CAFE Integration Proof` outputs explicit
`NOT_PROVEN` artifact/summary on missing acceptance metadata, even when general
regression jobs finish successfully. A missing report is NOT_REPORTED, not a pass.
The courier owns delivery and real-chat registration, not GitHub.

## Two-way question acknowledgment (same Muse host; no new dispatcher)
The owner or Muse can record `acknowledge`, `answer`, `claim_delivery`,
`confirm_delivery`, `confirm_not_sent`, `ignore`, `close`, or `reopen`
against the original PR comment ID using the existing authenticated
`POST /api/muse-questions`. An original request is never edited or deleted.
Local status and the revision-based compare-and-swap history update immediately;
an ignored/closed/answered request does not generate another owner reminder.

Muse mirrors each durable state transition to **one PR Conversation comment** on
the original PR using:
`<!-- aicafe-owner-state:v1 {"v":1,"question_id":"comment-123456789","event_id":"comment-123456789-r2","state":"ignored"} -->`.
Only IDs and coordination states are shared: **never** the private owner's answer,
credential or café data. The existing GitHub reader accepts these receipts only
from the repository owner or explicitly allowlisted GitHub accounts, applies
the most recent valid comment, and preserves audit history. Repeated comments
from the collector itself are never generated. Exact repeated same-head
questions are archived after the first, not re-notified. A later explicit
`reopened` receipt restores attention, including after merge.

**One-time Muse host setup, only if cross-courier synchronization is wanted:**
- Keep `GITHUB_REPOSITORY` and the existing read-only `GITHUB_TOKEN`.
- Supply `MUSE_GITHUB_COMMENT_TOKEN` from the existing secret manager, scoped
  to **this repo** with permission to create issue/PR Conversation comments
  (fine-grained Issues: write, or GitHub App Issues permission). It must not
  grant code, Actions, deployment, workflow or administration writes.
  Alternatively, when the already-connected GitHub token has the same
  restricted comment-write permission, set `MUSE_GITHUB_COMMENT_WRITE=1`
  to opt into using it; do not silently upgrade the read-only token.
- If the writing identity differs from the GitHub repository owner, configure
  `MUSE_GITHUB_ACK_AUTHORS` as a comma-separated allowlist of the authenticated
  bot/account login(s). The repository owner login is automatically allowed.
- The existing dashboard handler and existing Muse monitor publish/check receipts;
  **no new cron, workflow, external service, database or PR for every policy change**.

An HTTP 201 is recorded `published_unverified` until the reader independently
sees that exact event ID and state. A timeout/unknown POST is `uncertain`: it is
NOT resent automatically. Missing permissions are `blocked_auth`.
No token leaves the local decision effective but GitHub synchronization pending.
The existing question UI shows the status and source receipt. The owner/Muse may
choose `retry_github_sync` only after checking that an uncertain post is absent.
A read outage, stale GitHub snapshot, missing PR or unresolved duplicate must
never count as a successful synchronization. If the write token belongs to a separate
bot account, add that exact authenticated login to `MUSE_GITHUB_ACK_AUTHORS` before
considering its posted receipts verified; never infer trust from the comment text.
Grok Bot or another courier can
consume the same source-linked comments with its own authenticated read access;
neither bot inherits private owner authority from the marker.

### Plain-language example
For PR #533, GitHub exposes: "Additional acceptance test paths requested."
Muse marks the original comment "picked up"; you answer in the existing
conversation; Muse records delivery and optionally marks it "resolved".
GitHub still contains every source comment, but **owner attention: none**,
**Muse handling: complete**, with the receipt link and original preserved.
If you say "ignore" or "reopen" later, the next shared state is respected
without rewriting the PR or reopening the coding task. Production permissions
remain pending unless independently authorized.

## Local owner-question communication
Coding chats publish a new same-PR comment beginning `<!-- aicafe-owner-request:v1 FULL_HEAD -->` with the exact question. The existing read-only collector imports trusted comments by GitHub comment ID into private `owner-questions.json`, beside notes.json and github-facts.json. Muse opens the existing dashboard (127.0.0.1:7359), sees questions and can record the owner's actual answer, reserve delivery, send it to the registered chat, confirm delivery evidence or explicitly verify not sent, and close with a reason. The source never changes local answer status; use a new comment for a new request. Local entries are NOT approvals or proof of delivery; preserve actual owner authorization including the shared Luna runner's owner grant. No GitHub status writer.
For the connector-backed driver already used on the Muse host, use the exported updated `QUERY`, normalize with `normalizeGithubFacts`, and call `syncMuseQuestions(path,facts)` on each read before replacing the cache. The dashboard also imports the cached snapshot when reading /api/muse-questions; this supports the existing local JSON collector. If the latest 100 comments omit earlier pages, show incomplete question scan and inspect earlier pages through the read-only connector. Unknown/missing requests are not evidence of no blocker. Use the dashboard's local question records and existing timer for notifications; inspect original chat if an answer send is uncertain, never blindly replay it. For named shared Luna runs use `observeHandoffRuns(facts,readRun)` with existing authenticated read-only GET. A terminal run is not acceptance proof.
To verify the host, with a benign test PR question: import once, restart/re-read without duplication, record answer locally without modifying original PR, reserve actual saved-chat delivery, verify message acceptance, record actual receipt, close and import a second distinct question. Test unchanged/edited source and GitHub outage. Never restart the retired dispatcher.

## Verify the live Muse host
1. On Muse host, compare real PR heads/checks/reviews; register a copied ChatGPT URL and note, restart, verify persistence while GitHub Actions is disabled/unavailable.
2. Edit the same note concurrently as Muse and owner: stale form must receive **409 conflict**, never overwrite a newer chat URL/status; intentional reload must work.
3. Deliver one same-chat continuation with Muse's existing browser; verify actual accepted message, deduplication and no resend after uncertainty. Simulate API 429 and a failed Actions run: local notes and owner reminders must remain usable.
4. Confirm unverified/missing PR status never implies merge or owner approval.
**Muse-local startup (no owner password or private dispatcher token):** Muse may generate and privately store its own strong (at least 16-character) dashboard credential on the host. The existing host secret manager supplies it as `DASHBOARD_MUSE_PASSWORD`. With `DASHBOARD_OWNER_PASSWORD` and `DISPATCH_LEDGER_TOKEN` unset, run `node scripts/dev-dispatcher/owner-dashboard-v3.mjs`; it binds to `127.0.0.1:7359`. Sign in as `muse`. Local notes/actions and cached PR facts are accessible; legacy `/api/state` and `/api/control` return 503 and owner login is disabled. Do not put the password in GitHub, logs or chat.

**GitHub connector reuse:** Muse may obtain the one GraphQL result through its existing connector and feed the existing `muse-lite` observer/driver; no raw GitHub Actions token or new scheduler is needed. The PR dashboard only displays observed PR facts after the Muse host populates its local `github-facts.json`. No claim is made that a connector-backed driver or timer is installed by this PR.

For eventual **separate owner login**, configure a strong `DASHBOARD_OWNER_PASSWORD` privately and connect via a secured SSH tunnel; the owner role is deliberately absent from Muse-only mode. ChatGPT cannot POST to the private host without a separately authenticated connector; Muse can register the URL it observes. **Preserve old signed ledger/receipts as historical audit only; never restart the retired GitHub dispatcher.** Never expose localhost publicly.