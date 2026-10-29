Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Open issues (any agent can pick one up)
Each item says what is wrong, where, and how to check it. Before starting, read AGENTS.md and the
rules at the end of this section. One item = one small PR. Tick it here in the same PR.

### Owner actions
- [x] Apply migrations 123 (drop owner-initiative tables), 124 (`toast_today_live`), 125 ("needs a look" cleanup) in Supabase.
- [ ] Decide: may the chat's ad-hoc data queries (`describe_data`/`query_data`, canonical `cv_*` views) answer sales/fee numbers, or only the main tools? Today they are a second path.

### Today's live sales (owner priority)
- [x] Chat doesn't use the live reading for "today's sales". The system prompt in `lib/ai/agent/loop.server.ts` never maps today questions to `get_today_so_far`, so the model calls `get_sales`, which only knows closed days. Fix: add the mapping; and in `lib/ai/agent/tools/coverage.ts` / `tools/index.ts`, when the period is today and not imported, return the live reading from `ctx.readTodaySoFar()` with `provisional: true` and its read time.
- [x] Home may skip the live reading. `app/[locale]/page.tsx` shows it only when `vm.coverage.actualDays===0`; a $0 or not-final row for today would hide it. Errors there are swallowed (`.catch(()=>null)`). Fix: use the live reading whenever today's closeout import isn't in; log an error category (never data); if no saved reading for the current business day, call `todaySoFarForBusiness` with a 4-second timeout. Check: `select business_date, sales_data_status, net_sales_cents from daily_rollups where business_date = current_date;`
- [x] (#242) Money screen's "today at a glance" card (`lib/viewmodels/todayGlance.ts`, `components/money/CostRecoveryView.tsx`) uses closed days only; read the live reading through `lib/data/todayLive.server.ts`.
- [ ] Test café copy (`.github/workflows/sync-cafe-data.yml`) runs every 30 minutes, so its live reading often shows "Not live". Optional: run every 15 minutes.

### Speed
- [x] (#244–#247) Screens load slowly. Measure first: timing logs (names and ms only) around each reader on Home, Money and the Toast page. Then: run independent reads in `Promise.all`; wrap repeated per-request lookups (`getActiveBusinessId`, `readSupervisorCafeIdentity`, `getSnapshot`) in React `cache()`; don't run `getMenuControlCenter`'s 90-day order-line scan on Home unless needed. No change to numbers.

### Toast data
- [ ] Verify the processing-fee backfill (#235) a day after deploy: every imported day should have payments saved. Check: `select business_date, count(*) from toast_payment_facts where business_date >= current_date - 14 group by 1 order by 1;` and `card_fees_status` in `daily_rollups` should be `actual`/`estimated` with a non-zero fee on sales days.
- [ ] After migration 125, the "needs a look" list should hold only real problems. If days stay `pending` with `rate_limited` for long, the reconcile retries in `lib/pos/toast/reconcile.ts` may need backoff.
- [ ] `toast_payment_facts.fee_basis` has no `default_rate` value; default-rate estimates are stored as `missing` with `fee_status = estimated` (#235). Add the value in a future migration.
- [ ] Add payments, time entries, stock and cash to the live read; live checks every ~30 minutes while open (4d part 2).

### Supervisor chat start (Home key numbers) — found on the test café
- [ ] Today shows Sales but "Known business costs" and "You keep" are blank (—). Cause: before closeout, Sales comes from the live reading, but costs and profit come from `buildProfitAndCostsViewModel` (`lib/viewmodels/moneyViewModel.ts`), and `profitForPeriod` (`lib/metrics/core/profit.ts`) returns null when the period has no closed day with `sales_data_status='actual'`. So Today is always — until closeout. Fix: on Today before closeout, show known costs so far (today's share of bills + labor recorded so far + card fees on the live sales) and You keep from the live sales, labeled provisional, through `lib/metrics/core` (no new formula). Wire in `app/[locale]/page.tsx` where `costs`/`kept` are set.
- [ ] Today / Week / Month to date buttons "don't work" on the test café. On demo data (no Supabase) they work: each tap changes the URL to `?period=week|month` and all three numbers change (checked with Playwright). So the cause is specific to the live café data or an open chat thread. Check first, on the test café: (1) does the URL change after a tap? If not, look at `components/shared/PeriodSwitch.tsx` (`router.replace` + `router.refresh`) with a `?thread=` in the URL. (2) If the URL changes but numbers stay blank, run `select business_date, sales_data_status, net_sales_cents from daily_rollups where business_id = '719af528-af8e-4203-bb25-4c118c9ff832' and business_date >= current_date - 31 order by 1;` — Week/Month costs need at least one `actual` day; if the copy job (`scripts/sync-cafe-data.mjs`) brings rows without `actual`, fix the copy. (3) A slow Home render can look like a dead tap: check the `Home` timing logs (#244).

### One path (AGENTS.md rule 3)
- [x] (#243) Fold the row mappers in `lib/data/getPricingInputs.ts` and `lib/data/supervisorEconomics.server.ts` into `rowToDailyFacts` (they already read through `lib/data/dailyFacts.server.ts`).
- [ ] (in progress) Chat's menu list reads `menu_items` itself (`menuCatalog` in `lib/ai/supervisorReads.server.ts`) instead of the Menu screen's `lib/data/getMenuItemsForEdit.ts`. Make one shared menu reader both use. Check: chat and Menu screen list the same items and prices.
- [ ] Café settings (currency, timezone, is_demo) are read from `businesses` in ~10 places (`getCafeProfile`, `snapshot.server`, `readSupervisorCafeIdentity`, `getPricingInputs`, `staffReadScope`, `dailyBrief`, `getMoreBadges`, supervisor loop `goal`/`menuPriceChange`/`priceExperiment`). Add one `readCafeSettings(businessId)` reader (React `cache()`d) and switch callers to it.
- [ ] `suggestPrice` (price math) lives in `lib/calc/pricingEngine.ts`; move it to `lib/metrics/core/` per AGENTS.md, with no change to results.
- [ ] Screen-vs-chat equality: `lib/metrics/core/metricsParity.test.ts` covers profit, labor, fees and break-even on a fixture; add cases for period/coverage preparation (partial weeks, missing days) so both paths must agree.
- [ ] Remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts`; merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts`.

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
