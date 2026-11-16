# Muse lightweight development coordination — reversible pilot

**Owner goal (November 16, 2026):** Muse watches current GitHub PR evidence and reminds
the correct existing ChatGPT chat; ChatGPT codes, tests, handles Codex and merges only
after the existing safety gates. The owner approves architecture and consequential
scope decisions. A GitHub Actions dispatcher failure must not stop an ordinary
ChatGPT coding chat or Muse's locally saved task notes.

## Scope and authority

This is a **side-by-side pilot**, not an authorization to deactivate the prior
dispatcher before real Muse-host acceptance. It does not change the signed task
queue, approval signatures, PR merge rules, PROGRESS.md, app code, permissions,
external actions or any production environment.

- **GitHub read-only evidence:** one GraphQL request per invocation reads open PR
  number, head SHA, commit date, aggregate check state and exact-head Codex summary,
  plus recent explicitly merged PRs. Failure/rate limit means `unavailable`;
  stale cache is **never treated as a new green result**. The observed aggregate
  green state does **not** prove all required check names are complete.
- **Local Muse state:** `notes.json` keyed by task ID, containing only PR number,
  a full ChatGPT conversation URL, informal stage, free-text note, author,
  timestamp and CAS revision. `github-facts.json` is the last read-only observed
  public-safe PR snapshot. `events.json` records one suggestion per task/head/
  issue, written before printing the suggestion to avoid duplicate browser sends.
  Files are created with private permissions in the existing Muse host's local
  user directory. They are **not owner approvals, provider receipts or task truth**.
- **Owner/Muse input:** the existing loopback-only private dashboard (default port
  7359) exposes `GET/POST /api/notes` and `GET /api/muse-status`. Muse's existing
  Basic credential may edit only local coordination notes, never the legacy
  `/api/control` authorization controls. The server can start without the legacy
  private-ledger token; its older ledger-based view will then be unavailable.
  It must remain on `127.0.0.1` behind an authenticated SSH tunnel.
- **Action suggestions:** the existing Muse host timer invokes the one-shot
  `muse-lite.mjs` script. It suggests `continue_chat` after 10 minutes without
  a commit (not if CI/review is pending or owner waiting); `fix_ci`;
  `fix_codex`; `verify_merge` (ChatGPT verifies real gates before merging);
  `remind_owner` seven minutes after a recorded owner-waiting stage; and
  `plan_next` only when a previously observed open PR is independently shown
  merged. An immutable event key suppresses repeat sends on unchanged evidence.
  An uncertain send is NOT automatically retried.
- **Delivery:** Muse uses its **already configured browser/ChatGPT courier** and
  its existing scheduler to deliver these suggestions. This script does **not**
  itself send a message, create a chat, install timers or claim browser success.
  Muse must verify an actual opened new-chat URL before saving it; never guess a
  URL or paste one merely because the browser command exited successfully.

## Run on Muse's existing machine

Copy the checked-in scripts (no new machine or service). Reuse Muse's existing
read-only GitHub token. No GitHub write credential is needed for the observer.

```bash
export GITHUB_REPOSITORY=killbill2792/aicafe
export GITHUB_TOKEN=<existing-read-only-GitHub-token>
export MUSE_COORDINATION_HOME="$HOME/.local/state/aicafe-muse"
node scripts/dev-dispatcher/muse-lite.mjs
```

The command prints bounded JSON: `github_read`, newly suggested `actions`,
`holds`, and last independently verified observation. Use Muse's existing
periodic invocation—do **not** add a second scheduler. An offline/rate-limited
poll prints `github_read: unavailable`, preserves local notes, and sends no
unverified GitHub-based action.

To open the existing private dashboard in notes-first mode (no private GitHub
ledger token required), set a strong local `DASHBOARD_OWNER_PASSWORD`, optionally
`DASHBOARD_MUSE_PASSWORD`, and start `owner-dashboard-v3.mjs`. Use an SSH tunnel
to its loopback port; do not expose it publicly. The dashboard provides the
editable Muse notes and PR evidence from the monitor's local last-good snapshot.

An approved coordinator may also enter the full verified ChatGPT URL into the
local dashboard for any **manually opened** chat. No PR-body marker or GitHub
dashboard comment is required for local Muse monitoring. The separate existing
repository PR chat-marker/approval rules remain binding for coding PR merges
until the owner explicitly changes that governance.

## Pilot and cutover acceptance (not claimed complete by repository tests)

1. Run against the actual currently open PRs, check exact PR/SHA/commit and
   distinguish green, failed, pending and unknown; trigger one real Codex finding.
2. Muse saves an actual browser-observed ChatGPT conversation URL and a note,
   restarts its process, then reads both back without any GitHub Actions run.
3. Have Muse actually deliver **one** same-chat repair through its browser;
   confirm browser URL, visible message acceptance and no second send after
   repeated monitor ticks. Do not re-send an uncertain browser attempt.
4. Run with GitHub API 429 and a failed/unstarted GitHub dispatcher Actions job.
   Local notes and owner reminder must remain writable. PR facts display stale;
   ChatGPT working independently is not blocked.
5. Verify no action while awaiting owner approval, while CI/Codex is running or
   with no authenticated chat URL. Test an actual merged PR opens only one next
   planning task. Verify unauthorized notes cannot alter signed approval or
   merge eligibility.
6. Only after live pilot succeeds, owner decides whether to set the existing
   `DISPATCH_LEDGER_AUTO_PERSIST=false` to stop the old reconciler writes and
   revise the binding GitHub workflow/rules in an owner-approved follow-up.
   **Do not delete private ledger history, signed receipts or owner decisions.**

### Unimplemented boundary

ChatGPT does not have direct network access to Muse's loopback-only dashboard.
Muse can register URLs/notes without GitHub; ChatGPT can still publish its PR
evidence through the existing GitHub connector and Muse can copy a verified
record. Direct ChatGPT-to-private-Muse writes would require a separately
authenticated, reachable integration and are deliberately **not** exposed by
this pilot.
