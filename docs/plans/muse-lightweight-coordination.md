# Muse lightweight owner coordination — pilot

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

Use strong `DASHBOARD_OWNER_PASSWORD`, optional `DASHBOARD_MUSE_PASSWORD`, and an SSH tunnel to loopback. ChatGPT cannot POST to the private host without a separately authenticated connector; Muse can register the URL it observes. **Keep old signed ledger/receipts and dispatcher active until real Muse pilot and owner cutover approval.** Never expose localhost publicly.
