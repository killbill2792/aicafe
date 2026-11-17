# Muse lightweight development coordination — owner pilot

**Goal:** Muse observes GitHub PR facts and coordinates existing ChatGPT conversations using its existing timer/browser. ChatGPT codes and merges under real CI/Codex gates; the owner approves architecture. No new scheduler, DB, code-execution authority or production effect.

## Actual sources and saved state

- One **read-only** GitHub GraphQL query returns open PRs, head/commit time, aggregate CI, trusted exact-head Codex summary and recently merged PRs. Aggregate green is not final merge clearance. Incomplete, failed or stale reads **never count as green**; 429/403/401 get local cooldown.
- Private Muse-host `notes.json` contains task-keyed PR number, real ChatGPT URL, informal stage, text, owner/Muse actor, timestamp and **CAS revision**. Concurrent edits must reject stale versions; local notes remain usable when GitHub or Actions fail.
- Private `github-facts.json` retains the last timestamped observation; `events.json` retains deduplicated **suggestions**, not proof a browser message arrived. Existing loopback-only dashboard at `127.0.0.1:7359` exposes authenticated `GET/POST /api/notes`, and read-only `/api/muse-status` and `/api/muse-actions`. Muse cannot mutate `/api/control` approvals or CI/merge evidence.

## Muse's existing timer

```bash
GITHUB_REPOSITORY=killbill2792/aicafe GITHUB_TOKEN=<Muse-read-only-token> node scripts/dev-dispatcher/muse-lite.mjs
```

One unchanged event produces at most one suggestion: after 10 minutes with no commit, on CI failure or exact-head Codex findings, on observed clean+green for **ChatGPT to verify** full gates, seven minutes after `waiting_owner`, or on an open→verified-merged PR for planning new tasks. Pending CI/review and owner holds suppress routine nudges. Uncertain browser delivery is **never resent blindly**; use Muse's existing courier and verify a real browser URL/message.

## Pilot required before disabling the old dispatcher

1. On Muse's existing host, compare real current PR heads/CI/Codex to its read-only dashboard; register a copied ChatGPT URL and note, restart, confirm they persist without GitHub Actions.
2. Edit one note concurrently as Muse and owner. The owner's stale form **must get a conflict**, never overwrite the newer URL/status; reload should allow an intentional new edit.
3. Use Muse's existing browser to send **one** same-chat continuation, confirm actual acceptance, and verify repeated polling doesn't duplicate it. Simulate API 429 and failed dispatcher Actions: local notes and owner reminders must still work with GitHub evidence marked stale.
4. Confirm no owner approval or merge can be faked through note input, and a missing/closed PR remains visible as an unverified blocker.

Run the existing private dashboard with strong `DASHBOARD_OWNER_PASSWORD`, optional strong `DASHBOARD_MUSE_PASSWORD`, and an SSH tunnel to loopback. ChatGPT cannot directly POST to private Muse localhost; Muse may register the real chat URL it observes. **Do not expose localhost publicly, install another scheduler, disable `DISPATCH_LEDGER_AUTO_PERSIST`, erase private receipts, or claim a live pilot before the owner/Muse confirms it.** See PR #503 for implementation and full acceptance evidence.
