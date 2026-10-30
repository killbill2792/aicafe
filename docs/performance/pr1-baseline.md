# Performance PR 1: browser/server baseline and collection

This PR adds **instrumentation only**, not optimizations or a second analytics backend.
It samples 10% of browser navigation attempts and initial document loads. A beacon sends
an allowlisted route/action, device class, timing numbers and a random ephemeral trace;
it does **not** send raw paths, search parameters, prompts, addresses, café/customer
identifiers or finance amounts. The trace is a 30-second cookie, not a user/session ID.
Existing `[reader-timing]` logs gain the trace and random render-request ID.

**Browser stages:** `feedbackMs` records first DOM feedback on the tapped element or a
visible loading shell (null means none detected). `pendingMs` records first loading
shell (null means none was rendered). `usableMs` records the first paint after
committed non-loading `main` content. A 15-second timeout records `status=timeout`
and a null usable time, not a fabricated speed. For document loads, usable time runs
from navigation start through client hydration and first usable paint. `ttfbMs` is
document response-start timing (cold document) or the first sampled Next RSC fetch
response-start timing (client route); `rscRequests` counts same-origin `_rsc`
fetches that start before usability. Sampled click beacons are additional telemetry
requests, **not additional data fetches**.

**Cold versus warm:** `session=document` means first document navigation;
`session=client` means warm Next client-side navigation. These labels are NOT
proof of Vercel function cold starts; use Vercel request metadata for those.

## Verified prior server-reader evidence (October 30, 06:24–06:54 UTC)

| Reader | Observed individual duration |
|---|---|
| Home getMenuControlCenter | 1,411–4,720 ms |
| Home getSnapshot | 755–2,212 ms |
| Home getAttentionItems | Mostly 34–106 ms, one 250 ms |
| Money readAllPosRows.salesSources | 893–994 ms |
| Home getSupervisorChatReadiness | Usually 109–505 ms; one 2,661 ms |

These measurements predate PR 1. Readers overlap; do not add their durations.
Browser route p50/p75/p95, RSC request counts and a correlated slow tap are
**not yet available** because PR 1 was not deployed. A new Vercel runtime log
query returned HTTP 403 in the implementation session. Baseline N for browser
navigation is zero, so percentiles must remain unreported (not assumed zero).

## Owner-approved production/test-café validation

On named phone and desktop devices/networks, test fresh document loads and at
least 20 **sampled** warm navigations per route: Home, Money Recovery and Profit,
Menu, Operations, Staff, More, café settings, Toast, and Home chat start. Include
period changes and any failed/timeout navigation. Query Vercel `[nav-timing]`
and existing `[reader-timing]` logs. Group by route, device and document/client,
and report N, nearest-rank p50/p75/p95 for feedback, usable and TTFB, missing
feedback/timeout rates and RSC request counts. Correlate one slow `trace` with
server `request` and reader phases plus browser requests; inspect a DevTools
network capture for duplicate requests. Avoid recording owner identifiers or URL
queries in notes. Verify telemetry adds only its sampled beacon and does not
materially worsen latency against an unsampled run. Do not tick PR 1 until this
real browser verification and required green CI have both happened.

Ownership: this PR does not touch Claude's events files, pricing or calculations,
financial reader data paths, POS writes, migrations or cron routes.
