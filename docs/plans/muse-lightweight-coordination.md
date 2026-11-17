# Muse lightweight development coordination — reversible pilot

**Goal:** Muse monitors PR facts and coordinates the existing ChatGPT coding chats, without GitHub Actions controlling ordinary coding. The owner reviews architecture; ChatGPT codes, tests, resolves Codex findings and merges under existing gates. No new scheduler, model, database or external effect.

## Source, records and controls

| Input | Source / key | Use and trust |
|---|---|---|
| PR state | Read-only GitHub GraphQL: PR number, SHA, commit time, draft, aggregate checks, exact-head Codex bot summary, explicit merge | Observed facts only; aggregate green is **not** the required-check merge gate |
| Muse task note | Local private `notes.json`, keyed by task ID, with PR number, verified full chat URL, stage, note, author, time and CAS revision | Informal coordination; never owner approval, CI, Codex or merge proof |
| Snapshot | Local `github-facts.json` with observation timestamp | Stale/offline is **unknown**, not green |
| Actions | Local `events.json`, one immutable event ID per situation/head | Suggested actions only; no automatic browser resend after uncertainty |

The existing loopback-only private dashboard exposes authenticated `GET/POST /api/notes` for **owner and Muse**, read-only `GET /api/muse-status` and `GET /api/muse-actions`. Muse cannot edit legacy `/api/control`, signed scopes, approvals or GitHub facts. Both local notes and pending actions remain readable when the legacy ledger or GitHub Actions fails. Protect private chat URLs: no public Pages view or publicly bound server.

## One-shot Muse observer

```bash
export GITHUB_REPOSITORY=killbill2792/aicafe
export GITHUB_TOKEN=<Muse-existing-read-only-token>
export MUSE_COORDINATION_HOME="$HOME/.local/state/aicafe-muse"
node scripts/dev-dispatcher/muse-lite.mjs
```

Use Muse's **existing timer and browser courier**, never another scheduler. One GitHub read per successful poll; local cooldown after 429/403/401. A failed read must not stop local notes or owner reminders. Outputs are suggestions, **not confirmed browser sends**:

- **10 minutes without commit:** suggest one same-chat continuation, provided owner is not waiting and checks/review are not in progress.
- **Failed CI / Codex findings:** suggest an exact-PR/head investigation and repair.
- **Observed green + clean:** suggest ChatGPT verify *all* actual gates and merge only if eligible.
- **7 minutes after local `waiting_owner` stage:** remind owner to review architecture.
- **PR observed open then explicitly merged:** suggest asking the planning chat for the next tasks.

An action is reserved before output to avoid duplicate browser delivery; the local pending-action panel preserves suggestions if output was missed. Muse must verify actual browser delivery and a full new-chat URL before claiming success. Do not replay an uncertain send.

## Existing private dashboard

Launch `owner-dashboard-v3.mjs` with a strong `DASHBOARD_OWNER_PASSWORD`, optional strong `DASHBOARD_MUSE_PASSWORD` and the same local notes home. It binds **127.0.0.1:7359**; access via an owner-controlled SSH tunnel. The legacy private-ledger token is optional for the new local monitor/notes; if absent its old sections report unavailable. Muse may paste the URL of an already-open chat and enter free-text notes without writing anything to GitHub.

Direct ChatGPT-to-this-private-localhost writes are **not implemented**: ChatGPT can use its GitHub connection to write PR evidence, while Muse transcribes verified coordination details locally. A direct private write integration would require separately approved authenticated access; never expose the dashboard publicly merely to allow it.

## Required live pilot before cutover

1. On Muse's actual machine, read current open PRs and compare numbers, head SHA, CI/Codex and explicit merge to GitHub; confirm stale reads never claim green.
2. Register a real copied ChatGPT URL and note, restart the process, and verify both remain accessible without a GitHub Actions run.
3. Deliver **one** same-chat continuation through the existing Muse browser, verify the visible accepted message, restart/repoll and confirm no duplicate; test the missing/uncertain receipt case.
4. Simulate an API rate limit and a failed GitHub Actions run; local edit, owner reminder and cached-with-stale-label display must still work.
5. Verify no implied owner approval, no prompt delivery for absent URL, and correct next-planning suggestion after a verified merge.

This code does **not** install the Muse host service, send chats, merge PRs or disable the old dispatcher. Keep the signed ledger, receipts and `DISPATCH_LEDGER_AUTO_PERSIST` untouched until the real pilot succeeds and the owner authorizes a separate cutover. All runtime and governance protections remain in effect.
