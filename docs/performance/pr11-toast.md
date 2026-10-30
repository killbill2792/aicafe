# Performance PR 11 — Toast connection and diagnostics responsiveness

Scope: the existing Toast owner screen's **presentation and feedback**. The POS
readers, importer, reconciliation, fee calculations, cron, and database remain
unchanged. Branch starts at main `b8e20fa4fb23c0964aaef7f679a93c6f23054325`.

## Baseline and identified page-level bottleneck

Code-path audit on October 30, 2026 (no authenticated browser session available):

| Operation | Before | After |
| --- | --- | --- |
| Initial Toast diagnostics status GETs | **2 concurrent** `/api/pos/toast/status` calls: `ToastOnboardingChecklist` and `ToastOwnerDashboard` | **1** call owned by `ToastOwnerDashboard`, with its verified schema result passed to the checklist |
| Status requests per credentials-change notification | **2** for the same snapshot | **1** from the dashboard; checklist is purely presentational |
| Status endpoint backend | Each request performs 12 parallel reads and two follow-on reads (many paginated), including owner data / recon status | Same authenticated, scoped endpoint, same returned data, at most half as many duplicate requests from this page |
| Owner action result display | Confirmation after **POST + a fresh status GET** (success could be hidden while the GET waited) | Confirmation immediately after the **confirmed POST**, even if the subsequent GET is slow; diagnostic refresh still executes |
| Initial connection form | Rendered separately before diagnostic data arrives | Still rendered and usable before diagnostic data arrives |

The duplicate status request is a confirmed client-side code path, not a measured
Vercel timing claim. It is the only expensive **duplicated page operation** found
in the Toast initial render path. No status response is globally cached or reused
between users or cafés; all normal refreshes remain no-store and authenticated.
The checklist indicates *unknown/loading* instead of labeling missing status as
a failed step. The dashboard still validates all responses with the same
`statusSchema` and handles stale requests with the existing request gate.

**Measured before / after navigation milliseconds:** unavailable (browser sample
size N=0 before, N=0 after). The configured Vercel project
`cafe-profit` rejected production runtime-log reads with **HTTP 403**.
The local runtime also cannot reach github.com or launch an authenticated
test-café browser. The table above records verified request counts and
dependency ordering **only**, not invented p75/p95 speedups.
There is no evidence that the Toast POS operation itself is slow.

## Behavioral acceptance and measurement follow-up

New `components/more/toastPageResponsiveness.test.tsx` covers:
- EN/ES/AR (including Arabic RTL) connection controls while status is pending;
  no falsely completed onboarding steps before a validated snapshot;
- verified snapshot drives all eight checklist steps without a second request;
- a queued Re-pull is announced after the server response **before** an
  arbitrarily delayed diagnostics refresh;
- an unauthorized Looks right is never reported as a success;
- an already-answered response preserves that truthful result even when
  status is temporarily unavailable.

No existing test has been edited, skipped or deleted. There are no new
dependencies and no owner-facing translation keys.

To complete **live timing validation** after an owner-approved test deployment:
use the PR 1 privacy-safe `[nav-timing]` and existing `[reader-timing]`
instrumentation on a named phone and desktop network. Collect at least 20
sampled warm and cold Toast navigations per condition plus 20 Re-pull /
Looks right test-fixture actions (without repeating real import writes).
Report p50/p75/p95 of click feedback and usable content separately from POST,
status-GET and server-reader phases. Verify one status GET per mount and no
duplicate event refreshes in browser Network; inject delayed / failed status
GETs to confirm truthfulness. **Do not tick PR 11 in PROGRESS.md before
this real timing/interaction validation and green final-head CI.**

Active-PR ownership checked: #89 Olivia Staff, #291 live events,
#292 event report. No overlapping Toast files; none of their event,
shared-locale or PROGRESS changes were modified. The pending independent
café-settings consolidation is also untouched.

Remaining suspected Toast-side latency: the existing owner-status endpoint
reads full historical runs, day statuses, owner flags and summary entries,
including paginated historical rows, then follows with health and last-import
reads. If real production timings confirm this as the remaining bottleneck,
track an **independent POS-owned issue**; do not change it in PR 11.
