Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is a scoped PR. Other work keeps its published dependencies; the
three Events Fix A/B/C workstreams below may be built in parallel after the planning PR merges.
**Owner focus (Oct 30): the Events dashboard is P0 alongside app-wide responsiveness P0.**
Keep Events search, automatic monitoring, UI and performance PR scopes separate.
**Separate-chat playbook:** [docs/plans/app-wide-performance.md](docs/plans/app-wide-performance.md) — each numbered item has its own copy/paste prompt, prerequisites and acceptance checks. Work from the latest main; the plan is not permission to merge or deploy.

## Open issues (any agent can pick one up)
Each item says what is wrong, where, and how to check it. Before starting, read AGENTS.md and the
rules at the end of this section. One item = one small PR. Tick it here in the same PR.

### Owner priorities (Oct 30) — do these first, in this order
1. [ ] **"Where is my money going?"** The chat can already split costs into ingredients, staff, card
   fees and bills (`get_cost_summary`), recorded expenses by category (`get_expenses`) and recurring
   bills (`get_bills`), and the Money screen's Profit & costs tab shows the same split. Gaps: the
   system prompt in `lib/ai/agent/loop.server.ts` never points this question at those tools; there is
   no golden owner question for it; nothing ranks the biggest single expenses; Today is blank before
   closeout (see "Supervisor chat start" below). Fix: add it as a golden owner question with exact
   numbers checked on the chat and Money screen paths, add the prompt mapping, then ask it on the test
   café. Missing buckets must say "missing", never zero.
2. [ ] **Events stabilization — P0: reliable automatic intelligence and a real Events dashboard.**
   **Owner-verified production prerequisite (Oct 30):** Events SQL/schema is applied, the
   `EVENTS_LOOKAHEAD_ENABLED=true` flag is deployed, and the currently selected café
   passes the demo/timezone eligibility check. Do not ask the owner to rerun SQL or
   reconfigure these. The saved Halloween event and AI-written plan are visible.
   **Code status:** Earlier nearby-events PRs 1–12 are merged/implemented, including
   #291 (6), #292 (7), #303 (8), #304 (10), #306 (11), #305 (12).
   The older unfinished PR/migration notes below were stale; they are replaced here.
   Preserve all saved events, histories, verified changes, proposals and owner decisions.

   **Observed production failure:** Vercel `/api/cron/events-lookahead` logs on Oct 30
   ~21:27 UTC show `nearby_events_search_failed`: 3 of 3 initial research queries
   failed, including 25-second timeouts and an HTTP-200 OpenAI response marked
   `incomplete` / `max_output_tokens` at 1,200 tokens. The cron reached the search
   stage; this does not prove all stages or cafés failed. Missing saved events must
   not be presented as "none found" when research failed.

   **Owner's revised contract, superseding conflicting historical Events plan text:**
   AI discovers/verifies events, produces concise evidence-backed insights, observes
   actual café data automatically on the event day and reports afterward; owners do
   **not** have to select "Use this plan", "Track", or check off recommendations.
   Never ask whether free chocolates/toffees, decorations, extra preparation or other
   physical suggestions were carried out. Do not ask marketing follow-ups for now.
   AI may recommend combos/discounts; report implementation only when identifiable
   in Toast menu/item/discount data, otherwise say unverified. Never pretend an
   observed sales change was caused by an event. All actual business changes (POS,
   menu, staff, schedule, purchasing, outbound messages) still need separate owner
   approval, per AGENTS.md. Read-only monitoring does not grant or fake approval.

   **Start THREE separate PRs in parallel after this planning PR merges.**
   Each starts from latest `main`; one owner per PR; no cross-scope edits. **UI is
   the highest owner-facing priority.** Do not change `AGENTS.md`, migrations,
   POS import/sync code, production flags, or add a duplicate event reader/monitor.

   - [x] **Events Fix A — cron search reliability (search files only).**
     Own: `lib/events/nearbyEventsSearch.server.ts`, `lib/events/nearbyEvents.ts`
     when needed, and search tests. Make the existing OpenAI web search reliably
     produce valid sourced results with bounded retries/fallbacks for 200-incomplete,
     reasoning-only, 25s timeout and partial success; log privacy-safe failure
     classes. Respect the AGENTS.md 1,200-token ceiling unless the owner explicitly
     approves a change (the open D4 decision is *not* approval). Failed/partial
     searches must not be stored as complete; keep previously saved event facts
     and avoid paid search on Home open. Regression tests: recorded response
     fixtures for incomplete, timeout, partial, all failed, empty valid success,
     bounded retries and dedupe. **No** writer/cron route, lifecycle, UI, locale
     or migration edits. Send any scan-status writer follow-up to B.

   - [x] **Events Fix B — automatic read-only observation & Toast-backed reports.**
     Own: `lib/events/eventsLookahead.server.ts`,
     `lib/events/eventLiveWatch.server.ts`,
     `lib/ai/supervisor/loop/eventReadiness.server.ts`,
     `lib/events/eventFinalReport.server.ts`, their tests, and the existing
     monitoring cron only if necessary. A saved event/AI insight must be watched on
     its scheduled day, with mid-run facts and next-day report, **without owner
     approval of observation**. Reuse ONE Supervisor loop, existing reports/inbox,
     canonical Toast hourly sales, item sales, menu, named discounts, and available
     shift evidence; distinguish missing, provisional and verified data.
     Add a backward-compatible, nullable **AI-judged importance** to the *existing*
     saved event insight/proposal payload if needed for UI sorting (no new table);
     UI C reads it via the canonical Events reader. Do not infer that the owner
     implemented a suggested combo, discount or physical preparation.
     Do not ask physical-action questions. Do not automatically commit a draft
     proposal as though the owner approved it; preserve manual approval and audit
     trails for any business effects and all other Supervisor capabilities.
     Reruns must not duplicate monitors, reports or notices or rewrite history.
     Tests: future vs event day vs next day, auto-observation without approval,
     partial/missing Toast, distinct named discount/combo evidence, no unauthorized
     approval/POS write, rerun idempotence. B alone adds an Oct 30 owner-decision
     addendum to `docs/plans/nearby-events.md` (keep historical PR 1–12 text).
     **No** edits to A search files or C-owned UI/API/reader/localization.

   - [ ] **Events Fix C — rich Events-first Home UI (owner P0).**
     Own: `components/home/SavedEventsCard.tsx`,
     `components/home/ChatStart.tsx`, `components/home/SupervisorChatComposer.tsx`,
     `components/home/eventDayThread.ts`, `lib/operating/board.ts`,
     `app/[locale]/page.tsx`, `messages/{en,es,ar}.json`, and UI/board tests.
     Only C may extend `lib/data/cafeEvents.server.ts` or
     `app/api/events/saved/route.ts` for canonical *read-only* display metadata.
     EVERY Events entry point opens the SAME in-place Events panel, not chat.
     Rich, legible artifact cards show the saved AI reasoning, dated event and
     source/verification, usual busy hours *labeled estimate*, preparation
     recommendations as plain insight cards (not disabled checkboxes), and
     actual observations/reports as they become available.
     **Past / Today / Upcoming** tabs and calendar: Past reports newest-first;
     Today live actual/provisional readings; Upcoming next 7 days sorted by
     saved AI importance by default (date toggle), beyond 7 days chronological;
     unknown importance => chronological, never invented rank. Day/date drilldown
     stays in panel with back navigation. On Oct 30 Halloween Oct 31 appears
     **Upcoming**, never "Running" or "day 0"; on Oct 31 it is Today and on
     Nov 1 Past. Do not duplicate the Events insight in generic Running text
     or chat. Remove "Use this plan"/Track and physical checkboxes. Only an
     intentional "Chat about this" opens the day thread, **without** automatic
     raw JSON, full-plan text or a duplicate approval card. Visible retry for
     API errors; missing research, empty verified result, stale and partial
     data are not conflated. No web search from Home.
     Tests: date boundaries (Oct 30/31, Nov 1), all tabs/entry points, importance
     and date sorting, within-panel details, no involuntary chat or approval,
     empty/error/retry, 360–430px + desktop, EN/ES/AR RTL, accessibility.
     **Visual acceptance gate:** attach before/after desktop + 390px mobile
     screenshots of the test café's Halloween flow (Oct 30 Upcoming, Oct 31
     Today, Nov 1 Past), including expanded detail and report cards; inspect
     overflow, contrast, scrolling and tap targets against the approved mockup.
     No merge based on unit tests alone if the screen remains a text-only link.
     **No** edits to A/B writer, search, monitor, Toast, migration files.
     C may be coded in parallel but **merge B before C** so removing the
     approval control cannot strand existing monitoring in production.

   **Shared integration contract:** All three consume the same saved Events
   identity/facts and canonical data readers, same Supervisor report/inbox
   lifecycle, and the same café-local date. B supplies optional importance;
   C handles older saved rows without it. To avoid `PROGRESS.md` conflicts, each
   implementer edits only *their own checkbox* here and rebases onto latest main
   before final review; the owner-decision plan addendum belongs to B only.
   All PRs require behavioral regression tests, `npx tsc --noEmit`,
   `npm run lint`, `npm test`, `npm run build`, green final-head CI,
   independent Codex review and fixes for all P1s; no autonomous merge,
   production deploy or SQL. Acceptance after owner-approved rollout: real and
   test café, EN/ES/AR and mobile/desktop, correct event-day transitions,
   no silent failures, no duplicated output, no unauthorized actions.


3. [ ] **PR #319 — Finish all three Pantry/recipe persistence gaps in ONE PR (owner scope, Oct 30).**
   Do not mark #319 ready to merge solely because the current UI works or CI is green.
   The three owner-identified remaining issues below belong to #319 together; do not
   split them into three follow-up PRs or silently defer one in the PR description.
   - **Recipe ingredient order stays where inserted.** The adjacent "+" must place
     the new recipe ingredient immediately below the tapped row **after save, reload,
     and reopening the same product/size**. Currently the saved reader in
     `lib/data/pantry.server.ts` sorts by ingredient ID and the recipe write
     appends a new row. Introduce one durable per-size recipe row order through a
     backwards-compatible, additive schema field and the existing canonical
     recipe read/write path; preserve old recipes with a deterministic fallback.
     Retain optimistic concurrency, duplicate protections and other-size isolation.
     Test add-middle → save → refresh/reopen, multiple inserts, move/replace/remove,
     and unchanged ingredient amounts and cost calculations.
   - **Remember the original purchase-pack breakdown.** Entering
     `12 × 32 fl oz` must reopen as `12 × 32 fl oz`, rather than only its
     normalized `384 fl oz` total. Store optional original pack factors/units as
     additive metadata on the existing ingredient-price record; continue to use
     the existing normalized quantity and canonical cost-per-base-unit calculation
     as the financial source of truth. Older normalized records must remain valid:
     show them as recorded totals, never fabricate an original case breakdown.
     Preserve original `case(100)`/`case(1000)` meanings and EN/ES/AR parsing,
     price edits and conversions. Test create → save → reload → price edit → reload
     with identical cost, and old records without metadata.
   - **Safe Pantry archive instead of destructive delete.** Add an explicit
     reversible **Archive ingredient** action, not a raw delete/cascade. The current
     ingredient relationships can delete recipe lines, prices or stock/purchase
     history if the ingredient itself is deleted. Use an additive archive marker,
     tenant-scoped/RLS-safe actions, and hide archived items from *new* selections
     while preserving existing recipes, historical purchases, prices, sold-item
     economics and reports. Expose an appropriate restore path. Archive must not
     erase historical facts or silently remove recipe ingredients. Test archive →
     history still readable and unchanged → absent from new picker → restore,
     including cross-café access denial and referenced ingredients.
   **Shared #319 acceptance:** one coherent migration/reader/action/UI change,
   never a second recipe reader, pricing formula or destructive data rewrite.
   Migration must be additive, idempotent where applicable, RLS-safe, reviewed
   and owner-approved before **production application**; no self-deployment.
   Include actual save/reopen tests on desktop and 390px mobile (EN/ES/AR/RTL),
   full final-head `npx tsc --noEmit`, `npm run lint`, `npm test`,
   `npm run build`, green CI and latest-head Codex review with P1s fixed.
   Mark this single checkbox complete only when **all three** work end-to-end.

### Owner actions
- [x] Apply migrations 123 (drop owner-initiative tables), 124 (`toast_today_live`), 125 ("needs a look" cleanup) in Supabase.
- [x] Decided (Oct 30): screen numbers (profit, labor cost, card fees, break-even, item cost) come only from their `lib/metrics/core` tools; everything else may be read with `describe_data`/`query_data` and computed with `calculate` (AGENTS.md 7.2).

### Today's live sales (owner priority)
- [x] Chat doesn't use the live reading for "today's sales". The system prompt in `lib/ai/agent/loop.server.ts` never maps today questions to `get_today_so_far`, so the model calls `get_sales`, which only knows closed days. Fix: add the mapping; and in `lib/ai/agent/tools/coverage.ts` / `tools/index.ts`, when the period is today and not imported, return the live reading from `ctx.readTodaySoFar()` with `provisional: true` and its read time.
- [x] Home may skip the live reading. `app/[locale]/page.tsx` shows it only when `vm.coverage.actualDays===0`; a $0 or not-final row for today would hide it. Errors there are swallowed (`.catch(()=>null)`). Fix: use the live reading whenever today's closeout import isn't in; log an error category (never data); if no saved reading for the current business day, call `todaySoFarForBusiness` with a 4-second timeout. Check: `select business_date, sales_data_status, net_sales_cents from daily_rollups where business_date = current_date;`
- [x] (#242) Money screen's "today at a glance" card (`lib/viewmodels/todayGlance.ts`, `components/money/CostRecoveryView.tsx`) uses closed days only; read the live reading through `lib/data/todayLive.server.ts`.
- [ ] Test café copy (`.github/workflows/sync-cafe-data.yml`) runs every 30 minutes, so its live reading often shows "Not live". Optional: run every 15 minutes.

### Speed — app-wide responsiveness (owner P0, Oct 30)
- [x] (#244–#247) Screens load slowly. Measure first: timing logs (names and ms only) around each reader on Home, Money and the Toast page. Then: run independent reads in `Promise.all`; wrap repeated per-request lookups (`getActiveBusinessId`, `readSupervisorCafeIdentity`, `getSnapshot`) in React `cache()`; don't run `getMenuControlCenter`'s 90-day order-line scan on Home unless needed. No change to numbers.

- [x] **Home: `getAttentionItems` takes 16.5 s of a 21.5 s load** (Vercel timing log, Oct 29 22:49, real café). Everything else on Home is ~3 s (`getSnapshot` 2.6 s and `getMenuControlCenter` 2.9 s, in parallel). In `lib/attention/getAttentionItems.server.ts` five reads run one after another: `readUsageVariance` → translations → `getPosConnectionStatus` → `readPersistedOperatingTasks` → `getOpenAlerts` + `getCatalogMatchReview`. Prime suspect: `readUsageVariance` (`lib/data/usageVariance.server.ts`) pages through a whole week of `order_lines` joined to `orders` (up to 20,000 rows, 1,000 per request) plus an RPC, only to show "used more than expected" cards. Fix, in order: (1) wrap each of the five in `timeReader` to confirm; (2) start the independent ones together in one `Promise.all`; (3) take the usage check off the page load — read a saved weekly result (e.g. computed by an existing cron such as `/api/cron/refresh-derived`) or skip it on Home and show it on the Menu/Pantry screen. No change to the numbers. Check: Home under 4 s in the timing log.
- [x] **Production timings collected and triaged (Oct 30, diagnostic task only).** Vercel production logs (06:24–06:54 UTC, two deployments) confirm Home `getMenuControlCenter` at 1,411–4,720 ms, `getSnapshot` at 755–2,212 ms, Money `readAllPosRows.salesSources` at 893–994 ms, and Home `getAttentionItems` mostly 34–106 ms (one 250 ms). This validates the earlier attention fix, **not** an end-to-end speed fix. Logs do not measure browser interaction or full navigation time.
- [ ] **P0/PR 1 — Measure real click-to-screen latency throughout the app.** Add privacy-safe client navigation/button timings and server request correlation, without logging customer data or altering calculations. Cover Home, Money, Menu, Operations, Staff, More/settings, Toast page, and chat start, on phone and desktop. Record warm/cold TTFB, usable content, click feedback, request count and p50/p95 by route in Vercel. Check: slow taps can be mapped to a specific client/server stage; no duplicate instrumentation/data readers.
- [ ] **P0/PR 2 — Home must not wait for full 90-day pricing economics.** `app/[locale]/page.tsx` calls `getMenuControlCenter({includeSalesEvidence:false})`, but the shared `getMenuControlCenter` still runs `getPricingInputs` (90-day `orders`, daily facts and item quantities). Profile that reader's sub-stages and add only the necessary lightweight projection **within the existing canonical reader**, for Home attention; no new pricing path or changed price/attention results. Check: lower Home menu-reader p95 and exact Home/Menu/chat parity for the same café/period.
- [x] **P0/PR 3 — Optimize canonical snapshot and authenticated identity reads.** Home `getSnapshot` still takes 755–2,212 ms. Measure its constituent reads and repeated authentication/café identity round trips, safely reuse request-scoped lookups through existing canonical readers, honor RLS. Check: lower warm snapshot p95 and unchanged money/coverage numbers. Separate shell rendering is PR 5.
- [ ] **P0/PR 4 — Period/buttons should feel instant without stale data.** `components/shared/PeriodSwitch.tsx` calls both `router.replace` and `router.refresh`; investigate duplicate Home GETs and avoid redundant navigations while retaining the documented stale-render fix. Show selected/pending feedback immediately, preserve `?thread=` and browser Back/Forward, and avoid repeated full-page requests for a single tap. Check on real and test cafés: Today/Week/Month update URL and all three amounts correctly, one intended data navigation per tap.
- [x] **P0/PR 5 — Render a responsive shell while secondary data loads.** Home waits for full snapshot/menu and then its attention/board/live reads; chat readiness and auxiliary cards should not freeze the interface. Use the existing canonical results with React/Next 16 streaming/Suspense only where semantics and auth are safe. Check: the page and controls become usable promptly, slow secondary tasks show truthful placeholders, correct data replaces them, no stale/zero fabricated money or broken chat state.
- [x] (#280) **P1/PR 6 — Money: remove unnecessary full-order scan.** `app/[locale]/money/page.tsx` currently executes `readAllPosRows.salesSources` (~0.9–1.0 s) even for Recovery, while only Profit & costs consumes `salesSources`. Skip or defer that evidence when not used, and measure the canonical `getSnapshot` path. Check: both views, Today live, source labels and exact Home/chat/Money amounts stay correct.
- [ ] **P1/PR 7 — Operations first load must be read-only and fast.** `app/[locale]/operations/page.tsx` reads a snapshot plus the full Menu model and synchronizes `operating_tasks` during page rendering. Keep existing TeamInbox client-only teammate switching; remove render-path writes using the existing approved derived refresh flow (cron change only if explicitly scoped/approved). Check: fast initial navigation, matching Home/Operations attention counts, no dropped or duplicated tasks.
- [x] **P1/PR 8 — Menu: load the catalog first, details on demand.** `app/[locale]/menu/page.tsx` awaits the full pricing/sales-evidence `getMenuControlCenter` and then `getMenuCatalogPhotos`. Profile 90-day order-line evidence, quantities, signed-photo URLs and payload size; defer nonessential detail/evidence **inside the same shared reader** rather than inventing another calculation. Check: catalog browsing and opening an item are responsive; prices, recipe costs and sales evidence still agree with chat.
- [ ] **P1/PR 9 — Staff first load and schedule interactions.** Profile Staff navigation, `getWeekSchedule`, `staffReadScope` and render-time `syncStaffRuleAlerts`; fix only the dominant measured bottleneck. Preserve permissions, existing schedule approvals and rule alerts. Check: improved Staff p75/p95 and unchanged scheduling behavior.
- [x] **P1/PR 10 — More/settings and café profile responsiveness.** Profile More badge and shared settings/auth reads, then fix only the worst confirmed bottleneck. No second café settings or currency path. Check: badge, profile, locale and security behavior unchanged.
- [ ] **P1/PR 11 — Toast connection/diagnostics page responsiveness.** Profile the page and its user-visible actions; improve only view-layer waits or loading/result states. Do not touch Toast import, reconciliation, fee calculation, cron, migrations or POS writes. Check: responsive controls and accurate action outcomes.
- [ ] **P2/PR 12 — Vercel/Supabase production latency and safe caching.** Validate Vercel function/database regions, cold starts, repeated server calls and cache behavior from measurements. Only one justified scoped change with owner approval for production settings; no cross-café cache or extra fact path. Check: lower measured latency with same data, auth and freshness.
- [ ] **P2/PR 13 — App-wide performance regression guardrails.** Add reproducible performance browser tests for Home, periods, Money, Menu, Operations, Staff, More, Toast and chat start (desktop/mobile, realistic data, EN/ES/AR). Define stable environment-specific readiness thresholds and privacy-safe reporting. Check: CI/smoke test proves no serious speed regression without false failures from network noise.

**Performance acceptance targets (to validate, not guarantees):** visible tap feedback within 100 ms; warm navigation usable within 400 ms at p75 / under 1 s at p95; Home usable within 1 s at p75 / 2 s at p95 under a defined test network/device. Network calls and first uncached page loads cannot reliably finish in microseconds. Report browser and server percentiles separately; never trade correctness, privacy, or accurate freshness labels for speed.

**Completion rule:** Each unchecked numbered line has a standalone chat prompt in the playbook and a separate small PR. Tick it only in the PR implementing and testing it, with required typecheck, lint, tests, build and green CI. PR 8 follows PR 2; PR 5 follows PR 3; PR 13 follows P0 fixes. Web search stays with Claude.
- [ ] Supervisor chat "reloads" mid-answer. In `components/home/SupervisorChatComposer.tsx`, when a turn runs past `CONTINUATION_BUDGET_MS` (75 s, `app/api/ai/threads/[threadId]/agent/route.ts`) the server sends `ack` with `mode: "continuation"` and the client clears the streamed text and steps (`setStreamedText(""); setLiveSteps([])`), so the half-written answer vanishes and restarts. A dropped stream also clears it and hands over to the watcher. Fix: keep the text shown so far and append the continuation; show "Still working…" instead of clearing. Also make turns shorter (slow tool reads are the root cause; see the item above). Check: an answer that takes over 75 s never blanks.

### Team inbox (Operations)
- [x] Home said "18 things need you" but "See all" opened Operations with almost nothing in Needs you. Cause: Home counts the shared attention list (`getAttentionItems`: alerts, missing bills/fees/sales, unmatched items, POS reconnect, tasks); Operations showed only `operating_tasks`. Fixed: Operations Needs you is the same list, for the same period, split by teammate; each teammate card shows their count and top item (`needsYouFromAttention` in `lib/viewmodels/operationsTeam.ts`). Check: Home count = Operations Needs you count.
- [x] Switching teammates on Operations took 10–15 s and could error until a hard refresh. Cause: every tap reloaded the whole page on the server, which re-read snapshot + menu and rewrote every `operating_tasks` row; any failed write errored the page. Fixed: all cards render once and a teammate/tab tap filters them in the browser (`components/operations/TeamInbox.tsx`, URL kept via `history.pushState`); the sync skips rows that didn't change (`taskRefreshChangesRow`); a failed sync falls back to a read-only view. Check: switching teammates makes no server request.
- [ ] Operations first load still re-reads snapshot + menu and runs the task sync. Next: move the sync into `/api/cron/refresh-derived` so the page is read-only like Home.

### Toast data
**Owner priority (Oct 30): the database filled up (762 MB, app down) because every re-import stored every Toast record again.** Owner cleaned the copies by hand (now ~200 MB, both cafés). One PR each, in order; Toast sync stays paused (`TOAST_AUTO_IMPORT_ENABLED=false`) until the first two are deployed:
- [x] **Store only new or changed Toast records.** Migration 128 (`toast_archive_incremental`): a re-import marks unchanged records as seen instead of copying them; the import commit moves them to the latest run so fees and order details stay complete; a failed import never moves them. Card-fee refresh writes only payments whose fee changed. Check: `scripts/toast-archive-incremental-sql-integration.sql` (owner applies migration 128).
- [x] **Fill missing days and values by themselves, only what is missing.** `lib/pos/toast/missingDays.ts` (replaces the hourly fee re-pull): every hour it finds days with no import, a failed or incomplete import, or orders but no saved payments, and re-pulls only those days, newest first, 5 per hour; a day already queued is left alone and each retry waits longer (1h, 2h, 4h … at most daily). The day check (`reconcile.ts`), which downloads the whole day from Toast, now runs hourly instead of every 9 minutes while waiting for another day's re-import, and once a day for a payment whose order Toast never returned. Toast Analytics is never required.
- [x] **Archive keeps each order once; the day check never downloads the day again.** Migration 129: the archive stores only the full order (its checks and payments stay inside it; nothing read the separate check/payment rows), and the card-fee trigger reads payments from inside the latest import's orders. `reconcile.ts` checks the day saved at import and asks Toast only for its payment list (the independent check); it downloads the day only for days imported before the archive existed. Owner applies 128 then 129; existing check/payment rows are removed in the later cleanup.
- [x] **Test café mirrors the real café.** `scripts/sync-cafe-data.mjs` now compares every business day of every mirrored table between the two cafés (all history, not the last 8 days) and replaces only the days that differ, so late timecards or re-pulled days reach the test café and unchanged days are never rewritten. Also copies per-payment fees and details, open Toast timecards, voids and refunds. The Toast scheduler already skips the test café (its mapping has no `verified_at`). Links between rows (menu item, employee, location) are compared in the test café's own ids, so a corrected link is copied too, and Toast timecard ids carry the test café's restaurant id, so a finished shift is never shown twice. Check: `scripts/sync-cafe-data-db-integration.mjs` (real schema, in `toast-db-integration.yml`).
- [x] **The AI reads every Toast field.** Migration 130: new view `cv_toast_records` has one row per Toast record (order, check, item, modifier, payment, discounts, service charges from the latest import of each day; labor, cash, kitchen, menus and setup lists from the daily capture), with every field Toast sent (already cleaned of guest names, contacts, card details and notes) in `data`. `query_data` reads single fields by name (`data.server.guid`, sum of `data.price`), and `describe_data` with `record_type` lists the field names with an example each. Results are capped (~1.5k tokens). The archive table stays closed to app users; the AI reads it only through `toast_records_for`, which checks that the signed-in user owns the café and reads only the dates asked. Check: `scripts/ai-toast-records-sql-integration.sql`.
- [x] **Test café gets the Toast archive and daily captures.** `scripts/sync-cafe-data.mjs` copies each day's latest imported orders (not older versions), a completed copy of the import run each day points at, and the newest capture of labor, cash, kitchen, menus and setup (never a second copy of orders). Typed order details are rebuilt in the test café by the archive's own trigger, so `cv_toast_records`, discount names, modifier prices and order times answer the same as the real café. Also fixed: timestamps lost their microseconds when copied, so every day with a timestamp was rewritten on every run.
- [x] **Labor: Toast is the source of truth (owner rule, Oct 30).** Migration 132: a Toast shift takes Toast's wage, hours and edits every sync. A shift Toast sends without a wage (salaried job, or no wage set, e.g. the online-orders login) is $0, as in Toast; the app's staff wage is never filled in. App edits, and app/CSV/planned shifts for the same person and time, are replaced by Toast's version; a shift Toast deletes is removed. Pay = Toast regular hours × wage + Toast overtime hours × wage × 1.5 (`OVERTIME_PAY_MULTIPLIER`, `lib/calc/staff.ts`; Toast does not send the multiplier), split over midnight by paid time. Saved shifts are corrected once and their days queued for cost recompute. Payroll tax still uses the café's saved rate (Toast's labor data has no taxes). Check: `scripts/toast-pos-copy-sql-integration.sql`, `lib/pos/timecardDay.toastPay.test.ts`. Owner applies 132 in Supabase.
- [ ] One copy: the daily capture also saves `orders/v2/ordersBulk`, `orders/v2/orders` and `orders/v2/payments` into `toast_raw_samples`, a second copy of the archive's orders. Stop capturing those three (the archive has them) and delete the old rows in the cleanup.
- [ ] Verify the processing-fee backfill (#235) a day after deploy: every imported day should have payments saved. Check: `select business_date, count(*) from toast_payment_facts where business_date >= current_date - 14 group by 1 order by 1;` and `card_fees_status` in `daily_rollups` should be `actual`/`estimated` with a non-zero fee on sales days.
- [ ] After migration 125, the "needs a look" list should hold only real problems. If days stay `pending` with `rate_limited` for long, the reconcile retries in `lib/pos/toast/reconcile.ts` may need backoff.
- [ ] `toast_payment_facts.fee_basis` has no `default_rate` value; default-rate estimates are stored as `missing` with `fee_status = estimated` (#235). Add the value in a future migration.
- [ ] Add payments, time entries, stock and cash to the live read; live checks every ~30 minutes while open (4d part 2).


### Financial truth: three parallel PRs (owner decision, Oct 30)
**Owner-approved parallel exception to the sequential Next queue.** Prepare **three independent PRs** from latest `main` with the file ownership below. Do not stack them; do not introduce duplicate data readers, POS importers, calculators, AI agents, cron jobs or financial paths. These fixes address the discovered production discrepancies; old [x] entries mark merged implementations, not confirmed live correctness. Each PR follows AGENTS.md and requires review, all checks, and owner-only merge/deployment approval.

**Diagnosis / acceptance fixture — Oct 12 and Oct 14, 2026:**
- SOURCE has 6 and 7 canonical Toast timecards, respectively. Migration 132 correctly makes each day's Toast NULL-wage online-order-account shift **$0/hour** in canonical timecards. TEST has all the same 13 provider shift GUIDs but still has **NULL** wages on those two shifts. The Toast restaurant GUID in `pos_timecard_id` is intentionally remapped; **never compare the unmodified full ID** across cafés. An order's server account is not itself a clocked shift.
- SOURCE daily labor status is now **actual** on both days (Oct 14 was initially **missing** and then refreshed). TEST remains **missing** on both; Oct 12 wage rollup totals previously differed by **136 cents**, which must be reconciled, not automatically attributed only to NULL-vs-zero.
- Oct 12 processing fees: both **5357 cents actual**. Oct 14: SOURCE **5464 cents actual**, TEST **0 cents estimated**. Toast payment `originalProcessingFee` is already parsed; actual fees, including verified actual $0, win over owner/default estimates. Don't re-pull SOURCE Toast because the TEST copy is stale.
- Previous sync audit contained a `day_mirror` SQLSTATE **23503** (FK failure). Owner has since run a manual **full_copy**: inspect the **latest** GitHub workflow run and DB audit first; do not assume it succeeded or failed. A failing mirror transaction rolls back. `full_copy` covers every day in `REFRESH_WINDOW_TABLES`, but **does not refresh existing insert-if-missing master/owner records**.
- The prior October Supervisor break-even answer mixed monthly figures (**27,692.54/month**, **893.31/open day**) with rolling “**28 of 30 days**” labor coverage. Money, Plan and Chat assemble inputs differently. The normal `get_break_even` result lacks structured `explain`, hiding “How I got this”; missing costs can be rendered as an insufficiently labeled known-cost floor.

#### Fix 1 / PR A — Toast canonical completeness, daily refresh and missing-data recovery
- [x] **Implement/source-data correctness.** **Own only:** scoped `lib/pos/toast/*` labor/fee/recovery files, `lib/pos/rollup.ts`, `lib/pos/timecardDay.ts`, necessary existing labor-status helpers and their tests. **Excluded:** `scripts/sync-cafe-data*`, `lib/viewmodels/*`, Supervisor agent tools, break-even core. Migrations/cron changes require evidence and separate owner approval.
- **Do:** trace raw Toast staging → employee link → canonical timecard → refresh queue → `daily_rollups`. Raw wage NULL means Toast omitted it, but a successfully imported Toast wage NULL is canonical $0 under migration 132; distinguish missing/unlinked shifts, staged `needs_match`, pending refresh and genuine incomplete data. Detect **partial** labor gaps, not only dates with zero timecards; use one existing bounded, idempotent recovery mechanism, not another scheduler. Preserve Toast-authoritative pay/hours/overtime/edits/deletes and café-local midnight allocation; actual Toast per-payment fees must take precedence over estimates. Do not repull already-complete Toast days or duplicate archives.
- **Pass:** six/seven SOURCE shifts with valid two $0 wages; wages/tax/status reflect current canonical records after refresh; partial missed labor is eventually retried; no stale “missing” after successful recompute and no fabricated zero for genuinely absent shifts; existing actual fees remain actual. Behavioral and SQL integration tests cover these states.

#### Fix 2 / PR B — SOURCE-to-TEST complete, safe and verified mirror
- [x] **Implement/test-data parity.** **Own only:** `scripts/sync-cafe-data.mjs`, its unit/DB integration tests and `.github/workflows/sync-cafe-data.yml`. **Excluded:** Toast importer/rollup/recovery files, metrics/viewmodels, AI tools.
- **Do:** inspect the latest owner-triggered `full_copy` and audit; identify the exact **23503 constraint and table** with safe diagnostics and repair FK ordering without disabling integrity. Preserve atomic day replacement. Group clocked shifts by **café-local business day** rather than database `clock_in::date` (Oct 14 local shift can start Oct 15 UTC). Ensure economic source facts propagate through both refreshed-day and existing insert-if-missing master records: employee links, bills/rates, orders, wages, rollups and payment fees. Preserve intentional TEST-specific IDs, access/identity, chat history, credentials and **no live Toast connection**; never copy sensitive tokens. Use mapped references for parity and avoid repeated archived record storage.
- **Pass:** a full copy followed by incremental sync succeeds, is idempotent and shows **committed** parity. All 13 provider shifts and two $0 wages match; Oct 12/14 wages, loaded labor, tax/status and **5357/5464-cent actual fees** match SOURCE; resolve/explain the prior 136-cent wage difference; source/test comparison ignores intentionally remapped identifiers. Failure leaves no partial copy. Real-DB integration tests verify.

#### Fix 3 / PR C — ONE canonical break-even result for Money, Plan, Chat and explanation
- [x] **Implement/financial one-path parity.** **Own only:** `lib/data/supervisorEconomics.server.ts`, existing `lib/viewmodels/moneyViewModel.ts` / `breakEvenViewModel.ts`, `lib/metrics/core/breakEven.ts` and parity tests, `lib/ai/agent/tools/money.ts` / `explain.ts`, `components/home/HowIGotThis.tsx`, directly related tests/translations. **Excluded:** `lib/pos/*`, mirror scripts, migrations, crons. Draft **PR #309** already changes Supervisor economics; explicitly coordinate/supersede its month-coverage fix instead of merging two competing paths.
- **Do:** eliminate duplicate period/input preparation without making a third reader: use existing `lib/data/dailyFacts.server.ts` for daily business facts and canonical current pricing/bills/fee readers; one period-aware inputs path and one `lib/metrics/core` break-even result for all consumers. Include monthly recurring/recorded bills, labor wages + employer payroll taxes + owner payroll extras, ingredient/product costs and **verified Toast fees**; distinguish actual/estimated/missing, rolling calibration from calendar-month labor coverage, as-of date, café timezone and open-day divisor. Missing costs must yield a labeled **known-cost floor/partial estimate**, never an unqualified complete answer. Preserve `docs/05-calculations.md` fixtures and distinguish drinks/day from sales/month; if existing definitions conflict, ask the owner which survives per AGENTS.md §3 rather than silently choosing.
- **Do:** attach deterministic formula, source provenance, exact cents, units, coverage and inputs as structured `explain` to the standard `get_break_even` result; AI only narrates, never recalculates. Ensure `acceptedExplainLines` validates and “How I got this” renders.
- **Pass:** for identical café/month/as-of, Money/Plan/Supervisor/tool/explanation agree in **exact integer cents**, source labels, labor coverage, date range and open-day count. October answer cannot pair “28 of 30” rolling coverage with a 31-day monthly divisor. Golden owner questions cover zero-wage shifts, incomplete/refreshing labor, actual versus estimated Toast fees, source/test fixtures and explanation visibility.

**Parallel merge contract:** each PR owns its files only, starts independently from latest main, documents cross-lane blockers in its PR rather than editing another lane. PR #310 also edits `PROGRESS.md` (Events), so **only tick your own checkbox**, and rebase the shared document before sequential owner merges. Do not weaken tests to pass; run `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, integration tests and independent review with no P1. No automatic merges/deploys. After all three merge and owner approves rollout, jointly validate these two real dates and run identical-period screen/chat golden questions before marking overall financial parity complete.


### Supervisor chat start (Home key numbers) — found on the test café
- [ ] Today shows Sales but "Known business costs" and "You keep" are blank (—). Cause: before closeout, Sales comes from the live reading, but costs and profit come from `buildProfitAndCostsViewModel` (`lib/viewmodels/moneyViewModel.ts`), and `profitForPeriod` (`lib/metrics/core/profit.ts`) returns null when the period has no closed day with `sales_data_status='actual'`. So Today is always — until closeout. Fix: on Today before closeout, show known costs so far (today's share of bills + labor recorded so far + card fees on the live sales) and You keep from the live sales, labeled provisional, through `lib/metrics/core` (no new formula). Wire in `app/[locale]/page.tsx` where `costs`/`kept` are set.
- [ ] Today / Week / Month to date buttons "don't work" on the test café. On demo data (no Supabase) they work: each tap changes the URL to `?period=week|month` and all three numbers change (checked with Playwright). So the cause is specific to the live café data or an open chat thread. Check first, on the test café: (1) does the URL change after a tap? If not, look at `components/shared/PeriodSwitch.tsx` (`router.replace` + `router.refresh`) with a `?thread=` in the URL. (2) If the URL changes but numbers stay blank, run `select business_date, sales_data_status, net_sales_cents from daily_rollups where business_id = '719af528-af8e-4203-bb25-4c118c9ff832' and business_date >= current_date - 31 order by 1;` — Week/Month costs need at least one `actual` day; if the copy job (`scripts/sync-cafe-data.mjs`) brings rows without `actual`, fix the copy. (3) A slow Home render can look like a dead tap: check the `Home` timing logs (#244).
- [x] Some Supervisor answers are blank: only "Supervisor" and Helpful / Not helpful show (owner, Oct 29: "what is my breakeven cost?", "monitor for 7 days"). Cause: when the whole reply is a question, `lib/ai/agent/persist.server.ts` saves only the question card (no text, so it isn't shown twice), and `clarifyCardState` (`components/home/supervisorChatBehavior.ts`) hid every card without option buttons, i.e. all typed-answer cards (`facts`, `fill`). Fixed: every card kind shows; an older typed-answer card keeps its question instead of "Skipped". Check: `components/home/questionOnlyReply.test.ts` (a question-only reply of each card kind is never blank).

### Where the money goes (owner request, Oct 30)
The owner wants to see exactly where her money goes. The Money screen has the breakdown ("From sales to pocket": ingredients, staff, card fees, each bill, you keep); the Supervisor chat start shows only three totals.
- [ ] Chat start: tapping "Known business costs" opens the same breakdown as the Money screen, from the same view model (`buildProfitAndCostsViewModel` in `lib/viewmodels/moneyViewModel.ts`, rendered like `components/money/ProfitCostsView.tsx`). No new calculation. Check: every line and total equals the Money screen for the same period.
- [ ] Ingredients by ingredient: split the single "Ingredients and cups" line into the biggest ingredients (milk, coffee, cups…) from recipes × items sold, through `lib/metrics/core`. Items with no recipe show as one "not broken down" line, never hidden.
- [ ] Biggest changes vs last period: the 3 cost lines that moved most (e.g. "card fees up $120"), from the same breakdown for both periods; only when both periods have the data (partial periods labeled).

### One path (AGENTS.md rule 3)
- [x] (#243) Fold the row mappers in `lib/data/getPricingInputs.ts` and `lib/data/supervisorEconomics.server.ts` into `rowToDailyFacts` (they already read through `lib/data/dailyFacts.server.ts`).
- [x] (#254) Chat's menu list reads `menu_items` itself (`menuCatalog` in `lib/ai/supervisorReads.server.ts`) instead of the Menu screen's `lib/data/getMenuItemsForEdit.ts`. Make one shared menu reader both use. Check: chat and Menu screen list the same items and prices.
- [ ] Café settings (currency, timezone, is_demo) are read from `businesses` in ~10 places (`getCafeProfile`, `snapshot.server`, `readSupervisorCafeIdentity`, `getPricingInputs`, `staffReadScope`, `dailyBrief`, `getMoreBadges`, supervisor loop `goal`/`menuPriceChange`/`priceExperiment`). Add one `readCafeSettings(businessId)` reader (React `cache()`d) and switch callers to it.
- [ ] `suggestPrice` (price math) lives in `lib/calc/pricingEngine.ts`; move it to `lib/metrics/core/` per AGENTS.md, with no change to results.
- [ ] Screen-vs-chat equality: `lib/metrics/core/metricsParity.test.ts` covers profit, labor, fees and break-even on a fixture; add cases for period/coverage preparation (partial weeks, missing days) so both paths must agree.
- [ ] Remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts`; merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts`.

### Supervisor chat asks the same question twice
- [x] Owner, Oct 29: "raise the latte 10¢" → picked a latte on the card → what-if answer → "draft price change approval" → asked "which latte?" again. Cause: `newResolveState` (`lib/ai/agent/resolve.ts`) trusted a card pick only on the message right after the card; later, the price-change and menu tools accept a product only if the owner names it again or types one of a few fixed "yes, do it" phrases. Fixed: the pick on the latest choice card stays trusted (`recentChoiceIds`) for that exact record until a newer choice card is shown or the owner names the item again (any word from that card's options, e.g. "latte", "iced"); then their own words decide, as before. It never resolves a different item. Check: `lib/ai/agent/rememberCardChoice.test.ts` replays the owner's conversation.
- [x] A reply that is only a typed-answer question (`facts`/`fill` card) was invisible to the AI on the next turn: the history built in `app/api/ai/threads/[threadId]/agent/route.ts` kept text blocks and choice cards only. Fixed: one `historyContent` (`lib/ai/agent/history.ts`) adds those cards as "Question card (owner answers in its form): <question> Fields: …"; choice cards keep the exact "Asked: … Options:" form the pick memory reads. Check: `lib/ai/agent/history.test.ts`.

### Universal answers (owner-approved design, Oct 30; AGENTS.md 7.2)
The AI works out how to answer any question; no new tool or scenario per question type. One PR per step, in order. **Plan, file scopes and new-chat prompts: `docs/plans/universal-answers.md`** (its PR 1 = Step 3, PR 2 = Step 5, PR 3 = Step 6, PR 4 = Step 7).
- [x] Step 4: AGENTS.md rule 7.2: no arithmetic in the model's head; screen numbers from `lib/metrics/core`; all other math through `calculate`, steps shown.
- [ ] Step 3: one general `calculate` tool: + − × ÷, sum, percent; every input from a tool result or saved owner fact; inputs, formula and steps shown, labeled calculation or estimate; test that it never rebuilds a screen number.
- [ ] Step 5: owner answers saved once, used everywhere. Ask only ingredient %, payroll, bills, card fee %, opening hours. Save each where the calculators already read it (ingredient % → `target_ingredient_cost_rate`; payroll → payroll extras; bills → recurring costs; card fee → fee plan). Use only where real data is missing, per day and per item, labeled estimate; real data replaces it automatically. Every other gap is a one-line note, not a question.
- [ ] Step 6: test that the same fact is never asked twice.
- [ ] Step 7: retire one-off fixes: drop the "ingredients 20%" branch (`fix/cost-summary-ingredient-percent`, never merged); once `calculate` works, retire `simulate_scenario`'s fixed options.

### Rules for any agent working on these
1. AGENTS.md is the only source of agent instructions; follow it.
2. One path: daily totals only via `lib/data/dailyFacts.server.ts`; today's live sales only via `lib/data/todayLive.server.ts`; money math only in `lib/metrics/core/`. Never add a second reader or a second fee rate.
3. Don't touch `lib/pos/toast/*`, `supabase/migrations/*` or cron routes unless the item names them. No new migration without the owner. Never write to Toast or any POS.
4. Never block an answer because a day is flagged or Toast Analytics is missing; show the number with one short note.
5. Don't loosen, skip or delete tests; test behavior, not source text; list every changed test in the PR with a reason.
6. Before a PR: `npx tsc --noEmit -p .`, `npx eslint app lib components`, `npx vitest run`, `npx next build`. Merge only with CI green and the review clean.
7. Owner-facing text in en/es/ar message files; never hard-code a currency; never log secrets or customer data.

## Now
- [x] Set `OPENAI_API_KEY` in production before deploying #216 (receipts and statements now always use OpenAI).
- [x] Owner: apply migration 122 (RLS on `businesses`, merged in #220) to production: `alter table public.businesses enable row level security;`
- [x] Owner: set `DAILY_BRIEF_ENABLED=true` in Vercel production to turn on the morning brief (#226).
- [x] Owner: apply migrations 123 (drop empty owner-initiative tables, #231), 124 (live today reading, #238) and 125 ("needs a look" cleanup, #240). The code works before 124 is applied (it reads Toast live).

## Next — the AI reads all POS data (AGENTS.md 4b)
- [x] 4a. Daily capture of every Toast endpoint (#218). Owner: run it once by hand, then set the repository variable `TOAST_DAILY_CAPTURE_ENABLED=true`.
- [ ] 4b. Point the canonical views (#212) at that store, so cash, stock, kitchen and dining options are fresh; add views for the remaining endpoints.
- [ ] 4c. Merge `describe_data` / `query_data` (#212) with a dictionary entry for every source; screens move to the same readers.
- [ ] 4d. "Today so far" live layer: provisional, replaced at closeout.
  - [x] Chat reads today's Toast sales live when asked (`get_today_so_far`, read-only, not stored, 3-minute cache). The old poll (`lib/pos/toast/poll.ts`) was never switched on: it needs four flags and an outside scheduler, and it writes to a staging table the chat does not read.
  - [x] Saved reading every 15 minutes (`/api/cron/today-live`, table `toast_today_live`); Home's Today sales and the chat read the same one (#238).
  - [ ] Add payments, time entries, stock and cash to the live read; wire the Money screen's "today at a glance" card to it (done in #242).

## Next — the operator loop (AGENTS.md 4–5)
- [x] One experiment system: the Supervisor loop. Owner initiatives deleted (#229, tables dropped by #231); goals (#230), goal check-ins (#232) and a price-test orders guardrail (#233) added to the loop.
- [x] Operating Board: "Running" (waiting on your POS change, or day X of Y) and "Recent reports" on `ChatStart`, from the Supervisor loop tables. Mid-run early read comes with the mid-run updates item.
- [ ] Inbox + notifications: final reports (existing), mid-run updates (#225) and the morning brief (#226) are each an `operating_tasks` item plus a chat message. Left: an unread badge on the board (needs a "seen" timestamp, so a migration).
- [ ] Proactive monitor:
  - [x] Morning brief once per café per day in the latest thread: yesterday's sales, known costs, what was kept, and how many things need the owner (#226; off until `DAILY_BRIEF_ENABLED=true`).
  - [ ] Live checks every ~30 minutes while open, with duplicate suppression and a daily cap (after 4d part 2).
- [x] Mid-run experiment updates: one halfway message in the experiment thread plus a watching inbox item (#225).

## Next — Toast data answers every question (owner priority)
- [x] Sales answers use imported Toast days even when a day is flagged (#234).
- [x] Processing fees: Toast's fee per payment, estimates only for gaps, hourly re-pull of days imported before payments were saved (#235).
- [x] One reader for saved daily totals, used by every screen and chat tool (#236).
- [x] Toast page: Re-pull and "Looks right" say exactly what happened (#237); Toast Analytics is an optional line (#239).
- [x] "Needs a look" lists real problems only; stale flags cleared (#240, migration 125).
- [ ] Row mappers folded (#243). Left: decide whether ad-hoc data queries may answer sales/fee numbers (canonical views are a second path).

## Later
- [ ] Email delivery of inbox items.
- [ ] Currency: remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts` (`formatCents` callers, BillsManager, etc.). More page and card-fee setup done in #227.
- [ ] Merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts` into `lib/metrics/core`, with parity tests.
- [ ] Rolling conversation summary; tool-result size cap enforced in code.
- [ ] Add `npm run smoke:agent` (live owner smoke test run by the owner before release).
- [ ] Browser push, Toast webhooks, "always allow" per action type, WhatsApp/SMS sending once a verified business sender exists.

## Done (last 10)
- PR #240: "needs a look" lists real problems only; stale `changed_snapshot` flags cleared (migration 125).
- PR #239: Toast Analytics is a small optional line for cafés without it.
- PR #238: live today's sales, saved every 15 minutes, same number on Home and in the chat (migration 124).
- PR #237: Toast page actions say exactly what happened.
- PR #236: one reader for saved daily totals across screens and chat.
- PR #235: processing fees from Toast for every day; only gaps estimated.
- PR #234: sales answers use imported Toast days even when flagged.
- PR #233: price tests watch total café orders.
- PR #232: goal check-ins.
- PR #230: goals in the Supervisor loop.
