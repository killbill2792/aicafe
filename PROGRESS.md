Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.
**Owner focus (Oct 30): app-wide responsiveness on Vercel is P0 ahead of new non-speed features.**
Nearby-events web-search repair is assigned separately to Claude; do not include it in speed PRs.
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
2. [ ] **Nearby events, holidays and readiness.** Full plan, rules and one prompt per PR:
   [docs/plans/nearby-events.md](docs/plans/nearby-events.md). First version shipped in #271; in
   production the web search fails (`nearby_events_search_unparsed`) and the advice is hard-coded. Next,
   in order: PR 1 search fix · PR 2 facts-only + AI plans and asks (with "Other") · PR 3 storage + one
   reader (migration, owner approves) · PR 4 find once / plan once job · PR 5 Home strip + events panel
   (Past/Now/Coming up, calendar) · PR 6 live watch · PR 7 report card · PR 8 distance (after decision D3) ·
   PR 9 chat about any event + answer anything (web search). Waves: {1,2,3,9} → {4,5} → {6,7,8}.
   - [x] Nearby events PR 1 — retry unparseable HTTP 200 searches, holiday-specific queries, outcomes and safe diagnostics; recorded-response tests. PRs 2–9 remain open.
   - [x] **Nearby-events PR 2 — facts only + AI plans/questions:** removed hard-coded event staffing advice; Home and chat use the same factual holiday/event and usual-hour evidence; owner answers can use an optional “Other” text response saved by event/year. PR 1 search repair, storage and monitoring remain separate.
   - [x] PR 3 implementation: event-readiness capability, RLS-backed storage, shared reader, saved-events chat tool (migration **not applied**, awaiting owner approval).
   - [x] **Nearby-events PR 4 — find once / plan once:** cron-only two-week Monday discovery, rolling daily/day-before checks, deduplicated café event facts, bounded Supervisor `propose_event_plan` drafts using the PR 3 approval lifecycle, day-specific chat threads and one Operations inbox item per day. Three-day-per-café daily cap, retry-safe delivery, cron auth and AI-access checks. Default-off pending owner-approved migration/rollout; baseline typecheck, lint, full Vitest, build and whitespace gate green (#284).
   - [x] **Nearby-events PR 5 — saved Home strip and events/day-plan panels:** past/now/coming-up calendar with grouped saved events, owner-approved loop plans, checklist ticks and event chat; the Home open uses only PR 3 saved readers (no search). EN/ES/AR; baseline checks green on implementation commit (final progress-only CI pending).
   - [x] **Nearby-events PR 9:** General read-only web search in Supervisor and event-day “Chat about this” threads.
   - [x] **Nearby-events PR 10 — durable 14-day research (#304):** first scheduled scan on any weekday covers 14 days; the daily cron adds only the entering day; Monday research adds late announcements without rewriting saved events, owner decisions or history. Implementation baseline **green** ([TypeScript, ESLint, full Vitest and production build](https://github.com/killbill2792/aicafe/actions/runs/41114495774)); [Codex review](https://github.com/killbill2792/aicafe/pull/304#issuecomment-6531537682) clean on implementation head. Migration `20261030000129_cafe_event_search_state.sql` remains **unapplied**, dependent on owner approval and migration 127; independent review and release still pending.

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
- [ ] **P1/PR 10 — More/settings and café profile responsiveness.** Profile More badge and shared settings/auth reads, then fix only the worst confirmed bottleneck. No second café settings or currency path. Check: badge, profile, locale and security behavior unchanged.
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
- [ ] Follow-up: the day check still downloads the whole day once per import to compare totals; compare against the saved archive instead.
- [ ] **Test café mirrors the real café.** `scripts/sync-cafe-data.mjs` copies only days that differ (all history, not an 8-day delete-and-recopy), including staff hours, card-fee payment rows and the other Toast-derived facts the app reads; the Toast scheduler skips cafés that are not connected.
- [ ] Verify the processing-fee backfill (#235) a day after deploy: every imported day should have payments saved. Check: `select business_date, count(*) from toast_payment_facts where business_date >= current_date - 14 group by 1 order by 1;` and `card_fees_status` in `daily_rollups` should be `actual`/`estimated` with a non-zero fee on sales days.
- [ ] After migration 125, the "needs a look" list should hold only real problems. If days stay `pending` with `rate_limited` for long, the reconcile retries in `lib/pos/toast/reconcile.ts` may need backoff.
- [ ] `toast_payment_facts.fee_basis` has no `default_rate` value; default-rate estimates are stored as `missing` with `fee_status = estimated` (#235). Add the value in a future migration.
- [ ] Add payments, time entries, stock and cash to the live read; live checks every ~30 minutes while open (4d part 2).

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
