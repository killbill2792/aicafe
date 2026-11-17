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
## Pilot before old dispatcher cutover
1. On Muse host, compare real PR heads/checks/reviews; register a copied ChatGPT URL and note, restart, verify persistence while GitHub Actions is disabled/unavailable.
2. Edit the same note concurrently as Muse and owner: stale form must receive **409 conflict**, never overwrite a newer chat URL/status; intentional reload must work.
3. Deliver one same-chat continuation with Muse's existing browser; verify actual accepted message, deduplication and no resend after uncertainty. Simulate API 429 and a failed Actions run: local notes and owner reminders must remain usable.
4. Confirm unverified/missing PR status never implies merge or owner approval.
**Muse-local startup (no owner password or private dispatcher token):** Muse may generate and privately store its own strong (at least 16-character) dashboard credential on the host. The existing host secret manager supplies it as `DASHBOARD_MUSE_PASSWORD`. With `DASHBOARD_OWNER_PASSWORD` and `DISPATCH_LEDGER_TOKEN` unset, run `node scripts/dev-dispatcher/owner-dashboard-v3.mjs`; it binds to `127.0.0.1:7359`. Sign in as `muse`. Local notes/actions and cached PR facts are accessible; legacy `/api/state` and `/api/control` return 503 and owner login is disabled. Do not put the password in GitHub, logs or chat.

**GitHub connector reuse:** Muse may obtain the one GraphQL result through its existing connector and feed the existing `muse-lite` observer/driver; no raw GitHub Actions token or new scheduler is needed. The PR dashboard only displays observed PR facts after the Muse host populates its local `github-facts.json`. No claim is made that a connector-backed driver or timer is installed by this PR.

For eventual **separate owner login**, configure a strong `DASHBOARD_OWNER_PASSWORD` privately and connect via a secured SSH tunnel; the owner role is deliberately absent from Muse-only mode. ChatGPT cannot POST to the private host without a separately authenticated connector; Muse can register the URL it observes. **Keep old signed ledger/receipts and dispatcher active until real Muse pilot and owner cutover approval.** Never expose localhost publicly.