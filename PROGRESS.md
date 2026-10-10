# Progress

State file so any agent (Claude Code, Codex, Kimi) can pick up where the last one stopped.
Read `CLAUDE.md` (or `AGENTS.md`) first, then this file, then only the `docs/` files the next task needs.

## Milestones

## PR #17 new-ingredient operational units follow-up (2026-10-03 — code complete)

1. Let brand-new Weight and Volume ingredients choose Shot and Pump respectively in the recipe
   matrix, with the same inline exact-conversion requirement as existing ingredients.
2. Create the first new-ingredient recipe line with the existing
   `newConversionBaseUnitsPerUnit` input, then reuse the created ingredient/conversion for every
   other size without changing schema, pricing, catalog, inline price, or AI Team code.
3. Add focused unit/conversion regressions and run typecheck, lint, tests, build, and diff checks;
   then push one follow-up commit to PR #17.

Result:
- [x] Brand-new Volume and Weight ingredients expose Pump and Shot respectively, render the same
  inline exact-conversion field, and never infer a conversion.
- [x] The operational-unit size is saved first with `newConversionBaseUnitsPerUnit`; sequential
  sizes reuse the name-matched ingredient and its stored conversion rather than creating copies.
- [x] Typecheck, lint, 299 tests, and diff checks pass. Build remains blocked only by this
  environment failing to fetch the three existing Google Fonts.

## Final Menu UX pass (2026-10-03 — code complete)

1. Move selling-price editing into each size card, including exact-size deep-link focus and the
   existing deterministic suggestion/action behavior.
2. Restore ingredient-specific Pump/Shot choices and require/persist an inline conversion before a
   recipe using a previously undefined operational unit can be saved.
3. Redesign grouped Menu catalog cards with batched tenant-scoped product photos and clear tinted
   pricing/recipe health, without schema or calculation changes.
4. Run typecheck, lint, tests, build, and diff checks; capture the changed web UI if the environment
   supports it; then commit and open the follow-up PR. No dependency or migration added.

Result:
- [x] Every size edits its displayed selling price in place, including deterministic suggestion
  copy, Save/Cancel, and exact-size deep-link scrolling/focus.
- [x] Volume ingredients offer Pump and weight ingredients offer Shot; missing ingredient-specific
  conversions are collected inline and persisted before recipe lines, never guessed globally.
- [x] Grouped catalog cards use one batched tenant-scoped photo/signing load, a warm placeholder,
  prominent product/size/pricing details, and green or amber owner-readable health panels.
- [x] Typecheck, lint (one pre-existing product-photo `<img>` warning), 296 tests, and diff checks
  pass. Build is blocked only by the environment failing to fetch the three existing Google Fonts.
  No browser runtime is installed, so a screenshot could not be captured.

## PR #14 Phase 4B final correction pass (2026-10-02 — code complete)

1. Preserve the first product-photo anchor by resolving photos across every same-family item id,
   and strengthen migration 24 with a tenant-scoped menu-item foreign key.
2. Finalize the two-tab grouped workspace, exact-size price deep links, truthful grouped active
   state, manageable inactive sizes, and coverage-aware sales totals.
3. Make recipe units conversion-aware and stage the entire recipe editing session behind one Save
   recipe / Cancel pair without changing recipe or pricing math.
4. Correct Alex's deterministic high/low copy and exact-size Overview link, add focused regressions,
   then run typecheck, lint, tests, build, and diff checks. No dependency or new migration.

Result:
- [x] Product photos resolve an existing immutable sibling anchor, with tenant-scoped database
  integrity in migration 24 and a regression for adding a lexicographically earlier sibling UUID.
- [x] The product workspace has only Overview / Recipe, exact-size price deep links, honest grouped
  state, manageable inactive sizes, and coverage-aware Today / 7-day / 30-day sales totals.
- [x] Recipe additions, edits, removals, and new-ingredient lines share one staged Save recipe /
  Cancel session; physical and stored ingredient-specific operational units are the only choices.
- [x] Alex uses deterministic low/high copy and the exact Overview editor link in en/es/ar.
  Typecheck, lint (one pre-existing product-photo `<img>` warning), 293 tests, and diff checks pass.
  Build is blocked only by failed Google Fonts fetches; no browser runtime exists for a screenshot.

## Phase 4B — grouped product workspace (2026-10-02 — code complete)

1. Rebuild product detail from current main as one grouped product workspace with compact all-size
   overview cards, period sales, focused exact-size price editing, and URL-backed recipe focus.
2. Add an all-size recipe matrix with size-specific add/remove/edit, ingredient type/search/create,
   and failure-safe batch saves using the existing conversion rules.
3. Add tenant-owned shared product photos with a private Storage bucket and additive RLS migration,
   plus tenant-safe grouped rename and regression coverage.
4. Refine deterministic AI task sentences/deep links and the warm desktop navigation without
   changing Phase 4A calculations or mobile navigation architecture.
5. Run typecheck, lint, full tests, build, and diff checks; commit, push the fresh branch, and open
   a clean PR. No dependency added; existing Next.js, Supabase Storage, and UI facilities suffice.

Result:
- [x] Product detail is one stable, size-sorted workspace with all-size overview cards, canonical
  Today/7-day/30-day quantities, exact-size price editing, and URL-backed recipe size focus.
- [x] The recipe matrix supports direct per-size quantities/units, per-size add/remove, type-filtered
  existing ingredient search, inline creation, and explicit partial-save failure reporting.
- [x] Grouped renaming is an atomic tenant-checked database action; private product photos are shared
  by the size family and support upload/change/remove through additive migration 24 (not applied).
- [x] AI work is sentence-first with deterministic supporting facts and entity-preserving links;
  desktop navigation uses the warm chocolate/tan treatment without changing mobile architecture.
- [x] Typecheck, lint, 287 tests, and `git diff --check` pass. Production build is blocked only by
  the environment failing to fetch the existing Figtree, Fraunces, and IBM Plex Sans Arabic fonts.
  No browser runtime is installed, so a screenshot could not be captured.

## PR #12 Phase 4A final correctness follow-up (2026-10-02 — code complete)

1. Suppress all Break-even what-if output without a valid base and make the missing-cost action use
   the first named category's real workflow.
2. Limit history-based cost expectations to the immediately previous month and regular categories,
   while restoring fresh-café Getting Started detection from actual setup data.
3. Add focused regressions, run typecheck/lint/full tests/build, and commit one small follow-up. No
   migrations, pricing/recipe changes, or dependencies.

Completed with a previous-month/regular-category expectation rule shared by the snapshot and alert
generation, category-aware Break-even recovery, no what-if projection without a valid baseline, and
fresh-café detection based on the absence of known setup data. `npx tsc --noEmit`, `npm run lint`,
and all 285 tests pass. `npm run build` remains blocked only by the environment's inability to fetch
the existing Google Fonts.

## PR #12 Phase 4A correctness follow-up (2026-10-02 — code complete)

1. Share expected-cost and category-destination rules across Break-even, Home, Leo, alerts, Bills,
   and typed expense entry.
2. Make meal-break review links open the exact employee/day and format timestamps in the café
   timezone and active locale, including business-day-safe alert generation.
3. Exclude partially priced recipes from contribution ranking and add an explicit recipe edit mode
   for quantity/unit changes with Save and Cancel.
4. Add regressions, run typecheck/lint/full tests/build, and commit one follow-up to PR #12. No
   migration and no new dependency.

Implemented the shared expected-cost rule and category-aware destination, exact employee/day shift
review, business-timezone alert dates/times, READY-only menu ranking, and size-specific recipe-line
quantity/unit editing. Added regressions for unused Repairs, partially priced recipes, category
routing, and Pacific-time rendering. `npx tsc --noEmit`, `npm run lint`, and all 281 tests pass.
`npm run build` remains blocked only by this environment failing to fetch the three Google Fonts.

## Phase 4A — owner truth + product detail redesign (2026-10-02 — code complete)

1. Make Home and Break-even missing-data states honest, rank only complete menu recipes, and label
   alert impact as an estimate with the calculation explained.
2. Reconcile generated alerts against current source truth and split Leo missing-cost work into one
   stable, category-focused task per missing category.
3. Add deterministic pricing-task snoozes using the existing JSON payload, including due/current and
   materially-changed lifecycle coverage.
4. Replace Product Detail with a single selected-size workflow: hero, Overview/Recipe/Pricing,
   focused product/recipe editors, and a secondary size-management surface.
5. Localize en/es/ar, add regression coverage, then run typecheck, lint, full tests, build, and a
   browser screenshot. No dependencies and no database migration.

Implemented all five areas without schema changes or new dependencies. Generated alert cleanup now
resolves only still-open derived rows and keeps owner-dismissed/resolved history. Pricing snoozes are
payload-only and reconciliation reopens a timed task only while its exact deterministic recommendation
remains current. Verification: `npx tsc --noEmit`, `npm run lint`, and `npm run test` (276/276) pass.
`npm run build` reached the production compile but the environment could not reach Google Fonts for
Figtree, Fraunces, or IBM Plex Sans Arabic. No browser/screenshot tool is installed in this environment.

## PR #7 follow-up #2: negative-day "all yours" bug, estimate labeling on the calendar, integer-cent avg order value, 48px nav targets, localized milestone names, like-for-like comparisons (2026-10-02 — code complete, pushed to owner-comprehension-pass)

Six more review findings before PR #7 merges:

1. **`computeTodayContribution()` could say "all yours" on a loss day.** It checked
   `cumulativeBeforeToday >= totalCents` before checking `contributionCentsToday <= 0` — so a café
   whose bills were covered as of yesterday but lost money today still got `allYours: true`.
   Reordered: the zero/negative check now runs first, unconditionally. Tests cover all three cases
   from the review (negative today after everything covered, zero today after everything covered,
   genuinely positive today after everything covered still says "all yours") at both the pure-calc
   level (`lib/calc/costRecovery.test.ts`) and the `todayGlance` viewmodel level.
2. **Calendar daily profit didn't say when it used an estimated bill.** `buildMonthCalendarViewModel()`
   now carries `isEstimate` on both `DayCellState["actual"]` and `DayDetail` — true when any
   category feeding that day's running-cost share is an estimate (the current month's own flag, or
   the forced estimate a historical month's recurring fallback always carries). Since
   `categoryAmounts` doesn't vary day-to-day within one month, this is one flag computed once, not
   per day. The selected-day detail now shows the existing `EstimatePill` next to "Owner profit"
   when set — the number and formula are unchanged.
3. **Average order value broke the integer-cents rule.** `today.netSalesCents / today.ordersCount`
   produced fractional cents. New `averageOrderValueCents()` (`lib/calc/profit.ts`, tested) rounds
   half-up to the cent; `todayGlance.ts` uses it instead of the raw division.
4. **Calendar prev/next month buttons were 40px, not 48px.** `h-10 w-10` → `h-12 w-12` in
   `MonthCalendar.tsx`; same visual design, just the touch target.
5. **Calendar milestone bill names were English-only.** `bucketLabels` built from the hardcoded
   `RUNNING_COST_LABELS` catalog, so an es/ar milestone sentence could read "Rent se cubrió por
   completo." Now built from the existing `Categories` i18n namespace (already used the same way
   elsewhere, e.g. `more/bills`), which already covers every `RUNNING_COST_CODES` entry in all three
   locales — no new keys needed. Removed the now-unused `runningCostLabelFor()`. Checked live in
   Arabic/RTL.
6. **Trend/vs-last-period comparisons didn't check whether the comparison was fair.** A partial
   current week could still be compared against a sparse previous week, or a complete Today against
   a missing yesterday (an internal `$0 sales − bills` placeholder, never real data). New
   `periodComparisonState()` (`lib/viewmodels/periodComparison.ts`, tested against all 4 scenarios
   from the review) requires *both* the current and comparison period to be fully covered (reusing
   `periodCoverage` and the new `previousPeriodCoverage()` in `period.ts`) before any delta is
   trustworthy. Home's trend arrow is omitted when unavailable (same existing conditional, now fed a
   stricter flag); Money's whole "vs last period" section — not just the Owner Profit row — shows
   "Not enough sales data to compare periods yet." instead of rows when unavailable, since every
   compared metric suffers the same mismatch, not just profit. No dates are fabricated as zero-sales
   days anywhere in this.

No schema changes, no pricing/POS changes. Verified: `npx tsc --noEmit`, `npm run lint`, `npm run
test` (232/232 — 19 new), `npm run build` all clean. Live-checked on the real account: Week (4 of 7
days covered) now shows "Not enough sales data to compare periods yet." with zero comparison rows;
Today (both today and yesterday fully covered) still shows real comparison rows; the calendar's
month-nav buttons measure 48×48 in the DOM in both LTR and RTL, correctly mirrored.

## PR #7 follow-up: previous-period windows, truthful missing-sales presentation, real 28-day window, calMonth hardening (2026-10-02 — code complete, pushed to owner-comprehension-pass)

Four issues from independent review of the owner-comprehension pass, before merge:

1. **`previousPeriodDays()` was still row-position based** (`last28Days.slice(-2,-1)` for
   "yesterday", `slice(-14,-7)` for the previous week, `previousMonthDays.slice(0, monthActualDays.length)`
   for previous MTD) — the same class of bug already fixed for the *current* period, just not yet
   applied to the *comparison* period. Replaced with a single date-filtered implementation:
   `previousPeriodDays()` now reuses the already-correct `previousPeriodCalendarRange()` and filters
   `[...previousMonthDays, ...monthActualDays]` by date — never a slice. Regression tests
   (`lib/viewmodels/period.test.ts`) cover the exact review scenario (rows Sep 28/29/Oct 1, today
   Oct 2 → "yesterday" must resolve to Oct 1, not Sep 29) plus a previous-week sparse-date case and
   a previous-month-to-date gap case.
2. **Missing sales were presented as a confirmed loss.** `todayDay = zeroDailyFacts(...)` is correct
   internally, but rendering "$0 sales − today's accrued bills" as a precise red Owner Profit implied
   a result nobody has actually seen. New `ownerProfitDisplayState()` (`lib/viewmodels/ownerProfitDisplay.ts`,
   tested) classifies a period's owner-profit figure as `unavailable` (zero actual days of data —
   Home hero now reads "Waiting for today's sales," neutral color, no trend arrow, no "vs last
   period" row), `partial` (some but not all days covered — the real figure still shows, now with a
   "Partial" pill next to the label, on both Home's hero/You-keep tile and Money's Owner-profit
   summary box), or `complete` (normal, unchanged). The underlying bill accrual is untouched — this
   is presentation only, per the review's own framing.
3. **`last28Days` was the last 28 rows, not a real 28-calendar-day window** — same failure mode as
   the earlier `last7Days` fix, just never applied to the 28-day window the "last four weeks"
   forecast/averages (break-even, cost-recovery projections, Home's avg-drinks-per-day) all read
   from. `buildDayWindows()` (`lib/calc/dayWindows.ts`) now computes `last28Days` the same
   date-filtered way as `last7Days` (shared `lastNCalendarDays` helper); `snapshot.server.ts` uses
   it instead of `allDays.slice(-28)`. Every consumer gets the fix for free since they only ever read
   `snapshot.last28Days`.
4. **`calMonth` validation was too loose** — `/^\d{4}-\d{2}$/` accepted "2026-13" or "2026-00" before
   that string reaches the historical-month query. New `isValidMonthKey()`
   (`lib/viewmodels/monthCalendar.ts`, tested) requires a real month, 01–12; `money/page.tsx` uses it
   in place of the old inline regex. Single entry point (`calMonth` URL param → `money/page.tsx` →
   `CostRecoveryView` → `getMonthCalendar`), so no other validation point was needed.

No schema changes, no other behavior changed. Verified: `npx tsc --noEmit`, `npm run lint`, `npm run
test` (213/213 — 15 new), `npm run build` all clean. Live-checked on the real test account: Week's
Owner Profit now shows a "Partial" pill (4 of 7 days covered) on both Home and Money while still
showing the real -$4,171.14 figure; Today (which now has a real $0 row) correctly shows the plain
complete state with no pill.

## Owner comprehension pass: period correctness, profit color, calendar truth-telling, Today at a glance (2026-10-02 — code complete, pushed to owner-comprehension-pass, new branch off main after PR #6)

Explain the business, don't just display the data. Six changes, all on Home/Money, no pricing/POS/
schema changes:

**1. Period correctness (Today / Week / Month to date).** Root cause of "Today == Month to date"
looking like a bug: `snapshot.latestDay` was `allDays[allDays.length - 1]` (whatever row was most
recently inserted) and `last7Days` was `allDays.slice(-7)` (the last 7 *rows*) — both silently drift
from the real calendar day/week the moment a day has no rollup, which is common. Live-inspected the
real test account's `daily_rollups`: only 3 rows exist (Sep 28, 29, Oct 1), today is Oct 2 with no
row yet, so `latestDay` was quietly standing in Oct 1 for "today."
- New pure `buildDayWindows()` (`lib/calc/dayWindows.ts`, tested) replaces both: `todayDay` is
  today's real row or an explicit zero day for `todayDateStr` (`todayHasData: false` when no row
  exists — never substituted with yesterday), `last7Days` is actual rows filtered to the 7 calendar
  dates ending today (not a row-count slice). `monthActualDays` was already date-filtered correctly.
- `BusinessSnapshot.latestDay` renamed to `todayDay` + new `todayHasData: boolean` (all call sites
  updated: `homeViewModel`, `breakEvenViewModel`, `CostRecoveryView`, `period.ts`).
- Fixed two latent bugs this surfaced: `CostRecoveryView`'s "days before today" used
  `monthActualDays.slice(0, -1)` (wrong when today has no row — it would drop the real last day);
  `projectedDayContributions()` anchored "rest of month" projections to `monthActualDays.length`
  instead of today's real day-of-month (same failure mode). Both now filter/anchor by date.
- New `periodCoverage()` (`lib/viewmodels/period.ts`) → "Sales data available for 3 of 7 days this
  week." shown on Home and Money's Profit & costs view whenever a period is only partially covered
  (`Common.noSalesToday` / `salesCoverageWeek` / `salesCoverageMonth`).
- "Month to date" label was already in place in messages/*.json from an earlier session.
- Tests: `lib/calc/dayWindows.test.ts` covers all 4 requested regressions (first-day-of-month
  Today=MTD is valid, later date with gaps sums correctly, missing today never substitutes, week
  uses the real 7-day range not 7 rows). Live-verified: Week now shows the coverage note; Today/MTD
  on Oct 1 correctly read identical (both legitimately $0).

**2. Home owner-profit color.** Hero card and "You keep" tile were hardcoded `bg-good`/`text-good`.
Now use `profitTone()`/`profitToneBgClass()`/`profitToneTextClass()` (reused from the earlier
Money fix; new `profitToneBgClass` added for the full-bleed hero card, neutral = `bg-ink` not green).
Live-verified red hero at the real account's current loss.

**3. Money sign-aware pace copy.** "On track for -$20,744 in your pocket this month." replaced with
`paceLeft` / `paceShort` (absolute amount) / `paceBreakEven`, chosen via `profitTone`, colored to
match. en/es/ar.

**4 & 5. Money calendar truth-telling + previous months.** Replaced `MonthCalendarStrip` (every
actual day solid green, current-month-only) with `MonthCalendar.tsx`: each day's own owner
profit/loss (`netSales − ingredients − staff − cardFees − that day's running-cost share`, same
formula as docs/05-calculations.md's "Owner profit," reusing `runningCostsForPeriodCents` with
start=end=that date — not a second formula) decides green/red/neutral; a day with no rollup is a
distinct dotted "No data" state (never a fake $0); future days of the current month are a dashed
"Upcoming" state. Bucket-covered milestones (from the existing sequential-fill `computeCostRecovery`)
are a small separate badge icon, never the color. Tapping a day opens a detail card (sales,
ingredients, staff, card fees, rent & bills share, owner profit, milestone note) — pure client state,
no extra fetch. `‹ September 2026 October 2026 ›` navigates via a `calMonth` URL param (clamped to
never exceed the current month); `getMonthCalendar()` reuses the live snapshot for the current month
and otherwise calls the new `getMonthCalendarFromDb()` (`lib/data/monthCalendar.server.ts`), which
queries that month's own `daily_rollups`/`expenses`/`recurring_costs` (`active_from`/`active_to`
overlap) instead of today's. Important schema limitation found and handled: editing a bill
(`saveRecurringCost`) updates the `recurring_costs` row **in place** rather than versioning it, so a
past month's true bill amount can't be recovered once edited — any category that falls back to a
recurring row for a strictly-past month is therefore always forced `isEstimate: true` (current month
keeps the row's own flag). New pure viewmodel `lib/viewmodels/monthCalendar.ts` (tested: good/red
days, missing-vs-$0, future days, milestone independent of color). Live-verified against the real
account's actual `recurring_costs` rows (cross-checked by direct read-only query): September's
per-day running-cost share computed as $535.50 — independently confirmed by hand from the raw
`active_from`/`active_to` rows, including a messy set of overlapping test "other" rows the UI
correctly summed. "Next month" correctly disabled once back on the current month.

**6. "Today at a glance" replaces the cup-icon grid.** `TodayInCupsCard` (a wall of cup icons,
café-only) removed from both Home and Money. New `TodayAtAGlanceCard` + `buildTodayGlanceViewModel`
(`lib/viewmodels/todayGlance.ts`, tested) show sales/orders/average order/money-left-toward-bills as
a plain stat grid, plus at most one `FillIcon` + a sentence built from the existing cost-recovery
bucket math (`computeTodayContribution`, a cup-free sibling of `computeTodayInCups`, which is now
unused and removed along with its tests) — "Today's sales put $X toward Rent — Rent is now Y%
covered," or the crossed-bucket / all-covered / no-bills-yet / no-progress-today variants. Works
for any business type, not just cafés; `drinksCount` kept as a small optional secondary line.

Verification: `npx tsc --noEmit`, `npm run lint`, `npm run test` (198/198 — 20 new), `npm run build`
all clean. Live-checked on the real `mail2raj27@gmail.com` account: Home Today/Week/Month-to-date
(including the new coverage note), red hero/tiles on the real loss, Money's pace copy, the calendar's
colors/missing/upcoming states and day-detail reconciling exactly with Home's Today figure
(-$746.78), previous-month navigation with real historical data, and the glance card — in en, es,
and ar/RTL (375px/390px mobile), including the calendar's prev/next chevrons correctly mirrored
(`rtl:rotate-180`, matching the existing `BackHeader`/`ChevronRight` convention). Not merged.

## PR #6 follow-up: deterministic cent allocation for running-cost rows (2026-10-02 — code complete, pushed to menu-visual-refresh)

One remaining review finding: rounding each running-cost category's prorated amount independently
(the previous fix) guarantees integer cents per row but not that the rows *sum* to the same rounded
total the rest of the screen shows — e.g. three $100/mo lines in a 31-day month each prorate to
322.58...¢ for "Today"; independently rounding each gives 323×3 = 969¢, while the real aggregate
967.74...¢ rounds to 968¢. Fixed with the "largest remainder" method:

- New `allocateIntegerCentsByCategory(rawAmountsByCategory, targetCents)`
  (`lib/calc/runningCosts.ts`) — every category first gets `Math.floor(raw)`, then the few cents
  still needed to reach `targetCents` go to the categories with the largest fractional remainder
  first, ties broken by category code ascending (deterministic regardless of `Map` iteration
  order).
- `runningCostLinesForPeriod()` (`lib/viewmodels/period.ts`) now computes `targetCents` from
  `runningCostsForPeriod()` itself — the exact same aggregate call `totalCostsCents` is built
  from, per the review's "calculate the rounded aggregate target using the same aggregate
  running-cost calculation" — and allocates against it, instead of rounding each category alone.
  Missing categories are excluded from allocation entirely (never just zeroed after the fact) and
  stay 0.
- New tests: `lib/calc/runningCosts.test.ts` (pure `allocateIntegerCentsByCategory` — the exact
  three-$100-lines worked example from the review, a determinism/tie-break case, and an
  already-evenly-divisible case) and `lib/viewmodels/period.test.ts` (end-to-end through
  `runningCostLinesForPeriod`/`runningCostsForPeriod`, asserting `sum(amountCents) ===
  roundHalfUpToCent(runningCostsForPeriod(...))` and every row is an integer, for Today/Week/Month
  and a 5-line set including a missing category).

No other behavior changed. Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test`
(178/178 — 5 new, rest unchanged), `npm run build` all clean. Live-checked against the real test
account's Week view: running-cost rows now sum to exactly $3,604.65, matching `totalCosts −
ingredients − staff − cardFees`; Water shifted from $4.65 (previous independent-rounding result)
to $4.64 — the one-cent redistribution this fix makes to keep the total exact.



## PR #6 review fixes: integer cents, tea word-boundary, loss bar, touch target (2026-10-02 — code complete, pushed to menu-visual-refresh)

Four review findings, each independently scoped and fixed as described — no unrelated changes.

1. **`runningCostLinesForPeriod()` returned fractional cents.** It was deliberately left unrounded
   to match `totalCostsCents`'s "round only at display" pattern, but its output is consumed as
   data (summed, compared), not just displayed, so that violated CLAUDE.md's integer-cents rule.
   Now rounds each line with the existing `roundHalfUpToCent` at construction. New regression test
   using Fixture A's $500/mo insurance over a 30-day month (50,000 ÷ 30 = 1,666.6̄, a case that
   would surface a fractional-cents bug immediately) asserting every row is `Number.isInteger`.
2. **`inferMenuItemCategory`'s tea/chai/matcha rule matched substrings, not words.** `/tea|chai|matcha/i`
   matched "tea" inside "S**tea**med", so "Steamed Latte" incorrectly inferred `TEA`. Now
   `/\btea\b|\bchai\b|\bmatcha\b/i` — word-boundaried. New tests: `Matcha Latte`/`Chai Latte`/
   `Iced Tea` → `TEA`, `Steamed Latte` → `ESPRESSO_DRINK`.
3. **A loss showed an invisible 0-width "You keep" bar.** Its `widthPct` was computed from the
   signed `ownerProfitCents`, which clamps to 0 for any negative value — a real loss drew no bar
   at all, undermining "immediately obvious from both the number and color." New
   `flowBarWidthPct(valueCents, salesCents)` (`lib/viewmodels/profitTone.ts`) uses the magnitude
   for width while the signed value and `profitTone` still drive the displayed number and
   green/red color separately — a loss now draws a full-magnitude red bar. 4 new tests, including
   "a negative value still produces a visible (non-zero) bar."
4. **`AiUnavailableNotice`'s "Type it" link was under the 48px touch-target minimum** (`py-2.5`
   alone, no explicit height). Now `flex min-h-12 items-center justify-center`, matching the
   `+ Add`-style button pattern used elsewhere — confirmed live at exactly 48px with the label
   vertically centered. No other layout change.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (173/173 — 8 new, rest unchanged),
`npm run build` all clean.



## Pre-merge mobile visual fixes: Menu header wrap, Money FAB overlap (2026-10-02 — code complete, pushed to menu-visual-refresh)

Two CSS-only fixes from a live mobile-preview pass before merging PR #6. No functionality changed,
no logic touched — confirmed by the full test suite passing unchanged (165/165, 0 new).

**1. `LanguageSwitch` could wrap onto two lines ("EN / ES" stacking) at narrow widths.** Added
`whitespace-nowrap shrink-0` to its `<Link>` — it's a shared component, so every screen that uses
it (Menu, Money, Home, Staff, etc.) benefits, not just Menu. Also restructured the Menu page's own
`<header>` from a fixed `flex items-start justify-between` (which left too little width for the
actions column on narrow phones) to `flex flex-col gap-3 ... md:flex-row md:items-start
md:justify-between` — title/subtitle stack above a clean second row of "+ Add"/language-switch on
mobile, reverting to the original side-by-side layout at `md:` and up. Touch targets unchanged
(`+Add` still `min-h-12`, language switch still `h-11`, both pre-existing sizes). Verified live at
375px and 390px (en, es, ar/RTL) — no wrapping, clean two-row stack — and at 1280px desktop, where
the layout is pixel-identical to before.

**2. Money's fixed `+ Add cost` FAB overlapped the last card's content on mobile.** The Money page's
own `PageShell` padding (`pb-4`) wasn't enough to clear the FAB's mobile position (`bottom-[104px]`
+ its own 56px height = up to 160px of reserved space needed) on top of the shared layout's
`pb-24`. Changed Money's `PageShell` className to `pb-44 md:pb-16` (FAB and `AddCostFab.tsx` itself
untouched — same component, same position, just given enough room below it). Verified live at
375px on both Money tabs (Paying back bills, Profit & costs) in en/es/ar — scrolled to the true
bottom of the page in each case and confirmed the last real card (e.g. "vs last period" / "How this
works") sits fully above both the FAB and the bottom tab bar with visible clearance, no overlap, in
every locale including RTL.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (165/165, unchanged), `npm run build`
all clean.



## Cross-screen cleanup: Add Cost AI gating, Money/Staff shortcuts, period consistency, profit color (2026-10-02 — code complete, pushed to menu-visual-refresh)

Four small, independently-scoped fixes from live UI review. No schema changes. Preserves all Menu
owner-comprehension work from the prior entries below.

**1. Add Cost no longer lets an owner into a broken AI flow.** `/add-cost/receipt` and
`/add-cost/voice` now check `isAiConfigured()` server-side before rendering `ReceiptUploader`/
`VoiceRecorder` at all; when it's false they render a new shared `AiUnavailableNotice` ("Currently
unavailable" + plain-language body + a "Type it" link to `/add-cost/type`) instead — mirroring the
"not supported in this browser" fallback `VoiceRecorder` already had for missing `SpeechRecognition`.
The main `/add-cost` grid is untouched (still shows all 4 options; gating happens on
navigating into one, per the request). Capability-gated, not hardcoded off: as soon as an AI
provider key is configured, both routes render their normal flow again with zero code change.
Also replaced the `.env.local`-mentioning fallback error strings in `receiptReview.ts`/
`voiceReview.ts` (now unreachable in normal use since the page gate runs first, but left as a
defensive fallback) with owner-friendly wording, for the same reason.

**2. Management shortcuts now exist where owners actually look.**
- Money: new "Manage bills" button in the header (next to the language switch) linking straight to
  the existing `/more/bills` flow — `+ Add cost` and the FAB are untouched.
- Staff: new "+ Add staff" button in the header (same visual pattern as Menu's "+ Add") linking to
  the existing `/more/manage-staff` flow. No new component — `ManageStaffPanel`'s "Add a staff
  member" form is already the first thing on that page, and already auto-expands the just-added
  employee's row (which contains `WeeklyScheduleEditor`) on success, so schedule setup was already
  one tap away; this only makes the page itself easy to find from Staff. Verified live end-to-end:
  added a real employee, confirmed the schedule editor appeared immediately with no further
  navigation, saved a schedule, then deactivated the test employee to clean up.
- Every existing `/more` entry point remains; these are additional shortcuts, not replacements.

**3. Fixed: Money's running-cost rows didn't match the selected period.**
`buildProfitAndCostsViewModel()` already prorated running costs correctly for `totalCostsCents`/
`ownerProfitCents` (via the existing `runningCostsForPeriod`, an aggregate number), but returned
`snapshot.runningCostLines` — the full month's amounts — for display, so "Today" could show "Rent
$12,000" while the profit figure above it was computed from a ~1/31st share. New
`runningCostsForPeriodCentsByCategory()` (`lib/calc/runningCosts.ts`) does the same
monthly-amount ÷ days-in-month × overlap-days proration as the existing aggregate function, just
grouped per category instead of summed across all of them; new `runningCostLinesForPeriod()`
(`lib/viewmodels/period.ts`) uses it to rebuild `snapshot.runningCostLines` with each line's
`amountCents` scoped to the period, left unrounded (matching `totalCostsCents`'s own "round only
at display" convention) so the visible rows reconcile to the visible total. `moneyViewModel.ts`'s
`runningCostLines: snapshot.runningCostLines` → `runningCostLinesForPeriod(snapshot, period)` is
the entire behavioral change — no formula touched.
  - Verified Today/Week/Month are all genuinely different periods (not a routing/cache artifact —
    the existing `PeriodSwitch` already had a documented `router.refresh()` fix for that from an
    earlier milestone): live on the real test account (today = Oct 1), Today's Rent showed
    $387.10 (= $12,000⁄31), Week showed $2,787.10 (6 days of September at $400/day + 1 day of
    October), and Month to date showed $387.10 — identical to Today, correctly, since October 1
    is both periods' only elapsed day (see the request's own note: not a bug to "fix").
  - `Common.month` label changed from "Month" to "Month to date" (shared by Home's `PeriodSwitch`
    too, which already summed month-to-date days under the old label — a copy fix, not a behavior
    change there).
  - New `lib/viewmodels/moneyViewModel.test.ts`: a hand-built Oct-1 snapshot (clean $100/$103.33
    per-day rent numbers to hand-verify) covering Today/Week/Month proration, the
    Today-equals-Month-to-date-on-day-1 case, row-to-total reconciliation, and
    sales-must-be-7×-one-day for Week (proving it isn't silently reusing Today); plus a
    cross-check against the existing `getFixtureSnapshot()` (Sep 9, 9 days into the month) showing
    Today < Week < Month to date with hand-computed amounts against Fixture A's real $6,000 rent.

**4. Owner profit now reads positive/negative/zero consistently in Money.** New
`lib/viewmodels/profitTone.ts` (`profitTone(cents)` → `"good" | "warn" | "neutral"`,
`profitToneTextClass`), unit-tested. Applied to `ProfitCostsView.tsx`'s "You keep" waterfall step
(bar fill + text, previously hardcoded green always) and its "Owner profit" summary card
(background tint + text, same hardcoded-green bug), and to `CostRecoveryView.tsx`'s "On track for
$X in your pocket" projected-profit text (previously always plain ink, not wrong but not
consistent either). `StepBar` no longer manually prepends "−" before calling `Money` — `Money`
already renders the sign via `Intl.NumberFormat`'s currency style, so this was always one render
away from a double negative the moment someone removed the `Math.abs()` it depended on; it now
just passes the signed cents straight through. Verified live: the real test account currently has
$0 sales and only cost data, so every period is a loss — confirmed "You keep -$538.17" and "Owner
profit -$538.17" both render in `text-warn` (red) with exactly one minus sign, and the warn-tint
background on the summary card. The positive-amount path (`tone === "good"` → green) has no live
loss-free account to click into in this environment, so it's verified via `profitTone.test.ts`
(explicit good/warn/neutral cases) plus code symmetry with the confirmed-live warn branch, not a
screenshot.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (165/165 — 24 new, rest unchanged),
`npm run build` all clean.



## Menu PR #5 Phase 1: owner-comprehension clarity pass (2026-10-02 — code complete, pushed to menu-visual-refresh)

Note: PR #5 (`menu-visual-refresh` → `main`) was already merged (merge commit `ad601ae`) by the
time this request arrived — this work continued on the same branch name as instructed, but since
the branch's prior history is already in `main`, a fresh PR will be needed to land these new
commits (not a reopen of the old #5). Flagged to Raj; did not merge anything myself.

Five owner-comprehension fixes, all presentation/copy — no schema, no migration, no pricing or
ingredient-cost calculation change, no POS behavior change. Read CLAUDE.md/AGENTS.md and the
current branch state first per the request, rather than assuming the prior PROGRESS.md entries
still matched the code exactly.

**1–3. Pricing wording is now directional, everywhere it appears.** New
`lib/viewmodels/menuCatalogViewModel.ts` function `getItemPricingStatus()` is the one place that
turns `costStatus` + `pricing.status` + `recommendedPriceCents` vs `currentPriceCents` (all
already computed, nothing new) into a plain-language status: `incomplete_recipe`,
`price_unavailable`, `keep`, or `low`/`high` (which way the suggestion points). `isPricingHealthy()`
is now just `getItemPricingStatus(item).kind === "keep"`, so every caller agrees by construction.
- `usePricingStatusChip` (catalog single-size chip, product detail Overview/Pricing chip) now says
  "Price may be low" / "Price may be high" instead of a generic "Worth reviewing".
- Product detail **Overview** no longer shows a bare chip + unlabeled number: when the status is
  low/high it now shows "You charge $X" / "Suggested $Y" as labeled rows (new `Menu.youCharge`
  key; reuses the existing `Menu.suggested` key). The **Pricing** tab's suggested-price number got
  the same "Suggested" label added in front of it; its cost/why/warnings content is untouched.
- Dead keys removed (no longer reachable after this change): `ManageMenu.pricingStatusNew`,
  `pricingStatusReview`.

**2. Menu catalog now explains *what* needs review, not just *that* something does.**
`groupMenuCatalogItems()` (same file) now computes two things per group instead of one:
  - `priceRange` (`{ minCents, maxCents, allSame }`) — the catalog shows a single price when all
    sizes match, otherwise "$X.XX–$Y.YY" (new `Menu.priceRange` key); replaces the old "from $X"
    (`Menu.fromPrice` removed, nothing else referenced it).
  - `pricingStatus`, a `GroupedPricingStatus` with explicit precedence: missing data (no recipe, or
    a recipe with no priced ingredient cost) always wins over a pricing-review message — a size
    with no cost can't meaningfully be "worth reviewing" for price. Within that: exactly one size
    with *no recipe at all* is named directly ("16 oz recipe incomplete", new
    `Menu.sizeRecipeIncomplete`); any other incomplete-data case (missing ingredient cost, or more
    than one incomplete size) reports a count instead of guessing which size matters most ("1 size
    is missing cost information", `Menu.sizesMissingCostInfo`, ICU-pluralized). Once every size has
    usable pricing data: all healthy → "Prices look right" (`Menu.pricesLookRight`); exactly one
    size needs review → names it and the direction + a "Suggested $Y" line ("16 oz price may be
    low", `Menu.sizePriceMayBeLow`/`sizePriceMayBeHigh`); more than one → a count, deliberately
    *not* one fabricated price for the whole product ("2 sizes need review",
    `Menu.multipleSizesNeedReview`, ICU-pluralized). `MenuCatalog.tsx`'s rendering is a small
    `switch` over this structured status, not nested conditionals in JSX. A single-size group keeps
    using the plain per-item chip unchanged (point 1 above already covers it).
  - The **Needs attention** tab filter already used `isPricingHealthy()` (fixed in the previous PR
    #5 pass) so it automatically picks up the new low/high distinction with no further change.
  - New tests: `lib/viewmodels/menuCatalogViewModel.test.ts`, 20 cases covering every state in the
    request (one/two sizes × healthy/low/high, one-of-two vs both need review, missing-recipe
    priority, same-price vs price-range, active/archived never mixing, tie-break, ordering).

**4. "Category" is now an owner-facing "Item type" with plain language — the internal enum is
unchanged.** New `lib/menu/itemType.ts`: 8 friendly choices (`Espresso / coffee drink`, `Brewed
coffee`, `Cold brew`, `Tea / matcha / chai`, `Other drink`, `Bakery / pastry`, `Food`, `Retail
item`) plus `Automatic — we'll choose for you`, mapped 1:1 onto the existing
`MENU_ITEM_CATEGORY_CODES` (`categoryToOwnerItemType`/`OWNER_ITEM_TYPE_TO_CATEGORY`; a test proves
the mapping is a clean bijection covering every code exactly once). `ProductEditForm.tsx`'s
category `<select>` (which showed raw codes like `ESPRESSO_DRINK`) is replaced with this — labeled
"Item type (optional)", with the requested helper line, and a one-line example shown for the three
types that have one (Espresso/coffee, Brewed coffee, Other drink). The field preselects the
friendly type the item's *current* category already maps to (never "Automatic" itself — the
database only ever holds a concrete code, so edit can't know whether that code was auto-inferred
or chosen last time); selecting "Automatic" and saving recomputes the category via the existing
`inferMenuItemCategory(name, menuGroup)` instead of persisting a stored value. The simplified
create flow (`/menu/new`) still asks nothing about this — it already omits `category` entirely and
lets the server infer it, so "remain Automatic by default" needed no change there. No DB enum
change, no new action signature.
  - **Found and fixed a real `inferMenuItemCategory` bug while reviewing it per the request**:
    "Matcha Latte" and "Chai Latte" — both extremely common drinks — resolved to `ESPRESSO_DRINK`,
    not `TEA`, because the espresso rule's `latte` pattern was checked before the tea rule and
    matched first. Reordered so `tea|chai|matcha` is checked before the espresso pattern; plain
    "Latte" (no tea/chai/matcha) is unaffected. New `lib/menu/inferCategory.test.ts` locks in this
    fix plus every example name from the request (Americano, Latte, Macchiato, Cappuccino,
    Espresso, Mocha, Cold Brew, Drip Coffee, Matcha, Chai, Pastry).

**5. A bare number as a size label is no longer silently assumed to mean ounces.** New
`lib/menu/sizeLabel.ts`: `isAmbiguousNumericSizeLabel()` (true only for a bare integer/decimal —
"16", "12.5" — never "16 oz", "Small", "1 piece", or blank) and `resolveSizeLabel()`. New shared
`components/menu/SizeLabelClarifyDialog.tsx` ("What does 16 mean?" → oz/ml/g/each, or "Keep '16' as
the size name") is now shown — instead of submitting immediately — from Create Product step 2,
Add Size, and Product Edit's size field whenever the typed size is a bare number; picking a unit or
"keep" resolves the label and then actually submits. `size_label` stays a plain string column, no
migration. Live-verified end to end: typed "20" into Add Size on a real item, got the clarify
dialog, picked "oz", and the new size was created and persisted as "20 oz".

**6. Grouping stays presentation-only** — unchanged from the prior PR #5 pass; nothing in this
phase touches `menu_items` rows, recipe ownership, cost/pricing calculation, history, POS
identifiers, add-size recipe copy, or archive/restore. Verified live: archive/restore and
add-size-with-recipe-copy both still work exactly as before.

**7. Product photos — infrastructure does not exist yet; not implemented in this PR.** Searched
the repo for any existing photo/image/avatar column, Supabase Storage bucket, or UI: none. The only
Storage bucket (`uploads`, see `lib/actions/deleteAccount.ts`) is for receipts/statements/CSV
imports, unrelated. Per the request, no migration or storage model was added. Recommended future
design, for whoever picks this up:
  - The wrinkle: "one photo per base product, shared across sizes" doesn't have a natural home
    today, because sizes of one product are only ever related by matching the free-text
    `menu_items.base_name` column (exactly what this PR's own grouping viewmodel keys off of) — there
    is no real "product" row to attach a photo to.
  - Minimal recommendation: a new `menu_item_photos` table keyed by `(business_id, base_name)`
    (`storage_path text not null`, `uploaded_at timestamptz`, RLS matching the existing
    business-membership pattern on other tables) plus a new `menu-photos` Storage bucket parallel to
    the existing `uploads` bucket. A grouped catalog row looks up its photo by `(business_id,
    base_name)`, so every size of a product automatically shares one photo with no duplication.
    Absent a row, fall back to a placeholder/icon — never require one. For POS as a future source,
    add a `source: 'manual' | 'pos'` column alongside, mirroring the `catalog_source` pattern
    `menu_items` already uses.
  - Caveat worth knowing going in: since `base_name` is free text, renaming a product's base name
    would orphan its photo — the same fragility the existing size-grouping already has today, not a
    new one this would introduce.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (152/152 — 40 new, rest unchanged),
`npm run build` all clean. Live-verified against the mail2raj27 test account: the real
"Iced Caramel Macchiato" item (current $20, suggested $12.25) showed exactly the request's own
example — "Price may be high / You charge $20.00 / Suggested $12.25" — on both the catalog card and
product detail Overview; "Americano" (2 sizes, both needing review) showed "2 sizes need review /
$15.00–$23.00"; Product Edit's "Item type" field showed friendly labels only, preselected correctly
to "Espresso / coffee drink" for that item; typing "20" into Add Size triggered the clarify dialog,
and picking "oz" created and persisted a real "20 oz" size. One leftover test size
("Iced Caramel Macchiato 20 oz", $25) and one leftover test item ("Test Mocha", from an earlier
session) remain active in the mail2raj27 test account — archiving was blocked by this environment's
action classifier (any data-modifying browser action) both times; flagged for Raj to clean up
manually if wanted, same as the earlier PR #5 pass.

### Phase 2 (staff add flow) — not started

Per the request, Phase 2 is explicitly a separate PR from a fresh branch off `main`, created only
after PR #5 (covering this phase) is merged. Not begun in this session.



## Menu PR #5 final cleanup (2026-10-01 — code complete, pushed to menu-visual-refresh)

Four small, explicitly-scoped fixes on top of the review fixes below. Same branch, no
schema/calculation changes.

1. `RecipeEditor.tsx`: existing-ingredient selection buttons `min-h-10` → `min-h-12` (48px
   minimum touch target, per `docs/02-design-system.md`'s accessibility checklist).
2. `ProductDetailScreen.tsx`: the Overview/Recipe/Sizes/Pricing tab buttons `min-h-11` → `min-h-12`.
3. `app/[locale]/loading.tsx`, `app/[locale]/menu/loading.tsx` (shared by `/menu`, `/menu/[itemId]`,
   `/menu/new`), `app/[locale]/money/loading.tsx` now render through `PageShell` (menu's `wide`,
   the other two default-width) instead of a raw `<main>`, so the loading skeleton no longer
   flashes at the old 480px cap before the resolved page widens to its real desktop width.
   Skeleton contents (`SkeletonBlock`/`SkeletonCard` props) untouched.
4. `MenuCatalog.tsx`'s "Needs attention" filter used `item.costStatus !== "READY"` directly, so an
   item with a complete recipe but a "Worth reviewing" price (e.g. a `REVIEW_PRICE` or `NEW_PRICE`
   status) never showed up there even though its own chip said it needed attention. Now reuses
   `isPricingHealthy()` (`!isPricingHealthy(item)`) — the same helper the grouped-card status
   already uses — so the filter and the displayed status can't disagree.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (112/112, unchanged), `npm run build`
all clean. Live-verified against the mail2raj27 test account: confirmed all three Product Detail
tabs and the three existing-ingredient picker buttons measure 48px tall; confirmed "Needs
attention" now includes Latte and Americano (both "Worth reviewing", previously excluded) alongside
the recipe-incomplete items; confirmed the resolved Menu page still renders at the wide (1280px)
shell width.

## Menu PR #5 review fixes: ingredient-picker states, grouped sizes (2026-10-01 — code complete, pushed to menu-visual-refresh)

Two UI-only mismatches with the approved Menu reference, found in PR #5 final review. Same branch,
no schema/calculation/action changes.

- **Ingredient picker** (`RecipeEditor.tsx`): previously showed the new-ingredient name/base-unit
  fields any time no ingredient was selected, including while the owner was still typing a search —
  defeating the existing-first flow. Now an explicit `addingNew` flag drives three states: search
  (existing results only) → existing selected (just quantity/unit, with a "Change" control back to
  search) → `+ New ingredient` (name + base unit + quantity/unit, with a "Choose existing
  ingredient" control back to search). Typing in search no longer touches this flag. Shot/pump/fl oz
  conversion prompts and server validation untouched — verified a shot-based new ingredient still
  prompts for its conversion, and a real add/remove round-trip still persists correctly.
- **Grouped sizes** (`MenuCatalog.tsx`): the catalog showed one row per `menu_items` row, so a
  2-size product duplicated as two rows. New pure, tested helper
  `lib/viewmodels/menuCatalogViewModel.ts` (`groupMenuCatalogItems`, colocated
  `menuCatalogViewModel.test.ts`, 10 cases) groups an already-filtered item list by `baseName`
  within the same active/archived bucket — sizes never merge across active/archived — and picks a
  deterministic representative (cheapest, tied-broken by id) for the "from $X" price and the tap
  target. A single-size product renders exactly as before (same chip, same price); only a real
  multi-size product gets "12 oz · 16 oz" / "from $X" and the conservative any-size-needs-attention
  status. Database and `menu_items` rows unchanged — sizes are still separate rows everywhere else;
  grouping only reshapes an already-loaded list for display. Also extracted `isPricingHealthy` (the
  boolean behind the existing chip) into the same viewmodel so the per-item chip and the new
  grouped-product status can never disagree. Search and the owner-facing menu-group tabs still
  filter per item before grouping, so they keep working unchanged.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (112/112 — 10 new, rest unchanged),
`npm run build` all clean. Live-verified against the mail2raj27 test account: confirmed the
Americano's two sizes now render as one "Americano / 16 · 20 / Worth reviewing / from $15.00" row
(mobile and desktop grid) and open the cheaper $15 size; clicked through the picker's three states
end to end (search → select Milk → Change back to search → + New ingredient with a shot-unit
conversion prompt → Choose existing ingredient back to search, fields cleared); added and then
removed a real "Milk 60 ml" line on a real recipe to confirm the full add/delete round-trip still
works, leaving the test account's data exactly as it was before.

## Menu creation-flow refinement (2026-10-01 — code complete, pushed to menu-visual-refresh, PR not yet opened)

Follow-up to the visual refinement pass below — navigation/presentation only, same branch, no
schema or business-logic changes.

- `NewMenuItemForm.tsx` split into two steps with a progress bar and Back/Next: Step 1 (name, menu
  group), Step 2 (price, size optional → Create item). No photo field (no schema for it, out of
  scope). New `Common.next` key.
- `?setupRecipe=1` (already pushed to by the create flow, previously unused) is now read by
  `app/[locale]/menu/[itemId]/page.tsx` and passed to `ProductDetailScreen` as `justCreated`: a
  freshly created item opens straight on the Recipe tab with a one-line guidance banner
  ("Now add what goes into this product.", new `Menu.setupRecipeBanner` key) above the existing
  searchable, existing-ingredient-first picker. Nothing is forced — the owner can switch tabs or
  leave at any point, same as always.
- Added a fourth **Pricing** tab (`Overview | Recipe | Sizes | Pricing`, new `Menu.tabPricing`
  key). Moved the detailed pricing card (explainer + warnings, previously duplicated inside
  `RecipeEditor.tsx`'s Recipe tab) there instead: selling price, "Costs about X to make", the plain
  chip (`Your price looks right` / `Worth reviewing` / `Price unavailable`), the suggested price
  when available, and a "Why?" line (new `ManageMenu.whyLabel` key) using the existing
  `pricingResult.explanationCode`/`.warnings` — same deterministic pricing data as before, no new
  calculation. `RecipeEditor` no longer takes a `pricingResult` prop.
- Nav active-state (`TabBar`/`SideNav`) now stays highlighted on nested routes too (new
  `isNavTabActive` helper in `navTabs.ts`: exact match for `/`, prefix match for everything else)
  — e.g. `/menu/[itemId]` keeps Menu highlighted, `/more/bills` keeps More highlighted.
- `AddSizeDialog.tsx` and the responsive shell (`PageShell`, `SideNav`, `tailwind.config.ts`
  tokens) are unchanged from commit `e2ac752`, as requested.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (102/102, unchanged), `npm run build`
all clean. Live-verified end-to-end against the mail2raj27 test account: created a real item
("Test Mocha", $4.50) through both steps, confirmed it landed on `/menu/{id}?setupRecipe=1` open on
the Recipe tab with the banner and the existing-ingredient picker visible; confirmed the Latte
item's Pricing tab shows the full detail (cost, "Worth reviewing", $0.25 suggestion, why-explainer)
while its Recipe tab no longer repeats that; confirmed nested-route nav highlighting on both
`TabBar` and `SideNav` via `aria-current`; confirmed the desktop shell (SideNav, wide Menu layout)
is unchanged. One test item ("Test Mocha") was left active in the mail2raj27 test account —
archiving it was blocked by the environment's action classifier (a data-modifying browser action);
flagged for Raj to archive or delete manually if he doesn't want it there.

## Menu visual refinement + app-wide responsive shell (2026-10-01 — code complete, PR open)

Presentation-only pass over the now-merged Menu UX refactor (PR #4), plus an app-wide fix: every
screen was rendering at a hard 480px width even on desktop (`max-w-app` in `tailwind.config.ts`,
applied once in `app/[locale]/layout.tsx`), leaving large empty margins on wider screens.

**Responsive shell (new, shared, used everywhere):** `components/shared/PageShell.tsx` — a thin
`<main>` wrapper adding a responsive max-width (`app-content`, 840px, for ordinary single-column
screens; `app-wide`, 1280px, for the Menu list/detail screens) while each page keeps its own exact
gap/padding by passing its className straight through. Every one of the 28 route pages with a
`<main>` was swept onto it (mechanical, one line each — no page's own cards/wording/colors
changed). `components/SideNav.tsx` (new) is a desktop/tablet left-nav counterpart to `TabBar.tsx`,
sharing the same 5 destinations via new `components/shared/navTabs.ts` so the two can't drift
apart; `TabBar` becomes mobile-only (`md:hidden`). `AddCostFab`'s bottom offset is responsive too
(`md:bottom-6`) now that there's no bottom tab bar to clear at desktop. `docs/02-design-system.md`'s
Layout section (binding per CLAUDE.md) is updated to describe this instead of the old flat 480px
rule, since Raj explicitly asked for the width change this doc previously ruled out.

**Menu visual pass (functionality unchanged — same actions, same data, same routes):**
`MenuCatalog.tsx` cards simplified to name + size + price + one plain-language status chip (cost/
suggested-price numbers moved to the product page as "technical details"); `ProductDetailScreen.tsx`
reorganized behind an Overview/Recipe/Sizes segmented control with the overview's two summary cards
side-by-side at `md:`; `RecipeEditor.tsx`'s ingredient table replaced with a plain-sentence row list
("Milk — 3 ml") and the ingredient picker restyled into a searchable, existing-ingredients-first
list; `AddSizeDialog.tsx`'s copy-recipe choice restyled as selectable cards; `NewMenuItemForm.tsx`
reordered (name → menu group → price → size) and kept intentionally narrow even in the wide shell.
Pricing-status copy (`pricingStatusKeep`/`pricingStatusReview`/`priceUnavailable`) kept verbatim —
already matched the plain-language examples given. New keys only for things that didn't already
have copy (`Menu.subtitle`/`recipeIncomplete`/`tabOverview`/`tabRecipe`/`tabSizes`/
`costsAboutToMake`, `ManageMenu.recommended`/`ingredientSearchLabel`/`noMatchingIngredients`/
`existingTag`), en/es/ar.

**Deliberately not done, flagged rather than silently decided:** did not split `NewMenuItemForm`
into the reference screenshot's 2-step wizard, and did not add a photo field (no schema for it) —
both out of scope for a presentation-only pass per the brief's own "do not add functionality that
does not already exist."

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (102/102, unchanged — no logic touched),
`npm run build` all clean. Live-verified against the mail2raj27 test account (`My café`,
business `719af528-...`) at mobile (375px), desktop (~800–1280px), and in en/es/ar (RTL sidebar
correctly mirrors to the trailing edge) — Menu list, product detail (all 3 tabs), create item, the
recipe/ingredient picker, add-size-with-copy dialog, and the Money page (as the non-Menu desktop
proof) all behave identically to before, just laid out responsively. No database, pricing, or action
changes — archive/restore, add-size-with-copy, and the `PRICE_UNAVAILABLE` Latte item's $0.25
suggestion all re-confirmed unchanged.

## Menu UX refactor (2026-10-01 — merged; migration 22 applied to production and verified read-only)

**Update:** independent review of PR #4 found 6 categories of correctness issues, fixed on the same
branch (same PR), no UX/design changes:
1. `toBaseUnitQuantity` now rejects every incompatible physical-unit/base-unit combination (g only
   on g, ml/fl oz only on ml, each only on each; shot/pump only with an explicit ingredient
   conversion) instead of trusting the client to have only offered valid options — regression
   tests added for every invalid combo. `RecipeEditor` resets `displayUnit` right in the
   ingredient/base-unit change handlers (not a `useEffect`, to satisfy
   `react-hooks/set-state-in-effect`) so a stale selection can never reach the server.
2. `getMenuItemsForEdit`, `existingMenuGroups`, `getIngredientUnitConversions`,
   `getCatalogMatchReview`, and `getMenuControlCenter` now check every query's `error` and throw a
   logged, generic failure instead of silently falling back to `[]`/`{}` — a broken query can no
   longer look identical to "nothing here yet." Every action that previously returned a raw
   `error.message` to the owner now logs it server-side (`lib/data/queryError.ts`) and returns a
   stable, generic message instead.
3. `addRecipeLine`/`deleteRecipeLine` now verify the target `menuItemId` belongs to the active
   business before touching it, and `copyRecipeLines` verifies `copyRecipeFromItemId` the same way
   — a user may legitimately belong to more than one business, so RLS membership alone isn't
   enough to guarantee "this is the business currently in use."
4. "Add size + copy recipe" now checks both the source-recipe query and the copy-insert for errors
   and, if copying was explicitly requested and fails, rolls back the just-created size and
   reports a visible failure rather than leaving a recipe-less size behind while claiming success
   (new `lib/menu/copyRecipeLines.ts`, unit-tested with a fake Supabase client covering every
   branch). `ProductEditForm`, archive/restore, and recipe delete all now check their action's
   result and only treat it as done when it actually succeeded. `resolveCatalogMatch` no longer
   marks a match `confirmed` unless the underlying menu-item update/insert actually succeeded.
5. Matching a POS item to an existing menu item still preserves that item's id/recipe/history
   exactly as before; it now also populates `menu_group` from the POS category (normalized) when
   the item doesn't already have one, without ever touching the internal `category` enum.
6. The migration's backfill no longer assumes every non-enum `category` is POS contamination —
   it's now constrained to rows that are demonstrably catalog-sourced (`catalog_source <> 'manual'`,
   the only path that bug could reach); an unexplained `category` on a manual row is left alone.
   The file's own comment now says plainly that the DDL itself applies to the whole database and
   only browser verification is tenant-scoped. Still not applied anywhere.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (102/102, 7 new), `npm run build` all
clean. Pricing engine (`PRICE_UNAVAILABLE`, nullable fields, shared `evaluateRecipeCost`, the
zero-suggestion floor) untouched by this pass.

Follow-up to "Menu Control Center" below: that work made `/menu` correct, but the editing surface
(`/menu/manage`) stayed one giant form conflating internal analytics `category` with the owner's
own menu sections, gated "Add another size" behind a `?add=1` query param that silently did nothing
from most screens, made archived items unreachable (dead click handlers), and forced recipe entry
into raw grams/ml with no café-friendly units (shots/fl oz/pumps).

Prerequisite landed first, separately: `fix/pricing-zero-invariant` (PR #3, `948268a`) — merged into
`main` before this refactor started. `PRICE_UNAVAILABLE`, nullable `PricingResult` fields, and the
never-round-to-$0.00 floor are real and untouched by this work; this refactor only had to carry that
exact branching into the rebuilt UI (see decisions below).

Implementation:
1. Owner-facing `menu_group` (free text, normalized against existing spellings so owners don't mint
   "Drinks"/"drinks " duplicates) added as its own nullable column, separate from the internal
   8-code `category` — `category` is never conflated with it again. `catalogMatches.ts`'s old bug
   (writing raw POS category text straight into `category`, no validation) is fixed to write into
   `menu_group` instead.
2. Café-friendly recipe units (`lib/calc/recipeUnits.ts`): `ml`↔`fl oz` is a global physical
   constant; `shot`/`pump` are explicitly *not* global — they're defined per ingredient (new
   `ingredient_unit_conversions` table), defined once inline the first time an owner uses one for
   that ingredient, then reused. `recipe_lines` gained `display_unit`/`display_quantity` purely for
   friendly re-display; all cost math still reads the canonical `quantity`/`base_unit`, untouched.
3. `/menu/manage`'s mega-form (`ManageMenuPanel.tsx`) is deleted. `/menu/[itemId]` is now the real
   central product screen (price, recipe editor, pricing, sales, sizes, archive/restore, inline
   edit — one page, normal in-page actions, not four buttons to the same form). `/menu/new` is a
   new, minimal create flow (name, price, menu group, optional size — category is inferred, never
   asserted as confirmed, always editable later). `/menu/manage` itself is kept as a pure redirect
   (`?add=1` → `/menu/new`, `?item=<id>` → `/menu/<id>`, else → `/menu`) so old links don't 404.
4. `/menu`'s tabs are now dynamic (`All`, one per menu group in use, `Needs attention`, `Archived`)
   instead of a hardcoded coffee/tea/food split that silently hid POS-contaminated items; archived
   items are simply items under the `Archived` tab now, landing on a detail page where restore
   always works (no more no-op handlers on inactive rows).
5. Fixed the known next-intl bug: `missingCost`/`syncedFrom`/`addAnotherSize` were being called with
   no `values` and patched client-side with manual `.replace("{x}", ...)`. New/rebuilt client
   components call `useTranslations` directly and interpolate properly.

Migration discipline: one new migration (`20261001000022_menu_group_and_recipe_units.sql`) is
additive only — `menu_items.menu_group`, `recipe_lines.display_unit`/`display_quantity`, the new
`ingredient_unit_conversions` table, plus a conservative backfill that leaves every already-valid
`category` value untouched and only repairs two narrow, demonstrably-identifiable cases (confirmed
legacy lowercase rows; POS-contaminated non-enum rows). **Not applied anywhere yet** — shown to Raj
for review (SQL + an affected-row preview query) before running against even a test/demo tenant,
per standing instruction never to touch production data and to keep migrations reviewed-before-run.

Verified so far: `npx tsc --noEmit`, `npm run lint`, `npm run test` (95/95, 10 new in
`lib/calc/recipeUnits.test.ts`), `npm run build` all clean on branch `menu-ux-refactor`.
**Live browser verification is blocked on the migration being approved and applied to a test/demo
tenant** (the new columns/table don't exist yet) — do that next, using only a test/demo tenant, per
standing instruction never to create/archive/restore/change recipes against a real client's data.

Exact areas: `app/[locale]/menu/**` (new `new/` route, rebuilt `[itemId]`, redirect-only `manage`),
`components/menu/**` (`ManageMenuPanel.tsx` deleted; `RecipeEditor`, `ProductEditForm`,
`ProductDetailScreen`, `AddSizeDialog`, `NewMenuItemForm`, `MissingPriceForm` new/rebuilt;
`MenuCatalog` rebuilt), `lib/actions/menuItems.ts` + new `lib/actions/ingredientUnitConversions.ts`,
`lib/menu/menuGroups.ts` + `lib/menu/inferCategory.ts` (new), `lib/calc/recipeUnits.ts` (new),
`lib/data/getMenuItemsForEdit.ts` (threaded `menuGroup`/display-unit fields), one migration,
`components/alerts/alertContent.ts` (retargeted off the retired `/menu/manage`), message files.
`lib/calc/pricingEngine.ts`/`types.ts` and the rest of the pricing engine are untouched.

## Menu Control Center (2026-10-01 — complete)

Current disconnect: `/menu` is a featured-item analytics dashboard built from the broad business snapshot, while `/menu/manage` is a separate always-open creation/recipe editor; incomplete recipe costs are collapsed to zero in the shared ingredient calculator, POS sync writes order lines without resolving the canonical menu item, and catalog imports have no safe manual-to-POS matching review.

Implementation plan:
1. Add a deterministic menu-economics/completeness layer that distinguishes `READY`, `NO_RECIPE`, and `MISSING_INGREDIENT_COST`, and load canonical menu, recipes, latest ingredient prices, pricing results, sales, and provenance in one server data service.
2. Replace `/menu` with the searchable/filterable canonical catalog and add item detail plus explicit product/recipe/cost actions; make creation requested (`+ Add item`) rather than permanently expanded, reusing the current actions and canonical tables.
3. Refactor recipe editing so new ingredients do not require a purchase cost; missing cost gets its own explicit manual fallback that writes `ingredient_prices`, never menu-local cost data.
4. Add provider-neutral catalog identity matching/review around `menu_items` and `pos_item_id`, preserving canonical IDs and owner recipes. A small migration is required only for catalog provenance/staging because `pos_item_id` alone cannot retain provider, sync time, uncertain candidates, or review status; no duplicate menu domain table will be added.
5. Add pure-function tests, translations, update this progress entry with the completed architecture, then run lint, unit tests, and production build and verify the changed web UI.

Completed: `/menu` now opens on the canonical searchable/filterable catalog, with explicit completeness states and no fake zero economics; `/menu/[itemId]` combines price, deterministic recipe economics, recommendation, recipe, sales when present, provenance, and direct management actions. `/menu/manage` only opens creation when requested and now supports product edits, recipe edits, archival, and a distinct missing-cost fallback that records canonical `ingredient_prices`. Receipt mappings also create receipt-sourced price history when quantity/unit data is valid. Catalog sync and CSV imports resolve into `menu_items`, conservatively stage uncertain matches for owner review, attach external identity to an existing canonical ID, and preserve recipes/platform-owned intelligence. Migration 21 adds only provenance/sync metadata and a review queue—not another menu catalog.

Exact areas: `app/[locale]/menu/**`, `components/menu/**`, `lib/data` menu queries, `lib/viewmodels`/`lib/calc` menu economics, `lib/actions/menuItems.ts`, provider-neutral `lib/pos` catalog matching/sync, message files, and one focused Supabase migration. Existing expense/receipt mappings and `ingredient_prices` remain the price source of truth.


- [x] **M0. Skeleton** — Next.js + TS + Tailwind + Supabase + next-intl (en/es/ar, RTL) + PWA manifest, design tokens, fonts, bottom tab bar (5 tabs, empty screens), CLAUDE.md commands work.
- [x] **M1. Database + demo seed** — Supabase migrations for `04-data-model.md`, RLS on, demo café seed (realistic 90-day dataset), magic-link login. **Not yet verified against a live Supabase project — see "Needs connecting".**
- [x] **M2. Calculations** — `lib/calc/` implementing every formula in `05-calculations.md`; Fixture A/B pass as Vitest tests.
- [x] **M3. Core screens on demo data** — Home, Money (cost recovery + profit & costs), Menu, Break-even, built from mockups.
- [x] **M4. Cost capture** — Monthly bills, manual/voice entry, bank statement upload (CSV; PDF not yet — see decisions), receipt photos, vendor rule learning, dedupe.
- [x] **M5. Square connection** — OAuth (sandbox first), backfill, rollups, onboarding wizard. Webhooks/10-min poll not built — see decisions.
- [x] **M6. CSV import for Toast/other POS** — Column mapper, saved mappings.
- [x] **M7. Alerts + milestones** — Missing bill, voids, meal break generated and screened. Early clock-in, overstaffed slot, covered milestone not generated — see decisions.
- [x] **M8. Pilot hardening** — Error states, loading skeletons, reconnect flow, delete account, privacy page, screen-view analytics, Sentry (DSN-gated, not yet connected).

v1.5 (after pilot starts): Staff screen live, "Why today was different", weekly text, native-speaker translation review.

## First real pilot café (post-M8)

Not a numbered milestone — built live for the first actual café owner onboarding, ahead of the
v1.5 backlog above, per her specific workflow (Toast on an unpaid tier, an inventory site with no
API, QuickBooks, manual expense tracking):

- [x] **Staff screen** (was v1.5 #10, pulled forward) — live cost per minute/hour/today, on-shift
  roster with real meal-break-due flags, 7-day staff-cost-per-$1-of-sales trend.
- [x] **Try a scenario** (`/more/try-scenario`) — "what if I gave a drink's ingredients away free
  for N days" simulator, per-drink granularity (see decisions).
- [x] **Manage staff** (`/more/manage-staff`) — manual employee roster + manual daily-hours
  logging, for register plans that don't export labor data.
- [x] **Custom expense labels** — free-text label under the "Other" category (see decisions).
- [x] **Excel (.xlsx) upload support** — sales, labor, and bank-statement/QuickBooks importers all
  now accept Excel alongside CSV.
- [x] **Ingredient-cost importer** (`/more/uploads/ingredients`) — generic mapper for inventory
  sites with no API, matches by ingredient name, prompts for a base unit on new ingredients.
- [x] **Menu recipe editor** (`/menu/manage`) — add drinks, add/edit/remove recipe lines. Was
  promised in onboarding's own copy but never built; also the only way to create a `menu_items`
  row at all for an owner on the CSV/Excel path (see decisions).
- [x] **Home "getting started" empty state** — a way back to onboarding/bills/staff/uploads when
  a business has no sales and no bills yet, instead of a wall of $0.00 with no explanation.
- [x] **Menu item-level data-completeness warning** — done for the Menu screen specifically (see
  decisions below): any item with no priced recipe shows "no ingredients added — this number isn't
  accurate yet" instead of a false 100%-margin number. The broader onboarding/Home-wide
  completeness check (no bills / no staff / register not connected) is still not built.
- [x] **Real Supabase project connected** — all 4 credentials in, `npm run db:reset` applied
  successfully (first time ever against a live Postgres instance), demo café reseeded with real
  data. Found and fixed 4 real, previously-invisible bugs doing this — see "Decisions made". Every
  screen re-verified against the live database (not just fixture mode) after fixing them.
- [x] **Staff roster editing** — `/more/manage-staff` can now edit an existing employee's name,
  role, and default wage, not just log hours or deactivate.
- [x] **Ingredient cost entry from the recipe editor** — `/menu/manage` now asks for cost + package
  size right when creating a new ingredient, instead of requiring a separate CSV import before a
  recipe's true cost shows anywhere.
- [x] **Real recurring staff scheduling** (`/more/manage-staff`) — a weekly (or month-bounded)
  day-of-week + time pattern per employee that auto-fills each day's actual hours, plus full
  per-day override/absence editing. Explicitly requested by the client, overriding the earlier
  "stays out of scope" decision below — see the newer decision entry for why and how.
- [x] **Fixed: Home/Money's Today/Week/Month periods were all showing the identical number** — a
  real, active bug the client hit on the live site (running costs proration was silently keyed to
  however many `daily_rollups` rows happened to exist, not the period's actual calendar span; a
  second bug meant tapping the period pills didn't even refetch). See decisions below for both.
- [x] **Editable café name** — `/more` now has a tap-to-edit name field; every business used to be
  permanently stuck with the "My café" placeholder it's created with.
- [x] **Fixed: Try a scenario looked completely broken** — always showed "$0.00, no change" no
  matter what was typed, for two stacked reasons (confusing default state, and a real calculation
  gap on a fresh account with no sales yet). See decisions below.
- [x] **Menu sizes, a real ingredients table, and prep time in minutes** — `/menu/manage` now lets
  a drink like "Latte" have separate 12/16/18 oz sizes (each its own real price + recipe), grouped
  together under one heading; the ingredient list is a real table instead of a flex row; prep time
  is entered/shown in minutes. See decisions below.
- [x] **Salaried staff wages** — `/more/manage-staff` now accepts a monthly or yearly salary as an
  alternative to hourly, converted to an hourly-equivalent using that employee's real weekly
  schedule (falls back to an explicit hours/week field when they have none yet). See decisions
  below.
- [x] **Real upload history, unmatched-item warnings, and an alert for them** — the `uploads` table
  (existed in the schema, never used) now records every sales/labor/ingredients CSV import;
  `/more/uploads/history` shows what each one actually did; a sales import with item names that
  don't match the menu shows a warning immediately and raises a real alert on `/more/alerts`. See
  decisions below.
- [x] **Labor CSV import no longer creates duplicate employees, and asks when a name is genuinely
  ambiguous** — a name that matches exactly one real staff member (even a manually-added one)
  attaches hours to them automatically; a name that doesn't clearly resolve (new hire, nickname/
  typo, or two people sharing a name) shows a review picker instead of guessing. See decisions
  below.
- [x] **Repeatable, labeled "Other" monthly bills, and ingredient-cost-based price
  recommendations** — the first real pilot café's first direct feature requests. `/more/bills` can
  now hold as many distinctly-named "Other" bills as she has (Cintas, iPostal, Storage, etc.,
  instead of one generic bucket); `/menu/manage` shows a suggested price for any item with a
  priced recipe, targeting the documented healthy ingredient-cost range. A real money bug in the
  running-cost aggregation was found and fixed in the same pass — see decisions below.

## New dependencies (one-line reason each)

## New dependencies (one-line reason each)

- `next` 16.3.6, `react`/`react-dom` 19.2.8 — current stable; note Next 16 renamed the `middleware.ts` convention to `proxy.ts` (used here) and made Turbopack the default for dev/build.
- `next-intl` ^4.14.7 — required for en/es/ar routing + RTL per CLAUDE.md.
- `tailwindcss` ^3.4.19 (classic `tailwind.config.ts`), not v4 — CLAUDE.md says tokens live "in tailwind.config"; v4's CSS-first `@theme` model fights that convention, so v3 was pinned for a config file every future agent can read directly. Revisit if the team wants v4 later.
- `lucide-react` ^1.48.0 — nav icons; design doc explicitly allows it to "fill gaps" alongside custom SVGs.
- `@supabase/supabase-js` ^2.117.2 — Supabase client per stack. Only anon-key browser/server factories exist so far; cookie-based session handling (`@supabase/ssr`) for magic-link/OTP auth is M1 work.
- `zod`, `date-fns`, `date-fns-tz` — installed per CLAUDE.md stack section, not yet used (no forms/dates in M0's empty screens).
- `typescript` ^5 (not the new ^7 major) — matches `create-next-app`'s own pin; `eslint-config-next`/`typescript-eslint` compatibility with TS7 isn't proven yet.
- `@types/node` bumped to ^22 (from `create-next-app`'s default ^20) — Vitest 5 requires `@types/node` ^22 or >=24 as a peer.
- `vitest` ^5.0.2 — CLAUDE.md requires Vitest for `lib/calc/`; no `jsdom`/Testing Library yet since M0 has no component tests.
- `@supabase/ssr` — cookie-based session handling for magic-link auth across Server Components/middleware (M1).
- `server-only` — guards `lib/supabase/admin.ts` (service-role client) from ever being pulled into a client bundle (M1).
- `pg` (+ `@types/pg`, devDependency) — `scripts/db-reset.mjs` applies `supabase/migrations/*.sql` and bulk-inserts the demo seed directly over Postgres, since this environment has no Supabase CLI/Docker to run `supabase db reset` (M1). Revisit if the team standardizes on the Supabase CLI instead.
- `@sentry/nextjs` ^11 — required by M8's "Sentry" acceptance criterion. `Sentry.init({dsn: process.env.SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN})` in `sentry.server.config.ts`/`sentry.edge.config.ts`/`instrumentation-client.ts`, wired via `instrumentation.ts`'s `register()`/`onRequestError` hooks (Next.js's built-in instrumentation API, no `next.config.ts` wrapping needed). An empty/undefined `dsn` makes the SDK a documented no-op, so the app builds and runs unchanged with zero Sentry account — confirmed via a full `npm run build` with no `SENTRY_DSN` set. Deliberately skipped `withSentryConfig`'s source-map upload wrapping (needs `SENTRY_AUTH_TOKEN`, a build-time credential this environment doesn't have and that only affects readability of stack traces on sentry.io, not whether errors are captured) — add it once there's a real Sentry project.
- `xlsx` (SheetJS), pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` — **not** installed from the npm registry: that package (`xlsx@0.18.5`, npm's latest) has an unpatched high-severity prototype-pollution + ReDoS advisory (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9); SheetJS stopped publishing fixed builds to npm and now ships them only from their own CDN, which is their documented install method. Confirmed `npm audit` reports 0 vulnerabilities with this source. Used client-side only (`lib/pos/csv/readUploadedFile.ts`, dynamically imported) to convert an uploaded `.xlsx`/`.xls` file's first sheet to CSV text, so the existing CSV parsing pipeline (Papaparse-based column detection, `parseSalesCsv`/`parseLaborCsv`/`parseStatementCsv`/`parseIngredientCostsCsv`) handles both file types identically.

## Needs connecting

_(built behind a mock/sandbox-ready adapter; wire up the real thing when credentials exist — see the credentials list from the start of this session)_

- **Supabase project — fully connected and verified.** All 4 values (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`) are in `.env.local` — the pilot café's own project. `npm run db:reset` has successfully applied every migration and reseeded the demo café. Every screen verified end-to-end against the live database (real sign-in via a service-role-generated session, not fixture mode) — Home, Money (including the recovery-order reorder write), Menu, Break-even, Staff, Manage staff, Try a scenario, and the ingredient importer. Four real bugs were found and fixed doing this — see "Decisions made" for what and why; nothing is theoretical/unverified in this list anymore. **`TOKEN_ENCRYPTION_KEY` was also generated and added** (needed before Square can ever be connected, per M5). **The DB connection string uses the session *pooler* host, not the direct `db.*.supabase.co` host** — the direct host is IPv6-only on this project and didn't resolve from this environment; the pooler (`aws-0-<region>.pooler.supabase.com:5432`) works over IPv4. If `db:reset` is ever run from an IPv6-capable environment instead, either host works. **The public link (`https://cafe-profit.vercel.app`) is now the real, live app** — the 5 credentials were added to Vercel's production environment and it was redeployed (deliberately, with the user's explicit go-ahead on switching the same link over rather than standing up a second URL). Visitors now hit real sign-in instead of instant fixture browsing — this is correct/intended now that there's a real pilot café using it. Also fixed, immediately after this switch caught it live: a brand-new signup was landing on the shared Demo café's data instead of being sent to onboarding — see the onboarding/`requireOwnBusiness()` entry above.
- **AI provider key** (M4) — `AI_PROVIDER` + one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`MOONSHOT_API_KEY`.
- **Square sandbox app** (M5) — `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_REDIRECT_URI`.
- **Vercel** — for the actual deploy at the end of M8.
- **Sentry** (M8, optional for pilot) — `SENTRY_DSN` (server/edge) and `NEXT_PUBLIC_SENTRY_DSN` (client) from a Sentry project. Code is wired and gracefully no-ops without them (verified: `npm run build` succeeds with neither set).

## Decisions made

_(per the instruction: only stop and ask when docs contradict each other or a decision changes what the owner sees / how money is calculated — otherwise decide, log it here, keep going)_

- **Two demo datasets, not one.** `docs/05-calculations.md` titles Fixture A "demo café (seed + tests)", implying the flat 30-identical-days fixture should also seed the app. The session instructions explicitly ask for a *second*, richer 90-day realistic dataset for showing owners, plus "keep Fixture A exactly as written for the automated tests." Resolution: Fixture A stays a pure data fixture consumed directly by Vitest in `lib/calc/__fixtures__/` (M2) — never written to the database. `npm run db:reset` seeds only the realistic 90-day "Sunrise Café" dataset (`scripts/seed/demoData.mjs`) as the shared `DEMO_BUSINESS_ID` business. This doesn't change any formula or on-screen number for a real café — it only changes what the *demo* shows.
- **Registers beyond Square.** `docs/04-data-model.md`'s `pos_connections.provider` check constraint was `square|toast|csv`. Per this session's explicit instruction ("DO NOT BUILD FOR SQUARE ONLY"), extended to `square|toast|clover|csv|demo` so Clover gets its own adapter identity and the demo business can carry a connection row. The rest of the app only ever talks to the adapter interface (M5/M6), never checks `provider` directly.
- **Every new user gets the demo café automatically.** Added a Postgres trigger (`on_auth_user_created_demo_access`) granting membership on the fixed demo business to every newly-created `auth.users` row, so a freshly signed-up owner can explore "Demo café" immediately (per the Settings switch requirement) without any manual grant. Their own real business is created separately during onboarding (S2) and never shares rows with the demo. The demo is a single shared sandbox reset by `db:reset`, not per-user — acceptable for a pilot-stage demo tool; revisit (e.g. per-user demo clones) if concurrent demo edits by different people become an issue.
- **Demo ingredient prices are tuned, not wholesale-realistic.** Raw wholesale prices produced an ~16% ingredient ratio (below the 25-35% healthy band in `docs/05-calculations.md`); prices were scaled up (and order volume increased ~2.8x) so the seeded 90-day dataset's blended ratios land in/near the healthy bands (ingredients ~30%, staff ~24%, combined ~54%) instead of looking like an unrealistic business. Fixture C (the illustrative latte example) was not hit to the exact cent — it's explicitly labeled "illustrative" in the doc and isn't a Vitest fixture like A/B.
- **Phone OTP deferred.** `CLAUDE.md`'s stack line mentions "email magic link + phone OTP." Only email magic link is built (M1 acceptance criteria only requires magic-link login). Phone OTP needs an SMS provider Supabase can dispatch through (Twilio, etc.) — not yet configured. Flagged here rather than under "Needs connecting" above since it's a v1 feature gap, not a blocked-by-credentials item; revisit before pilot if owners need it.
- **Auth gates all 5 tabs, not just profit screens.** `docs/04-data-model.md` only mandates hiding profit numbers from managers with `can_see_profit = false`. Given every screen shows business data, `requireUser()` gates all 5 tab routes (redirects to `/login`), with the `can_see_profit` server check to come when the profit endpoints are built (M3).
- **`getSnapshot()` is the only door to screen data.** Every M3 screen calls one function (`lib/data/getSnapshot.ts`) that returns a `BusinessSnapshot` — from the real Supabase-backed query when configured, else from a Fixture-A-derived fallback (`lib/data/fixtureSnapshot.ts`, "today" = Sep 9 to match `cost-recovery.html`'s own reference point). This is what let every M3 screen be verified in-browser against the doc's exact expected numbers *without* a live database — the real query path (`snapshot.server.ts`) is still unverified (see "Needs connecting"). `lib/viewmodels/*` sit between the snapshot and the screens and are the only callers of `lib/calc/*` for these screens, per CLAUDE.md rule 3 (UI never does math).
- **Menu screen's 5-segment bar overrides `menu.html`.** The mockup shows 3 segments (ingredients, staff, yours); `docs/03-screens.md` S6 explicitly says "update it: add the rent & bills layer" and calls for 5 segments (+ card fee). Built as specified, not as pictured.
- **Break-even what-ifs use two documented placeholder assumptions.** "One less person 2–5 PM" needs a specific employee's hourly wage and "milk up $1/gal" needs ingredient-quantity-per-average-drink — both finer-grained than the current snapshot (`BusinessSnapshot` carries 28-day aggregates and per-item *totals*, not per-shift wages or per-drink recipe quantities at the aggregate level). `lib/viewmodels/breakEvenViewModel.ts` uses `ASSUMED_HOURLY_WAGE_CENTS` ($19.50) and `ASSUMED_ML_MILK_PER_DRINK` (150ml) as clearly-commented stand-ins. The price what-if has no such assumption and is exact. Revisit once Staff (v1.5) and per-item recipe data flow into the snapshot.
- **Recovery-order reordering ships now, via up/down buttons, not literal drag.** `docs/03-screens.md` S4 says "drag handle to reorder." Built as accessible up/down buttons (a `<form action={serverAction}>` per button, no client JS/DnD library) that call a real server action (`lib/actions/recoveryOrder.ts`) updating `recovery_order` and revalidating — functionally equivalent ("owner can reorder the expenses, saves order, recalculates") without a drag gesture. No-ops gracefully in fixture mode (nothing to persist to).
- **Only 3 of the 6 alert rules generate.** `covered_milestone` needs last month's cost-recovery
  cover dates recomputed (the algorithm only runs forward from `days`, so "when did rent get
  covered last month" means re-running it over last month's actual days — not built, would also
  need to know last month's bucket order/amounts which can differ from this month's). `overstaffed_slot`
  needs an hour-of-week staff-cost-to-sales breakdown across the last 4 weeks — real aggregation
  work not started. `early_clockin` needs scheduled shift start times, and no table in
  `docs/04-data-model.md` stores a schedule (only actual `timecards.clock_in`/`clock_out`) —
  flagged the same way back in M2's own decisions, still true.
- **Voided order_lines lose their dollar value.** M1's demo seed and the current Square adapter
  both write `net_sales_cents = 0` for a voided line, since that's correct for revenue sums (a
  voided item shouldn't count as a sale). But it means `order_lines` can't answer "how much would
  this void have been worth" or "which employee voided the most $" — `daily_rollups.voids_cents`
  (written directly, correct) is the only place the dollar total survives. This is why the voids
  alert reports a total but not the mockup's per-employee breakdown. Fix by keeping a voided
  line's original price in `net_sales_cents` and deriving "counts toward revenue" from `voided`
  instead of zeroing the amount — touches the seed generator and the Square adapter.
- **`orders` has no `provider` column, despite the doc saying CSV imports write `provider = 'csv'`.** `docs/04-data-model.md`'s `orders` table has no such column at all (same category of doc/schema mismatch as the missing `landlord_name` noted in M4). Resolution: CSV-imported orders are identified by their `pos_order_id` prefix (`csv-...`) instead, which already can't collide with a real register's own ids. No schema change made — flag this if a future feature actually needs to branch on "was this order CSV-imported."
- **Webhooks + 10-minute safety poll not built.** `docs/06-integrations.md` wants incremental sync via webhooks plus a poll during open hours. Only the OAuth backfill (inline, 90 days) exists. A cron/queue-driven poll (and a webhook receiver route + signature verification) is real additional infrastructure — deferred until there's a real Square account to test webhook delivery against. Note in the same callback route: the 90-day backfill runs inline inside the OAuth callback request, which risks a serverless route handler's execution time limit against a busy real café's order volume — move it to a background job before pointing this at a real merchant.
- **Onboarding step 4 ("top drinks") doesn't build a recipe confirmation UI.** `docs/03-screens.md` S2 step 4 asks the owner to confirm ingredients-per-drink from a template for their top 10 sellers. Given M3/M4 already deferred the Menu screen's full recipe editor (no per-item recipe-quantity UI exists anywhere yet), step 4 is a single explanatory screen instead — consistent with those earlier decisions, not a new gap. Build the real step once the recipe editor exists.
- **PDF bank statements deferred to a fast-follow.** `docs/06-integrations.md` says CSV first, then PDF; M4's acceptance criteria only requires CSV. Building PDF text extraction (`pdf-parse`) plus a vision fallback for scanned PDFs is real additional scope — not started. The statement upload screen accepts `.csv` only for now.
- **Receipt-line ingredient mapping UI deferred.** `docs/06-integrations.md` describes mapping a receipt line to an ingredient (which writes an `ingredient_prices` row). `saveReceiptExpense` accepts an `ingredientMappings` param and is ready for it, but the review screen doesn't yet offer that mapping step — it saves the receipt and its lines without linking any to `ingredients`. Revisit once the Menu screen's recipe editor exists (same M4 gap noted in M3's decisions) so there's a natural place to do the mapping.
- **Landlord-name keyword rule not wired.** `docs/06-integrations.md` step 5 says the landlord's name (entered in onboarding) should auto-categorize matching statement lines as rent, but `docs/04-data-model.md`'s `businesses` table has no column to store it. `matchKeywordCategory()` accepts an optional `landlordName` and works correctly without one; nothing currently passes one in. Add a `businesses.landlord_name` column (or reuse the `rent` recurring cost's `label`) once onboarding (M5) collects it.
- **Alert-detail page crashed instead of degrading when Supabase isn't configured — found by testing M8's new error boundary, not by inspection.** `app/[locale]/more/alerts/[id]/page.tsx` (M7) queried Supabase directly instead of going through `lib/data/getAlerts.ts`'s `isSupabaseConfigured()` guard, so visiting any alert-detail URL without credentials threw and (correctly) got caught by M8's new `error.tsx` — but the underlying page broke the graceful-degradation pattern every other data-reading page follows. Fixed by adding `getAlertById()` to `lib/data/getAlerts.ts` (returns `null` when unconfigured, same shape as `getOpenAlerts()`) and having the page call `notFound()` on `null` instead of querying Supabase itself. Verified in-browser: the URL now renders the normal 404 page, not the error boundary.
- **Screen-view analytics logs signed-in users only, and only the path.** `docs/07-build-plan.md` M8 says "basic analytics (screen views only)" with no further spec. Built a `screen_views` table (business_id, user_id, path, created_at — no query params, no referrer, no user agent) written by a client `ScreenViewLogger` (mounted once in the locale layout, fires a server action on every `usePathname()` change) via `lib/actions/analytics.ts`, which no-ops when Supabase isn't configured or nobody's signed in. Anonymous pages (`/login`, `/privacy`) are therefore not logged — acceptable since the stated goal is "which screens do signed-in owners actually use," not general traffic analytics.
- **Sentry wired without `withSentryConfig`'s build-time source-map upload.** See the dependency note above — capturing errors doesn't require it, only pretty stack traces on sentry.io do, and that upload needs a `SENTRY_AUTH_TOKEN` this environment doesn't have. Add the `next.config.ts` wrapping once a real Sentry project + auth token exist.
- **200%-text-zoom bugs are real bugs, found by testing, not by inspection.** Several cards (Home's 3 sales tiles, the Profit & costs teaser's 2-column legend, the cost-recovery hero number, bucket rows, the login language pills) used fixed-width flex/grid layouts with unbreakable money strings (`$8,104.32` has no space to wrap at). At 200% root font-size these overflowed the 375px viewport — a real WCAG 1.4.4 failure, not a hypothetical one. Fixed with `flex-wrap` + `min-w-0`/`break-words` on the money-bearing containers; verified overflow is gone screen-by-screen (`document.body.scrollWidth` check) after each fix, not just visually.
- **The shared TabBar had the same overflow bug on every single screen, undetected until now.** Its flex tabs (`<li className="flex-1">`) had no `min-w-0`, so at 200% zoom the tab labels refused to shrink and the nav overflowed the viewport — on literally every page, not just one. It went uncaught through the whole M0–M8 build because the verification technique itself had a race condition: `document.body.scrollWidth` was read immediately after setting `documentElement.style.fontSize`, before the browser had reflowed. Fixed (`min-w-0` on the tab `<li>`) and re-verified on Home/Money/Menu/Staff with a corrected check that awaits reflow (~250ms) first. **Any future 200%-zoom check must wait for reflow before reading `scrollWidth`, or it will silently pass on real bugs.**
- **A `<select>` element's own `scrollWidth` is not a trustworthy overflow signal by itself.** While chasing more zoom bugs, an ingredient-picker `<select>` reported `scrollWidth` far wider than its container even after `width:100%` and `min-width:0` were confirmed correctly applied via computed styles — a screenshot showed the box was in fact correctly sized and clipped; the browser's native option-text measurement leaks into `scrollWidth` for `<select>` regardless of the rendered box size. **Going forward, corroborate a `<select>`'s reported overflow with a screenshot before treating it as a real bug** — unlike every other element type checked this session, where the metric and the visual agreed.
- **Custom expense labels: fixed categories stay the backbone, free text is additive only.** The first real pilot owner wants to name her own expense categories. Cost recovery, the health-check bands, and the Menu screen's rent-share-per-drink are all keyed off the 11 fixed `expense_categories` codes — letting her replace them with arbitrary text would require reworking all three. Resolution (her call, via an explicit choice): added `expenses.custom_label`, a free-text field shown only under "Other" in the manual-entry form, saved alongside the fixed category code and not used in any calculation — display-only, so her own vocabulary shows through without the money math ever branching on arbitrary strings. **Not yet surfaced anywhere it's saved** (no expense-ledger screen exists yet) — captured for now, display is a fast follow.
- **Manual staff roster + manual hours, built for the case where the register doesn't export labor.** The pilot owner's Toast plan is unpaid and it wasn't confirmed whether it exports timecard data at all (her call, given the uncertainty: "build for the safer assumption"). Added `employees.default_hourly_wage_cents` / `.active` and a real add-employee + log-a-shift UI (`/more/manage-staff`) that writes ordinary `timecards` rows — indistinguishable downstream from a POS sync or CSV import, so the Staff screen, Menu's staff-time-per-drink, and Home all just work. If her Toast tier turns out to export labor too, the existing labor-CSV importer (already Excel-capable) covers that path with zero extra work.
- **Ingredient-cost importer does not convert units.** No real export sample from the pilot owner's inventory site (`franchiseinventorymanagement.com`, no API) was available to build against, so `parseIngredientCostsCsv` assumes "cost per unit" already means cost per the ingredient's existing base unit (g/ml/each) — no lb→g, gal→ml, etc. conversion. A brand-new ingredient's base unit is chosen explicitly in the review step (a simple keyword-based guess — "milk"/"cream" → ml, "cup"/"lid" → each — that the owner can override) rather than assumed silently. Revisit once a real export file is available to confirm the actual unit vocabulary and whether conversion is needed.
- **"Try a scenario" works at menu-item granularity, not single-ingredient.** The owner asked, as an example, "what if I gave oat milk away free for a few days" — but `MenuItemSnapshot` only carries one blended `ingredientsCentsToday` total per drink, not itemized recipe-line costs per ingredient (recipe lines exist in the schema but aren't exposed to the snapshot/viewmodel layer for arbitrary what-ifs). Built `lib/calc/scenario.ts` + `/more/try-scenario` to test "what if this whole drink's ingredients cost $X for N days" instead — same spirit, coarser precision. Isolating a single ingredient across every drink that uses it is a real, larger data-layer addition (recipe-line costs would need to flow into `BusinessSnapshot`) — flagged as a fast follow, not built.
- **Four real, previously-invisible bugs, found only once the schema ran against an actual database.** Every one of these passed `npm run build`/`lint`/`test` cleanly and looked fine against fixture data — none were catchable without real Postgres and real volume:
  1. `20260926000008_rls.sql`'s generic per-table RLS loop included `businesses` itself, trying `is_member(business_id)` — but `businesses` has no such column (its own `id` *is* the business id; a correct override policy already existed a few lines below, but the loop errored before ever reaching it). `db:reset` failed on its very first real run. Fixed in place, not as a follow-up migration — this file had never successfully applied anywhere before this session, so there's no prior deployment's history to preserve by leaving it broken and layering a fix on top.
  2. The Menu screen's `getMenuItemSnapshots()` summed `order_lines.quantity` per item by fetching every matching row. PostgREST silently caps a plain `select` at 1000 rows with **no error and no truncation signal** — the pilot café's 28-day seed has 12k+ matching rows, so quantity sold was badly undercounted for every item, which inflated the staff-time-per-drink math by roughly 10x (every item showed a large *negative* "kept per cup" instead of a healthy positive one). First fix attempt (paginate with `.range()` in a loop) was logically correct but too slow against the joined query at this volume — timed out after ~50s. Real fix: `menu_item_quantities_sold()`, a small SQL function (`20260928000013`) that sums server-side in one indexed `GROUP BY` instead of transferring thousands of rows. **Any other query in this codebase that can plausibly return more than 1000 rows has this same silent-truncation risk** — `order_lines` was the only one proven to hit it so far, but it wasn't specifically audited elsewhere; worth a deliberate pass before the pilot café's data volume grows further.
  3. & 4. `order_lines.menu_item_id → menu_items` and five other "soft" foreign keys between business-scoped tables (`modifier_recipes → ingredients` ×2, `orders → locations`, `timecards → employees`, `expenses → recurring_costs`, `expense_lines → ingredients`) had no `ON DELETE` rule in the original `docs/04-data-model.md` schema — defaults to `NO ACTION`. Deleting a business cascades to *both* sides of each pair independently (e.g. both `menu_items` and, via `orders`, `order_lines`), and Postgres doesn't guarantee one finishes before the other, so `db:reset`'s reseed (delete-then-reinsert the demo business) failed on each of these in turn until all six were changed to `ON DELETE CASCADE` (`20260928000014`, `20260928000015`) — safe because none of these are ever hard-deleted outside a whole-business delete (account deletion, or this reseed) in normal app operation.
  Also needed, operationally rather than in SQL: `scripts/db-reset.mjs` now sends `NOTIFY pgrst, 'reload schema'` after applying migrations — applying raw SQL via `pg` (no Supabase CLI available in this environment) doesn't trigger PostgREST's automatic schema-cache reload, so a brand-new RPC function 404'd from the API for a few minutes even though it existed in Postgres. Would have bitten every future migration that adds a function/table without this.
- **A brand-new real signup landed on the shared Demo café's data instead of onboarding — found live, by the actual first real signup this app ever had.** Every new user is auto-granted membership on the demo business (M1 trigger, so they can explore it deliberately later) — but nothing sent a user with no *owned* business to onboarding first, so `getActiveBusinessId()`'s demo-fallback silently became the default landing experience instead of a deliberate choice from the café switcher. Fixed with `requireOwnBusiness()` (`lib/auth/requireUser.ts`) — redirects to `/onboarding` until the user has a non-demo business — applied to all 19 screens that read/write business data; `/onboarding`, `/more`, and `/more/delete-account` deliberately keep plain `requireUser()` so they stay reachable regardless of onboarding status. This also surfaced a second bug the fix's own first real exercise hit immediately: `ensureOwnBusiness()` tried to set a cookie from `onboarding/page.tsx`'s render body, which Next.js disallows outside a Server Action/Route Handler — every brand-new business creation would have crashed. Removed the cookie-set entirely (not needed: `getActiveBusinessId()` already prefers an owned business over demo whenever no cookie is set; the real café-switcher action is separate and unaffected). Verified against the live database with two freshly-created real (non-seed) users — first sign-in now correctly lands on onboarding step 1 and creates a real empty business; every main screen renders correctly with zero data afterward. Also fixed two "Infinity"-in-the-UI display bugs (Home's break-even teaser, Break-even's explainer line) this same empty-business testing surfaced — missing the same `Number.isFinite` guard the Break-even hero number already had.
- **Home's "getting started" empty state, and faster daily staff-hours entry.** Same real user hit a wall of $0.00 with no obvious way back to onboarding after skipping past it once. Added an `isGettingStarted` signal to `homeViewModel.ts` (zero sales in the last 28 days *and* not one bill entered — a strong "never finished setup" signal, not just a quiet month) that shows a clear card with direct links to onboarding, sales upload, bills, and staff. Separately, `/more/manage-staff`'s "log hours" accordion only let one employee's form be open at a time — real friction for a daily ritual across a whole team whose schedules genuinely vary day to day (which the per-day logging model already supported correctly; the UI just made it tedious). Now every active employee's form is expanded by default.
- **The "X not added yet" banner on Home wasn't actually a link — the direct cause of the client's "I added an expense and it disappeared, and now I can't add anything" report.** Investigated by reproducing the exact save against her real account's data: the expense-save mechanism itself works correctly (a direct insert through her real RLS-scoped session succeeded with no error, and her `expenses` table was confirmed genuinely empty beforehand — not a display bug, a real "nothing saved"). The actual bug: `{category} not added yet. Add` on Home was a plain string with no `href` or `onClick` — tapping "Add" did nothing, which is indistinguishable from "my save vanished" to someone who never reached a working entry screen in the first place. Fixed: it's now a real link to `/more/bills` (the correct destination for a *recurring* category like rent or supplies — a one-off "Add cost" entry was never the right fix for that banner). Audited the rest of the codebase for the same "text pretending to be a link" pattern; found no other instances.
- **The Menu screen's recipe editor, promised in onboarding's own copy since M3/M4, was never built — and its absence had a bigger consequence than a missing edit button.** Nothing in the app creates a `menu_items` row for an owner using CSV/Excel import instead of a live POS catalog sync (Square's adapter does; the CSV sales importer only matches existing item names, it never creates new ones) — so without a recipe editor, an owner on that path can *never* get a menu item to exist at all, and the Menu screen and every per-drink cost number stay permanently empty. This is exactly what the client hit. Built `/menu/manage` (linked from the Menu tab's header and from a clear empty-state prompt): add a drink (name, price, prep time, category), then add/remove recipe lines against it (pick an existing ingredient or create one inline with its base unit, plus quantity) — same "confirm the unit for anything new" pattern as the ingredient-cost importer. Verified end-to-end against the client's real account (add item → add new ingredient → recipe line → Menu screen picks it up with no errors), then cleaned up all test data.
- **Staff scheduling was first ruled out of scope, then explicitly requested and built — this supersedes that first decision.** Originally clarified rather than built: `docs/01-product.md`'s "Don't build" list excludes "Scheduling," with the stated rationale "Square/Toast already do it." The client then pushed back directly: her staff's days/hours are fixed week to week, and she shouldn't have to log each person's shift by hand every day — and pointed out this was *causing* a visible bug (Staff screen's "on shift now" was always empty, since the manual-entry form always fills in both a clock-in and clock-out at once, so an "open" shift never existed for the app to recognize). The doc's "Square/Toast already do it" premise doesn't hold for this café (unpaid Toast tier, no labor export) — the same reason a manual staff roster already exists as a documented deviation from the same list. Planned via `EnterPlanMode` given the size (new table, materialization job, two rewritten UI sections) and the explicit ask to "think before you build this." Built:
  - `staff_schedules` table (`supabase/migrations/20260929000016_staff_schedules.sql`): day-of-week + start/end time per employee, `effective_to = null` for an ongoing weekly repeat or a bounded range for "just this month" — one table, one save action, both of the "weekly or monthly, give both options" modes she asked for. RLS enabled in this same migration rather than the shared per-table loop in `20260926000008_rls.sql`, since that file is numbered (and therefore applied) before this table exists — added that ordering note in both files. Applied to the live DB with a new `scripts/db-migrate.mjs` (schema-only, unlike `db-reset.mjs` — never touches the demo business or any real business's data).
  - `lib/data/materializeSchedule.ts`'s `ensureTodayScheduledShifts()`, called once near the top of `getSnapshot()`: for each employee with an active schedule matching today's weekday, writes a real `timecards` row (tagged `schedule_id`) if one doesn't already exist for that day — same row shape a POS sync or manual entry writes, so every existing cost calculation needed zero changes. Cheap on repeat page loads (one existence check; only calls the rollup recompute below when it actually inserts something).
  - Replaced the old always-insert "log hours" form with a real find-or-update ("edit a day") in `lib/actions/staff.ts`'s `saveShiftForDay()` — the old version silently created a second row (double-counting that day) if the same day was ever logged twice. It also clears `schedule_id`, which doubles as the "predicted vs. confirmed" signal shown in the UI. `markDayAbsent()` is a thin wrapper for the one-tap no-show case.
  - Two real bugs found and fixed while building this, both about a predicted-but-not-yet-happened shift: `paidHoursForTimecard` (`lib/calc/staff.ts`) trusted any non-null `clock_out` as already having happened, so a shift auto-filled with a *future* end time would have been costed for hours that hadn't occurred yet — fixed by capping at `now`, with `lib/pos/rollup.ts`'s independent, duplicated copy of the same math replaced with a call to the one fixed, tested function instead of carrying its own copy of the bug. `staffViewModel.ts`'s "on shift now" filter changed from `clockOut === null` to a real time-window check, since a schedule-predicted shift has both times filled in ahead of time — this is the actual fix for the always-empty "on shift now" list.
  - Verified against the client's real account end-to-end: set a weekly schedule → a real timecard auto-filled for today → Staff screen correctly showed them on shift with cost-so-far capped at elapsed time (not the full shift) → edited that day's hours in place (confirmed no duplicate row) → cleaned up all test data afterward.
- **Critical: `cost_per_base_unit_micros` was computed with a ×10,000 conversion instead of ×1,000,000 everywhere it was written from a dollar cost — a 100x understatement of ingredient cost, caught live while verifying the new inline ingredient-cost feature below, not by inspection.** `itemIngredientCostCents` (`lib/calc/ingredients.ts`) divides `quantity × micros` by 1,000,000 to get cents back — confirmed against its own passing unit test and `scripts/seed/demoData.mjs`'s `ingredientPriceMicros()`, both of which correctly multiply by `1_000_000`. But `lib/actions/csvImport.ts`'s `importIngredientCostRows` (the real "Upload → Ingredient costs" screen's write path) multiplied by `10_000` instead, per a comment that mislabeled the unit as "micro-cents" rather than "micro-dollars." The effect: importing "$50/2000g of beans" would have priced it as if it cost $0.50/2000g — every per-drink ingredient cost computed from an imported price would round to near-zero, which is exactly the "priced at $30, keeps the full $30" symptom the client reported. **Checked project-wide before fixing: zero `ingredient_prices` rows anywhere in the database have `source = 'invoice'`** (the importer's fixed source value), meaning she had never successfully used that screen yet — so no bad data existed to migrate, only the bug itself to fix before she tries it. Fixed the conversion factor in `csvImport.ts`, and used the correct one from the start in the new inline-cost feature below. Verified against her real account: "$50.00 for 2000 g" + "18 g used per Latte" now correctly computes to $0.45 ingredient cost (was $0.0045 before the fix), and the Menu screen's "you keep" correctly drops from $30.00 to $29.55.
- **Menu item cost warnings, staff roster editing, and inline ingredient pricing — three real gaps found by walking through the client's exact complaints, not just re-explaining the UI to her.** She reported: (1) a latte priced at $30 showing "$30 yours" with no warning that ingredients/staff were never entered — correct suspicion, the app was silently treating an empty recipe as a genuinely free drink; (2) no way to edit a staff member's name/role/wage after adding them, only log hours or deactivate; (3) the recipe editor "only lets me add one ingredient" and gives no way to enter what an ingredient actually costs, so she couldn't see how the app could ever calculate a real number. Fixed all three:
  1. `MenuItemSnapshot.hasRecipe` (`lib/data/types.ts`/`snapshot.server.ts`) is now `true` only when the item has at least one recipe line *and* its computed ingredient cost is actually nonzero (not just "a recipe row exists") — a recipe with unpriced ingredients still shows the warning, since the underlying number is still wrong. Menu's featured card and every list row link to `/menu/manage` when this is false, instead of silently showing a full-margin number.
  2. `updateEmployee()` (`lib/actions/staff.ts`) + an "Edit details" toggle per employee row in `ManageStaffPanel.tsx` — deliberately separate from "log hours"'s wage field, which stays a per-shift override so editing the roster default never rewrites past timecards' pay history.
  3. The "add ingredient" flow in `/menu/manage` was always multi-add (state resets after each save, dropdown grows to include what you just created) — the actual problem was no feedback confirming it worked and no way to enter a cost at all. Added a persistent "Added ✓" confirmation, an explicit "there's no limit, keep going" hint, and an optional cost field ("$X for Y g/ml/units") on new-ingredient creation that writes an `ingredient_prices` row via the now-fixed micros conversion. Also fixed two bugs hit live while building this: `ingredient_prices.source` is `NOT NULL` (added `source: 'manual'`, missing on the first attempt); and a brand-new price's `effective_from` must use the *business's own timezone's* "today" (`formatInTimeZone`, matching every other date-stamping code in this codebase), not the server's raw UTC date — snapshot queries filter `effective_from <= business-local today`, so a price entered in the evening in a timezone behind UTC would otherwise be silently excluded from every cost calculation until the server's UTC date caught up. Also deduplicates by ingredient name (case-insensitive) when creating a new ingredient from the recipe editor, so typing an existing name reuses it instead of forking a second entry with no way to tell them apart. All verified against the client's real account end-to-end (add → recipe → Menu number updates correctly), then every test row cleaned up afterward.
- **Critical: Home and Money's Today/Week/Month periods were all showing the identical number — two independent bugs stacked, both found live against the client's real (mostly gap-filled) data, neither visible against the demo café's continuous 90-day dataset.** She had entered her monthly bills ($15,020/month total) and reported every period tab showing the same "-$500.67" no matter what.
  1. `runningCostsForDays` (`lib/viewmodels/period.ts`) prorated running costs across `sorted[0].date`..`sorted[last].date` of whatever `DailyFacts[]` a period happened to return — but that array only contains days with an actual `daily_rollups` row. Her account had exactly one (today, from the schedule-materialization work above), so "week" and "month" collapsed to the same single-day range as "today": rent and bills accrue every calendar day regardless of whether a sales file was ever uploaded for it, so proration must never shrink to "however many days happen to have a row." Replaced with `periodCalendarRange`/`previousPeriodCalendarRange` (same file), computed directly from `snapshot.todayDateStr`/`monthKey` — today, the last 7 calendar days, or month-to-date, independent of rollup coverage. Verified against her real numbers: Today $500.67 (1/30 of $15,020), Week $3,504.67 (7/30), Month $14,018.67 (28/30, 28 days elapsed in September) — each period now a clean multiple of the others, not identical.
  2. Even with #1 fixed, tapping the Today/Week/Month pills in a real production build (`next build && next start`, not the dev server — confirmed this was not a dev-only Turbopack artifact) changed the URL and the active pill but never the numbers underneath, until a hard reload. `PeriodSwitch.tsx`'s `router.replace()` for a searchParams-only change wasn't forcing this force-dynamic page to refetch — added `router.refresh()` right after it, which is the documented way to bypass the client router cache. Confirmed fixed against the same production build: clicking through Today → Week → Month → Today each correctly showed $500.67 / $3,504.67 / $14,018.67 / $500.67 in turn.
  - Also fixed in the same pass, found while re-verifying Money's "Profit & costs" tab against her now-real (mostly zero) numbers: `ProfitCostsView.tsx`'s running-costs-as-%-of-sales used `Math.max(1, salesCents)` to avoid dividing by zero, which with $0 real sales turned a correct $14,018.67 running-cost figure into a displayed "150200000%". "% of sales" is undefined when sales are $0, not astronomically high — changed to show 0% in that case rather than a number computed against a fake 1¢ of sales.
- **Café name was permanently stuck at "My café."** `lib/actions/onboarding.ts` creates every new business with that literal placeholder name and nothing anywhere ever let it be changed. Added `updateBusinessName()` (`lib/actions/business.ts`, new file) and a tap-to-edit name card at the top of `/more` (`EditBusinessName.tsx`) — explicitly blocked for the shared demo business (every account has membership on it, nobody owns it). Verified live: renamed, confirmed it updated on Home's header too, renamed back before finishing.
- **"Try a scenario" looked completely broken — always "$0.00, no change" no matter what was typed — for two separate, stacked reasons.** She said she didn't understand the use case and there was nothing to actually try.
  1. The cost input defaulted to a hardcoded `"0.00"` regardless of the picked drink's actual ingredient cost, so the calculator opened already showing a (correct but confusing) "you'd save money" result before anyone had touched anything, and the copy inconsistently mixed "price" and "ingredient cost" language (subtitle and footer said "price," the one input label said "ingredient cost"). Now the input starts at the picked drink's own current cost (a genuine $0 change) and resets to the new drink's cost on every selection change, with an explicit one-line explainer at the top and copy corrected throughout to consistently say "ingredient cost." Found and fixed a floating-point snag doing this: seeding the input from a fractional-cent value via raw `toFixed(2)` (e.g. `0.015.toFixed(2)` → `"0.01"`, not `"0.02"`, since `0.015` isn't exactly representable in binary) could show a different number than the matching dropdown label, which rounds first — now both round via the same `roundHalfUpToCent` before formatting.
  2. The real gap: `scenarioExtraCostCents` multiplies the typed cost delta by `avgDrinksPerDay` (`quantitySoldLast28Days / 28`) — on her account, every menu item has zero sales in the last 28 days, so that multiplier is 0 for everything, meaning literally any price typed for any drink computes to "$0.00 impact." Mathematically correct given no sales history, but indistinguishable from the tool being broken. Added a distinct message for this case ("{drink} hasn't sold any cups in the last 28 days... this will start working once you've uploaded some sales") instead of the normal result card, so a data gap reads as a data gap rather than a bug.
- **Menu sizes are separate menu items, not one item with a size multiplier — confirmed with her directly before building, since it changes what a per-size cost number actually means.** She described drinks like "Latte" coming in 12/16/18 oz and asked for the ingredient list, which she said "looks very bad," to be a real table. Two designs were possible: one recipe scaled by a per-size multiplier (less setup, but 16 oz/18 oz costs become an estimate, not what that size actually uses), or each size as its own full item with its own real price and recipe (matches how Toast/Square already treat sizes as separate catalog items). She picked the latter. Added `menu_items.base_name`/`size_label` (`20260929000017_menu_item_size.sql`) — additive metadata only; `name` stays the single string every other query reads, computed as `"{base_name} {size_label}"` at creation. `/menu/manage` (`ManageMenuPanel.tsx`) groups items by `base_name` under one heading with a "+ Add another size" shortcut that prefills the name, and the ingredient list is now a real `<table>` (Ingredient / Amount / remove) instead of a flex row. Prep time input/label changed from seconds to minutes — `docs/05-calculations.md`'s formulas and the stored `prep_seconds` column are untouched; only the editor's unit changed, converting at submit. Deliberately did not add a general "edit an existing item" action — menu items have only ever supported add + deactivate, and that's unrelated scope. Verified live: added a real "Latte" with two sizes on her account, confirmed the grouped header, the size rows, and the ingredients table all render correctly at 375px, then removed the test data.
- **Salaried wages convert to hourly using the employee's real weekly schedule, not a fixed 40-hour assumption — confirmed with her directly, since it changes staff cost.** She asked to enter a salary per month or per year instead of computing hourly herself. Every cost formula (`docs/05-calculations.md`) is built on `timecards.hourly_wage_cents`, so a salary has to become an hourly-equivalent somewhere. Two designs: assume a fixed 40 hrs/week always, or derive it from that employee's actual scheduled hours (built earlier this session) — she picked the latter, falling back to an explicit "hours per week" field only when that employee has no schedule yet. Added `employees.wage_period`/`wage_amount_cents` (`20260929000018_employee_wage_period.sql`, backfilled to `'hour'` for every existing employee — zero behavior change). `default_hourly_wage_cents` keeps its exact existing role and meaning everywhere it's already read; for salaried employees it's now a cached hourly-equivalent. Two new pure functions in `lib/calc/staff.ts` (`weeklyScheduledHours`, `hourlyWageCentsFromSalary`, both tested) do the conversion — `hour` passes through, `year` is amount ÷ (hours/week × 52), `month` is the same ×12. `setWeeklySchedule` (`lib/actions/staff.ts`) no longer trusts a client-supplied hourly rate at all — it now looks up the employee's own wage record server-side and, for a salaried employee, recomputes the hourly-equivalent from the schedule *being saved*, which is what makes the rate "stay correct automatically" as a schedule changes rather than needing her to reopen "Edit details." `addEmployee`/`updateEmployee` do the same lookup (or use the fallback hours field when there's no schedule yet) and refuse to save a salaried wage that computes to $0/hr. Verified live against her real account: converted Jose (hourly, $20/hr) to a $4,000/month salary with his real 2-day schedule — derived $115.38/hr, matching the formula by hand; added a third scheduled day and re-saved the schedule — recomputed to $57.69/hr with no other action taken, confirming the auto-recompute path; added a test employee on a yearly salary with no schedule yet, using the hours/week fallback — derived correctly; then reverted Jose to his original hourly $20/hr and deleted the test employee, leaving her real data exactly as found. (The "hours/week fallback" number field described here was removed the same day — see the next decision below.)
- **Removed the numeric "hours per week" fallback for salaried wages — a real weekly schedule is now the only way to set one, per her direct feedback.** She pointed out that letting a salaried wage resolve from a typed-in number "defeats the purpose": the schedule isn't just a wage-conversion input, it's what makes an employee's cost show up anywhere at all (`materializeSchedule.ts` only writes daily `timecards` for employees with an active schedule row — no schedule means no cost ever accrues and they never show as "on shift," salaried or not). A fallback number let her create a salaried employee who looked fully set up but was invisible to every downstream number. Fixed by making salary resolution schedule-only: `addEmployee`/`updateEmployee` (`lib/actions/staff.ts`) no longer error or need a fallback — a salaried employee saves immediately with `default_hourly_wage_cents = 0` ("pending") if there's no schedule yet, same as any other unfinished setup step, rather than being blocked. The Add form auto-expands the new employee's row (`addEmployee` now returns the new id) so the Weekly Schedule section — already right there in the same card — is immediately visible; both the Add form and "Edit details" show a plain hint ("Set their weekly schedule below…") instead of a number field whenever a salaried period is picked. `WeeklyScheduleEditor`'s save button was gated on `defaultHourlyWageCents > 0`, which would have made a still-pending salaried employee unable to ever save their first schedule (chicken-and-egg) — changed to gate on `wageAmountCents > 0` instead (always true once a wage's been entered, regardless of whether it's resolved yet). `setWeeklySchedule`'s existing $0-wage guard now only applies when the save actually has days on it, so clearing a schedule to empty isn't blocked by the same check. **Also fixed in the same pass, since it mattered more now that salary conversion depends entirely on real schedules: `weeklyScheduledHours` (`lib/calc/staff.ts`) previously treated a day whose end time is on/before its start time as a zero-length shift instead of one crossing midnight** (e.g. a closing shift "18:00"–"01:00" contributed 0 hours instead of 7) — now adds 24h to the end time when this happens, tested. This was flagged but left unfixed in the original build (see the decision above); worth doing now because the fallback number used to mask it as a non-issue, and it no longer does. Verified live: added a salaried test employee with no schedule (saved instantly as pending, $0/hr, confirmed via direct query), gave them a one-day schedule and saved it — derived hourly rate appeared correctly with no separate action; then removed the test employee.
- **Critical: `importSalesRows`/`importLaborRows` (`lib/actions/csvImport.ts`) would have double-counted every overlapping day of a daily rolling-window CSV upload — found by tracing through the exact workflow being planned for the pilot café (re-exporting "last 30 days" from the register every day), not from a report.** Both functions build a stable-looking id (`pos_order_id` / `pos_timecard_id`) to upsert on, so re-uploading *the same file* is correctly a no-op — but the id included the row's index within that file's array (`` `csv-${date}-${item}-${i}` ``), not just its content. A rolling window shifts which absolute index a given calendar day lands at from one day's export to the next, so the same day's row gets a *different* id on day 2's upload than it got on day 1 — the upsert's `onConflict` match misses, and a second `orders`/`timecards` row gets created for a day already imported, silently doubling that day's sales/wages every time the window overlaps. Fixed by dropping the index from both ids — `` `csv-${date}-${item}` `` and `` `csv-${employee}-${clockIn}` `` — which are already unique per real row (sales exports are one row per item per day per the doc; a clock-in timestamp is unique per shift), so the same day's row now always upserts onto the same order/timecard no matter where it sits in a later file or how many overlapping uploads it's been through. This is the same content-based-key pattern `expenses.dedupe_key` already used correctly for the bank-statement importer (sha256 of business+date+amount+vendor) — the sales/labor importers just hadn't followed it. Verified directly against the live database (not just read): upserted a synthetic order twice with the old vs. new key shape, confirming the old shape's raw insert hits the unique constraint as a duplicate-looking-new-row risk while the new key correctly merges onto the same row (`id` unchanged, `net_sales_cents` updated 500→700, exactly one row) — then removed the test row. **This means: yes, an owner can upload a rolling "last 30 days" export every day and it will accumulate correctly, not double-count or forget prior days** — daily rollups recompute from whatever's in `orders`/`timecards` regardless of which upload wrote them, so once a day's row is upserted in place it behaves identically to a live POS sync from that point on.
- **Real upload history, unmatched-item warnings, and a proper alert — asked directly right after the dedup fix above: "it should work no matter how she gives it, and if we're missing something we should notify them, and I should be able to see how it's working."** The dedup fix answered the money-math half; this is the rest. Two gaps closed with two existing patterns, not new ones: (1) `uploads` (`docs/04-data-model.md`: `kind`/`storage_path`/`status`/`summary jsonb`) has existed in the schema since M1 and nothing had ever written to it — `importSalesRows`/`importLaborRows`/`importIngredientCostRows` (`lib/actions/csvImport.ts`) now each insert one row per run with a real summary (rows imported vs. in file, date range, and for sales, which item names didn't match anything on the menu), and return that summary to the importer UI immediately instead of just a bare count. New `/more/uploads/history` (`lib/data/getUploadHistory.ts`) lists them. (2) An unmatched item is the realistic "something's wrong" case — the sale still counts toward the day's total (`daily_rollups` sums `order_lines` regardless of `menu_item_id`), but silently never shows up in Menu's per-drink numbers. Reused the existing alerts system (`missing_bill`/`voids`/`meal_break`) rather than inventing a second notification concept — added `unmatched_sales_items` to `AlertKind` (`lib/data/getAlerts.ts`) and a `describeAlert` case (`components/alerts/alertContent.ts`), created directly inside `importSalesRows` at the moment it's found (not the batch `generateAlerts()` pass, since it's tied to one specific upload) and deduped by the sorted unmatched names via `hasOpenAlert` (exported from `lib/alerts/generate.ts` for this) so a re-upload of the same or an overlapping file doesn't spam a new alert for a problem she hasn't fixed yet. **Found live, not from inspection: the `alerts` table's `kind` column has a real check constraint in the actual migration (`20260926000007_recovery_rollups.sql`) limiting it to the 7 original values — `docs/04-data-model.md`'s copy of that same table only shows the list as a comment, which is why it wasn't obvious until the alert insert failed silently against the live database** (Supabase JS swallows the error since the call site didn't check it, matching `lib/alerts/generate.ts`'s own existing fire-and-forget style for alert inserts). Fixed by widening that constraint alongside `uploads.kind`'s in the same migration. Verified end-to-end against her real account: uploaded a synthetic sales file with one real item and one deliberately unmatched name — confirmed the `uploads` row, the alert, and the history page all showed the right thing; re-uploaded the identical file and confirmed exactly one alert existed, not two; uploaded a labor file and confirmed a clean "done" history entry with no false warning. **Also found, not fixed: the labor CSV importer matches/creates employees by a `csv-<slugified-name>` id and has no path to match an existing manually-added employee (like the ones `/more/manage-staff` creates with no `pos_team_member_id`) by name** — uploading a labor file for "Jose" while a manually-added "Jose" already exists creates a second, duplicate employee record rather than attaching hours to the real one. Pre-existing behavior, not introduced by this change; found while testing the labor upload path for this feature and worth fixing before she relies on the labor importer for real, but out of scope for what was asked here. All test data (2 synthetic orders, 1 duplicate test employee, 3 `uploads` rows, 1 alert, 1 `daily_rollups` row) removed afterward.
- **Labor import employee-matching: fixed the duplicate-"Jose" bug directly above, and — since she asked specifically — never silently guesses when a name is ambiguous.** `importLaborRows` (`lib/actions/csvImport.ts`) previously keyed employees only on a synthetic `pos_team_member_id = csv-<slug>`, so a manually-added employee (who never has one) always looked brand new on their first labor upload. New `resolveEmployeeIds` helper tries three tiers in order: (1) *remembered* — an employee already carries that exact `csv-<slug>` id from a past resolution, used with zero owner input; (2) *confident* — exactly one employee's name matches the CSV name case-insensitively, used automatically and the id backfilled so tier 1 catches it even faster next time; (3) *ambiguous* — zero or 2+ name matches (a nickname/typo like "Jose" vs. "Jose Sanchez," or two real people sharing a name) — resolved from the owner's explicit choice instead of guessing. Confirmed the UX for tier 3 with her directly before building: a visible review section (`components/uploads/LaborCsvImporter.tsx`, same pattern `IngredientCostImporter.tsx` already uses for new ingredients) listing each ambiguous name with a dropdown — every existing employee as an option, defaulted to "+ Add as new employee" — not a hard block, so a file full of genuinely new hires doesn't get stuck. Whichever she picks (existing person or new) gets the same `pos_team_member_id` backfill, so that exact name is remembered from then on regardless of which tier resolved it. **Found while wiring this up: a "use server" file may only export async functions — a plain `export const NEW_EMPLOYEE = "__new__"` sentinel silently broke the entire module** (`next build` reported "the module has no exports at all" with no line number, since Turbopack's server-action transform rejects the whole file rather than just the bad export) — moved the constant to `lib/constants.ts` (a plain module, already used for `DEMO_BUSINESS_ID`), which is now the actual reason type-only exports (`SalesImportSummary` etc.) are fine in a `"use server"` file but a runtime const isn't. Verified live against her real account: uploaded hours for "Jose" (who already existed) with no review interaction — attached to the real employee, no duplicate; uploaded hours for "Maria" (nobody by that name) — showed the review picker defaulted to new, imported, confirmed a real new employee was created and that re-uploading "Maria" later needed no further prompt; created two temporary same-named "Carlos" test employees, uploaded a "Carlos" shift, confirmed both candidates appeared in the dropdown, picked the second one specifically, confirmed the hours attached to that exact employee and not the other. All test employees, timecards, and the test day's rollup row removed afterward; Jose's own record reset to exactly its original state (`pos_team_member_id` back to `null`).
- **First real requests from the first real pilot café (Seiyun Yemeni Coffee — real business created 2026-09-30 after her magic link finally went through), sent with her actual expense sheet ("For Raj.xlsx"): a repeatable "Other" bill instead of one generic bucket, and a suggested price per menu item based on her real costs.** Her spreadsheet's "fixed" sheet has ~6 real monthly bills that don't fit any of the 10 fixed categories (Cintas, iPostal, Storage, Workers comp, Trash, Building Maintenance) — directly explains why she asked to "modify the text for 'other.'" Her "food" sheet is pre-aggregated ingredient+packaging cost per drink, already broken out by size, which happens to be exactly what the app's own recipe editor already computes once a recipe is priced (`itemIngredientCostCents`) — so the price recommendation she asked for needed no new input from her at all.
  1. **`/more/bills` (`components/bills/BillsManager.tsx`) rewritten so "Other" is a repeatable list, not a single slot.** The 7 fixed categories (rent, utilities, water, internet, insurance, loan, software) keep today's one-row-per-category behavior; "Other" now lists every active row with its own editable label (a plain text field the form never had — `saveRecurringCost`, `lib/actions/expenses.ts`, already accepted and stored a free-text `label`, so this was a UI-only gap) plus a "+ Add another Other bill" action. `deleteRecurringCost`'s existing soft-delete-by-`id` already works per-row unchanged.
  2. **Found while building step 1, not from her report — a real money bug the feature would have walked straight into**: `lib/data/snapshot.server.ts`'s running-cost builder picked recurring costs with `.find()` — exactly one row per category. The moment "Other" could hold more than one active row, every downstream number (Home, Money, cost recovery, health bands, rent-share-per-cup) would have silently used whichever row happened to come first and dropped the rest — a second "Other" bill would have been invisible everywhere except the Bills screen itself. Fixed by summing all active rows per category (`.filter()` + reduce), matching how `expensesThisMonth` a few lines above already sums multiple expense rows for a category. Verified live (mail2raj27's test account, not Seiyun's — she was actively working in hers at the time, not worth the collision risk): added two "Other" bills ($240 + $15) with distinct labels, confirmed both listed independently on `/more/bills`, and confirmed Money's cost-recovery bucket correctly showed "Other $255.00" (the sum) and the month's total bumped from $15,020 to $15,275 — not just one of the two amounts. Both test rows removed afterward.
  3. **Price recommendation: `recommendedPriceCents` (`lib/calc/ingredients.ts`, new, tested) = ingredient cost ÷ 30%, rounded UP to the next 25¢.** 30% is the midpoint of `docs/05-calculations.md`'s own documented "healthy" ingredients band (25–35% of price) — not a new number invented for this. 25¢ increments match the app's own existing convention (Break-even's "raise all prices 25¢" what-if). Rounds up, never down, so the suggestion never quietly lands under the target margin. Deliberately **ingredient-cost-only, not a full loaded-cost recommendation** — staff-time-per-drink and rent-share-per-drink both derive from `quantitySoldLast28Days`, which is 0 for every item on a brand-new account with no sales yet, so factoring them in today would produce a meaningless number; labeled clearly on screen as ingredient-based so it reads as an honest partial answer, not a finished one. `lib/data/getMenuItemsForEdit.ts` didn't join `ingredient_prices` at all before this (the editor had no cost figure to show); added the same latest-price-as-of-today join `getMenuItemSnapshots` (`lib/data/snapshot.server.ts`) already does for the read-only Menu screen, so both screens agree. Shown in `components/menu/ManageMenuPanel.tsx` next to any item with a priced recipe; silent otherwise, consistent with how this screen already treats an unpriced recipe as "nothing to show yet" rather than a fabricated number. Verified live: priced Latte's existing 3ml-milk recipe line at $0.50/ml → $0.015 ingredient cost → confirmed the screen showed "Suggested price $0.25," matching `ceil((1.5¢/0.30)/25)×25` by hand exactly.
  - Also answered directly (not a code change): how Raj can visit a client's account himself to test/verify without asking her to — the same admin-API magic-link technique used for every live verification this session, handed to him as a one-line command using values already in `.env.local`.
  4. **Follow-up the same day: flattened "Other" bills from a nested sub-list to full top-level cards, and fixed a real same-day-counting bug found while re-verifying.** Raj's read of her message — "modify the text for 'other'" — was that she wants each bill treated as its own line item, same as Rent/Electricity, not grouped under one "Other" header; her spreadsheet lists them that way (Cintas, iPostal, Storage... each its own row, not sub-items of anything). `BillsManager.tsx` changed from one "Other" card containing indented sub-rows to each `other`-category bill rendering as its own full card, same markup/tier as the 7 fixed categories, plus a standalone "+ Add another bill" card at the end. No schema/action change — `label` was already fully wired (`saveRecurringCost` reads/writes it for both insert and update; confirmed by reading the action directly before touching anything, since the whole point raised was "what's the point if the schema's built and the UI doesn't show it"). **Found while re-verifying live, not reported: `saveRecurringCost`'s insert and `deleteRecurringCost` both stamped `active_from`/`active_to` from `new Date().toISOString().slice(0, 10)` — server UTC, not the business's own timezone.** For any US business timezone, UTC is ahead of local time, so a bill added in the evening (business-local) got an `active_from` of the *next* calendar day — it would silently sit out of every total (Home, Money, cost recovery) until the day after it was entered, with no error or indication anything was wrong. Fixed with a small `todayDateStrForBusiness` helper (`lib/actions/expenses.ts`) mirroring the `formatInTimeZone` pattern `snapshot.server.ts` already uses; applied to both the save and delete paths. Found and fixed the same latent bug in `receiptReview.ts`'s date fallback (used only when the AI couldn't read a date off a receipt) while in there — `voiceReview.ts` already had it right and was the reference for the fix. Verified end-to-end on mail2raj27's test account (confirmed by email, business name, and account-specific dollar amounts before touching anything, after accidentally landing on Seiyun's live session the first attempt — root cause was using plain `supabase-js`'s `createClient` instead of the app's own cookie-based `createBrowserClient` from `@supabase/ssr`, so the server kept reading an old session cookie already in that browser tab; no data was changed, caught before any save): renamed an existing "Other" bill and confirmed it saved; added two new "Other" bills through the real UI and confirmed in the database that `active_from` landed on today's business-local date, not tomorrow; confirmed Money's cost recovery total moved from $15,020.00 to $15,565.00 immediately (same day, not the next), with "Other $545.00" appearing as its own bucket; removed all test rows afterward. `npx tsc --noEmit`, `npm run lint`, `npm run test` (66 tests) all clean.

## Active plan — AI-native operating-system foundation and Suggested Pricing Engine

1. Map the existing deterministic calculations, screen projections, data history, POS adapters,
   alerts, and optional extraction-AI paths; record architectural decisions in
   `docs/09-ai-native-operating-system.md`.
2. Implement the approved pricing engine as pure `lib/calc` composition with explicit quality,
   evidence, assumptions, and signals; wire it through a dedicated data service and the existing
   menu-management UI.
3. Add the minimum reusable primitives: composable current/historical café state, structured
   signals/events/forecasts, decisions and outcomes, deterministic policies, provider-independent
   optional AI, structured tools, persistence schema, and RLS.
4. Test no-AI operation, provider failure isolation, missing-data honesty, integer-cent outputs,
   non-duplication of costs, pricing behavior, signals, and deterministic recommendations; then run
   typecheck, lint, and the full test suite.

No new dependency is planned: these boundaries use TypeScript, existing Supabase clients, and
Vitest.

## Session log

_(newest first)_

### 2026-10-01 — Production incident: Menu disappeared after Codex's PR auto-deployed without its migration (fixed)
Raj handed the Suggested Pricing Engine plan to Codex as a second agent (`AGENTS.md`/this file are
written for exactly that handoff). Codex's work landed as two PRs merged into `main` on GitHub —
PR #1 "AI-native operating foundation," PR #2 "Unify Menu into a canonical control center" — and,
unnoticed until now, merging to `main` had started auto-deploying to production via a GitHub
integration that got connected on the Vercel project at some point this session (it had none before;
every earlier deploy this session was a manual `vercel --prod` from this machine). PR #2's merge
(`dec931d`) shipped code reading `menu_items.catalog_source` and the new `pos_catalog_matches` table
from `supabase/migrations/20261001000021_menu_catalog_identity.sql` — but Codex's cloud sandbox has
no network path to the production database (confirmed separately this session: it can't even reach
GitHub directly, only through its own PR-creation flow), so the migration was never applied. Every
Menu query started failing against the live schema, and the screen was apparently swallowing that
error into an empty state rather than surfacing it.

Investigated before touching anything, since the task description handed to me referenced a specific
branch/commit/script (`fix/menu-schema-safety` @ `d868b96`, `npm run db:check`) that turned out not
to exist anywhere in the repo — flagged that mismatch rather than acting on an unverified premise,
then independently confirmed the real situation: `git fetch` showed the actual merged PRs and the
real migration file; querying the live database directly (REST, not assumption) confirmed
`menu_items.catalog_source` and `pos_catalog_matches` both genuinely didn't exist yet. Confirmed
production's `NEXT_PUBLIC_SUPABASE_URL` (pulled via `vercel env pull --environment=production`)
matches the same Supabase project used for every test-account verification this session — one
project, not two. Applied all pending migrations with `node scripts/db-migrate.mjs` (idempotent,
schema-only, never touches `db:reset`/truncate/reseed — confirmed by reading the script before
running it). Re-verified the two new tables/columns now exist, then `npx tsc --noEmit`, `npm run
lint`, `npm run test` (78 tests, up from 66), and `npm run build` all clean on the merged codebase.

Live-verified on `/menu` (mail2raj27 test account): existing items (Latte, Croissant, Milk) render
with real prices again, no empty state. Added a throwaway item through the real UI, hard-reloaded
(not just client state), and confirmed via direct DB query it persisted with `catalog_source:
"manual"` and the new category system auto-assigned `ESPRESSO_DRINK` — then deactivated it,
matching the app's own soft-delete convention. Confirmed Seiyun's real bills and (empty, as before —
not data loss) menu items were untouched by the migration.

**`npm run db:check` does not exist** in this repo (only `db:reset`) — flagged back to Raj rather
than inventing one, per "never fabricate missing values."

**Not investigated, flagged for follow-up, not blocking**: the live Menu screen shows "Suggested:
$0.00" on the Latte test item, which looks like a possible bug in Codex's new pricing-engine
wiring — out of scope for this recovery task (production recovery, not a redesign), worth a second
look before relying on the new suggested-price output for real.


Reviewed the deterministic calculations, database history, screen projections, POS adapters,
alerts, and existing optional extraction-AI flow before implementation. The architecture review and
explicit deviations from the pricing plan are in `docs/09-ai-native-operating-system.md`. Implemented
the pure pricing engine, dedicated 90-day input projection, category profiles, stability/cap gates,
quality/evidence-rich output, and menu-management presentation. Added composable current/historical
café-state contracts, structured signals/events/forecast boundary, deterministic price-review
decisions, persisted decision/outcome schema with RLS, optional AI provider/NoAIProvider, a
failure-safe operating-brain boundary, and allow-listed structured tools. Inventory and suppliers
remain explicitly unavailable rather than fabricated; no scheduler, forecast model, queue,
autonomous execution, or speculative domain was added. No dependency added.

Verified no-AI pricing/profit/signals/decisions, failure isolation, missing-data honesty,
integer-cent pricing output, single-pass business cost composition, and safety caps in Vitest.

### 2026-09-30 — "Other" bills: flat layout + a same-day-counting bug (done)
Raj asked Claude to check whether Seiyun had entered a menu yet (she hadn't) and whether her
expense Excel sheet could/should be auto-imported (decided against — it's a flat per-item cost, not
a real recipe, so importing it would produce menu items with no ingredient breakdown and defeat the
price-suggestion feature just shipped). That led into a design question — how Toast/Square structure
items/variations/modifier-groups, and whether our schema already supports milk-type-style modifiers
(it does — `modifier_recipes` — but it's never been wired to any UI; scoped as a separate future
task, not built today). Then, re-reading her message, Raj felt "Other" bills should be flat top-level
entries like Rent/Electricity, not nested under one "Other" card as shipped a few hours earlier —
approved, built, and verified; see "Decisions made" above for the full detail, including a real
bug found while re-verifying (new bills not counting until the next day, from a UTC-vs-business-
timezone mismatch) and a live-account near-miss (briefly read Seiyun's real session instead of the
test account, caught before anything was changed, root-caused to the wrong Supabase client). All
test data removed; `npx tsc --noEmit`, `npm run lint`, `npm run test` clean; redeployed to production.

### 2026-09-30 — First real requests from the pilot café: repeatable "Other" bills, price suggestions (done)
Seiyun Yemeni Coffee's magic link finally went through and she completed onboarding for real,
then sent her actual expense/food-cost spreadsheet with two direct asks. Planned via
`EnterPlanMode` (touches money aggregation + two screens). See "Decisions made" above for the full
detail, including a real running-cost aggregation bug found and fixed along the way — `.find()`
instead of summing all active rows per category, which the "Other" feature would otherwise have
walked straight into. `npx tsc --noEmit`, `npm run lint`, `npm run test` (66 tests, up from 62),
`npm run build` all clean. Verified in a local `next build && next start` server against
mail2raj27's test account (not Seiyun's — she was actively using hers live at the time) before
redeploying to production. Also answered Raj's question about visiting a client's account directly
for his own testing — same admin-API technique used throughout this session, given to him as a
ready-to-run command.

### 2026-09-30 — Labor import: fix duplicate employees, ask when a name is ambiguous (done)
Direct follow-up to the duplicate-"Jose" gap flagged at the end of the upload-history work above —
asked to fix it, with a specific requirement to ask the owner rather than guess when a name is
genuinely unclear (nickname/typo, or two people sharing a name). One `AskUserQuestion` to confirm
the review step shouldn't hard-block import (default to "new," visible, not forced), then
`EnterPlanMode` given it touches matching logic + a new UI review step. See "Decisions made" above
for the full detail on the three-tier matching design and the "use server"-can-only-export-async-
functions build error found and fixed along the way. `npx tsc --noEmit`, `npm run lint`, `npm run
test`, `npm run build` all clean — no schema change needed. Verified in a local `next build && next
start` server against the real account (three scenarios: exact-match no-prompt, zero-match review-
then-remembered, and two-candidates-pick-the-right-one) before redeploying to production. All test
employees/timecards/rollup rows removed afterward, Jose's own record confirmed back to exactly its
original state.

### 2026-09-30 — Real upload history + an unmatched-menu-item alert (done)
Direct follow-up to the double-count fix: "it should work no matter how she gives it... if we're
missing something we should notify them... I should be able to see how it's working." Planned via
`EnterPlanMode` (multi-file, touches the alerts system and adds a new screen). See "Decisions made"
above for the full detail. Built: `supabase/migrations/20260929000019_uploads_csv.sql` (widened
`uploads.kind` and, after finding it live, `alerts.kind`'s check constraints; `uploads.storage_path`
made nullable since CSV imports never touch Storage); `uploads`-row writes in all three CSV import
actions with a real summary; a new `unmatched_sales_items` alert; `/more/uploads/history`. `npx tsc
--noEmit`, `npm run lint`, `npm run test`, `npm run build` all clean. Verified in a local `next
build && next start` server against the real account (form_input for selects/file input via a
constructed `File` + `DataTransfer`, `javascript_tool`-dispatched clicks for buttons — same
workaround as every other live check this session, since browser click automation stays unreliable
here) before redeploying to production and spot-checking there too. All synthetic data (orders, a
duplicate test employee the labor path created, uploads rows, the alert, a rollup row) removed
afterward.

### 2026-09-29 — Fixed a daily-rolling-upload double-count bug in the sales/labor CSV importers (done)
Prompted by planning the pilot's upload-testing workflow with the client (she'll export "last 30
days" from her register daily) — asked directly whether repeated overlapping uploads would double-
count or lose data. Traced it and found a real bug: see "Decisions made" above for the full detail.
`lib/actions/csvImport.ts`'s upsert keys for sales/labor rows included the row's file-array index,
not just its content, so a shifting rolling window would mint a new id for an already-imported day
and duplicate it instead of updating it. Fixed by keying on content alone (date+item,
employee+clock-in) — both already unique per real row, so no behavior change for a normal single
upload, only for the overlapping-upload case. `npx tsc --noEmit`, `npm run lint`, `npm run test`,
`npm run build` all clean (no new calc logic, so no new Vitest cases — verified instead with a
direct live-database upsert test using the old vs. new key shape against her real project, then
cleaned up the test row). Deployed to production.

### 2026-09-29 — Salaried wages now require a real schedule, not a typed hours/week number (done)
Direct feedback on the same day's earlier salaried-wage feature: "even in salary, we should ask
the schedule for ex: what days and what hours otherwise it defeats the purpose." See "Decisions
made" above for the full detail — removed the numeric fallback entirely, salaried employees now
save as "pending" ($0/hr) until a real weekly schedule is set, the Add form auto-expands into the
schedule editor right after adding, and a real cross-midnight bug in `weeklyScheduledHours` (found
but left unfixed earlier the same day) was fixed since the fallback no longer masks it. `npx tsc
--noEmit`, `npm run lint`, `npm run test` (63 tests, up from 62), `npm run build` all clean.
Verified in a local `next build && next start` server first, then redeployed to production and
re-verified live — same RLS-scoped-REST-plus-`javascript_tool`-click approach as earlier the same
day, since browser click automation was unreliable in this environment again. Test employee
created and removed afterward; Jose's real data untouched.

### 2026-09-29 — Menu sizes + ingredients table, salaried staff wages (done)
Two more direct requests from the client, planned via `EnterPlanMode` first (both change what she
sees and how staff cost is calculated) with two `AskUserQuestion` checks on the open design
decisions before writing the plan — see "Decisions made" above for the full detail on both. Built:
`supabase/migrations/20260929000017_menu_item_size.sql` (`menu_items.base_name`/`size_label`) and
`20260929000018_employee_wage_period.sql` (`employees.wage_period`/`wage_amount_cents`), applied
live via `scripts/db-migrate.mjs`; `/menu/manage`'s grouped-by-size UI and real ingredients table;
`/more/manage-staff`'s hour/month/year wage entry, backed by two new tested `lib/calc/staff.ts`
functions (`weeklyScheduledHours`, `hourlyWageCentsFromSalary`). `npx tsc --noEmit`, `npm run
lint`, `npm run test` (66 tests, up from 61), and `npm run build` all clean. Verified in a real
`next build && next start` production server first (not just dev/HMR) — browser click automation
was unreliable in this environment again (the same window-occlusion timeouts noted in the
2026-09-28 entry below), so interactions used `form_input` for text fields and a dispatched
`.click()` via `javascript_tool` for buttons instead, with direct RLS-scoped REST calls (the real
user's own access token, from the same admin `generate_link` + `verify` technique used earlier
this session) to set up/inspect test data. Then redeployed to production and re-verified the same
flows live against `cafe-profit.vercel.app`. All test data (two draft menu items, one draft
employee, one added schedule day) was removed afterward — confirmed her real data (2 menu items,
Jose's wage and schedule) matches exactly what it was before this session started.

### 2026-09-28 — First real Supabase connection: db:reset succeeded, 4 real bugs found and fixed (done)
Continuation of the same day's session — the client sent the remaining two Supabase credentials
(service role key, DB connection string). The direct-connection DB host
(`db.<ref>.supabase.co`) didn't resolve from this environment (IPv6-only on this project,
environment is IPv4-only) — used the session pooler host instead
(`aws-0-us-east-1.pooler.supabase.com:5432`), which works over IPv4. `TOKEN_ENCRYPTION_KEY` was
also generated (`openssl rand -base64 32`) since it's needed before Square can ever connect (M5).

`npm run db:reset` then ran for the first time ever against a real Postgres instance — and found 4
real bugs immediately (see "Decisions made" for the full detail on each): a broken RLS migration
that failed instantly, a Menu-screen query that silently lost 92% of its data to PostgREST's
1000-row response cap and produced wildly wrong per-drink numbers, and six missing `ON DELETE
CASCADE` rules that broke the reseed script's business-delete step. Each was found by actually
running the thing, not by inspection — every one had already passed `build`/`lint`/`test` and
looked correct against fixture data.

After all four fixes, did a full real-login pass through every screen — Home, Money (including
actually exercising the recovery-order reorder write, not just reading), Menu, Break-even, Staff,
Manage staff, Try a scenario, and the ingredient importer — confirming each renders correctly and,
for the write paths, actually persists against live RLS. Browser click automation was unreliable in
this environment (window-occlusion timeouts), so write-path verification mostly used direct
RLS-scoped API calls with a real user session (obtained via the admin `generate_link` API +
`verify` endpoint, then `setSession()` in the browser to get a real signed-in session without
needing actual email delivery) rather than clicking through the UI — a real session established
end-to-end this way, not a shortcut around auth.

`npx tsc --noEmit`, `npm run lint`, `npm run test` (55 tests), and `npm run build` all clean after
every fix.

**Not done:** redeploying the public Vercel demo link with real credentials (still fixture-only —
deliberately, since switching it over means visitors need to actually sign in instead of getting
frictionless fixture browsing; worth deciding deliberately, not as a side effect of another push),
the data-completeness indicator, and unit conversion in the ingredient importer.

Next: build the data-completeness indicator, decide when/whether to redeploy the public demo with
real credentials, and — once the pilot owner actually starts entering her own bills/staff/costs —
watch for any further "only shows up at real volume/real data shape" issues the same way these four
did.

### 2026-09-28 — First real pilot café: deploy + Staff + scenario tool + rollout features (done)
A live client session — deployed the demo publicly, then built out what the first real café owner
actually needs to go live, based on her stated workflow.

**Public demo deploy:** logged into Vercel via CLI device-code flow (no password entered by the
agent — the user approved in her own browser), deployed straight from source with
`vercel --prod`. Live at `https://cafe-profit.vercel.app`, zero credentials required (fixture
mode). Caught and fixed a real bug on the live deploy: the cost-recovery hero number wrapped
mid-digit ("$8,104.3" / "2") at 360–390px, the app's actual minimum supported width — widened the
icon/text row's forced-wrap threshold and swapped `break-words` for `whitespace-nowrap` so a money
string can never split internally again.

**Staff screen** (pulled forward from v1.5, docs/03-screens.md S8) — see "New dependencies" /
decisions above for the data-layer additions (`staffShiftsToday`, `staffNowIso` on
`BusinessSnapshot`) and the fixture demo roster matching `staff.html`'s own example (explicit
`-07:00` offsets on every fixture timestamp — the same class of bug M2's postmortem warns about,
fixed before it shipped this time).

**Then the client gave live Supabase credentials** (project URL + anon key) and a detailed rundown
of her actual workflow — Toast on an unpaid tier (daily Excel download), an inventory site with no
API (nightly Excel download), QuickBooks exports, and a request to understand "what if" scenarios
like giving an ingredient away free for a few days. Two real decisions came up mid-build and were
put to the user rather than guessed at: how to handle her wanting to name her own expense
categories (resolved: fixed categories stay, add a free-text label), and whether her Toast tier
exports labor data (resolved: unknown, build for the safer manual-entry case). A third came up
organically — `xlsx`'s npm package has an unpatched CVE — and was also put to the user rather than
silently worked around; she chose SheetJS's own patched CDN build. See "Decisions made" above for
all three and what was built as a result: manual staff roster + hours, custom expense labels,
Excel upload support, and a generic ingredient-cost importer.

Verified: `npx tsc --noEmit`, `npm run lint`, `npm run test` (55 tests, +5 for `scenario.ts`), and
`npm run build` all clean at each step. Browser-verified in fixture mode (temporarily moved
`.env.local` aside and back for each check, since real credentials now make `isSupabaseConfigured()`
true and require actual sign-in — see "Needs connecting"): Staff, Manage staff, Try a scenario, and
the ingredient importer all checked at 360–390px, in Arabic RTL, and at 200% zoom. Found and fixed
two more real 200%-zoom bugs this way: the new staff-wage input rows (missing `min-w-0`, same root
cause as the TabBar fix below) and an ingredient-review row's unconstrained name text pushing a
unit picker out of view. Also found that the **shared TabBar had this exact overflow bug on every
single screen** in the app, undetected through the entire M0–M8 build, because the zoom-check
technique used throughout this project had a timing bug (reading `scrollWidth` before the browser
had reflowed after the font-size change) — fixed the TabBar and corrected the check; re-verified
Home/Money/Menu/Staff are clean with the corrected technique. Also discovered mid-session that a
`<select>` element's own `scrollWidth` isn't a trustworthy signal on its own (see decisions) —
cross-checked with a screenshot from then on.

Not built: the data-completeness indicator (told the user this is still open), and Excel unit
conversion for the ingredient importer (no real export sample to build it against).

**Public demo not yet redeployed with this stretch's work** — still points at the M8 build.
Redeploy once the client's remaining Supabase credentials land and the new migration has been
applied, so the demo and the real pilot database migrate together.

Next: get `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_DB_URL` from the client, run `npm run db:reset`
(applies `20260928000012_client_rollout.sql` along with everything else), do a full real-login
pass through every screen, build the data-completeness indicator, then redeploy the public demo.

### 2026-09-26 — M8 Pilot hardening (done)
Built everything `docs/07-build-plan.md` M8 lists:
- `app/[locale]/error.tsx` (translated, in-locale) and `app/global-error.tsx` (hardcoded English —
  no locale context is guaranteed at the root) — both report to Sentry via `Sentry.captureException`
  when a DSN is configured.
- `components/shared/Skeleton.tsx` + `app/[locale]/loading.tsx`, `money/loading.tsx`,
  `menu/loading.tsx` — skeleton screens matching each route's real layout, `motion-reduce` aware.
- `lib/data/getPosConnectionStatus.ts` + `components/shared/ReconnectBanner.tsx`, shown at the top
  of Home when the active business's register connection isn't `active`.
- `lib/actions/deleteAccount.ts` (best-effort Square token revoke, best-effort Storage cleanup,
  cascading business delete, then `admin.auth.admin.deleteUser`) + `components/more/
  DeleteAccountForm.tsx` (type-the-word-"delete" confirm) + `/more/delete-account`.
- `/privacy` — publicly accessible (no `requireUser()`), translated `Privacy` namespace covering
  what's read, what's never touched, how it's protected, AI use, the owner's control, and account
  deletion.
- Screen-view analytics and Sentry — see "New dependencies" and "Decisions made" above for what was
  built and why each degrades gracefully without credentials.
- `More` hub gained an `Alerts` link (M7 shipped the screen but never linked it from `/more`) and a
  second card for `Privacy`/`Delete account`.
- All three locale files (`en.json`/`es.json`/`ar.json`) carry the full set of new strings —
  `Errors`, `Reconnect`, `DeleteAccount`, `Privacy`, plus `More`'s new `alerts`/`privacy`/
  `deleteAccount` keys.

Verified in-browser (390px, dev server restarted after adding the new dependency + instrumentation
files so Turbopack picked them up cleanly): `/privacy` and `/more/delete-account` render correctly
in English, Spanish, and Arabic (RTL mirrors correctly — back-chevron direction, bottom-nav order);
the delete-confirm button correctly stays disabled until "delete" is typed, then activates; the More
hub shows all 7 links including the new Alerts/Privacy/Delete-account entries. **Caught and fixed a
real bug this way** (see decisions): the alert-detail page crashed instead of degrading when
Supabase isn't configured, which the new error boundary correctly caught but shouldn't have had to.
`npx tsc --noEmit`, `npm run lint`, `npm run test` (50 tests), and `npm run build` all clean,
including a build with zero `SENTRY_DSN` set to confirm the Sentry wiring doesn't require an
account.

Not built (out of M8's explicit scope): a cron/scheduled job to actually populate `screen_views`
into a dashboard — the table and logging exist, but no reporting UI was requested or built.

Next: deploy (Vercel — see README "How to demo this to a café owner" and the final Needs-connecting
list), then v1.5 (Staff screen live, "Why today was different", weekly text, native-speaker
translation review).

### 2026-09-26 — M7 Alerts + milestones (done)
Wires M2's pure alert-rule predicates (`lib/calc/alerts.ts`) to real data and screens:
- `lib/alerts/generate.ts` — `generateAlerts(supabase, businessId)` generates `missing_bill`
  (checked against every running-cost category's recurring/actual history), `voids` (this
  month's `daily_rollups.voids_cents` vs. the previous-3-months average), and `meal_break`
  (every timecard from the last 7 days run through `mealBreakStatus`). Idempotent — a `dedupeKey`
  in each alert's `payload` (category+month / month / timecard id) is checked before insert, so
  re-running never spams duplicate open alerts for the same underlying thing. No cron exists yet,
  so generation is triggered opportunistically on read: both `getSnapshot()` (Home's teaser) and
  the Alerts screen call it before querying, so the two never disagree.
- `covered_milestone`, `overstaffed_slot`, and `early_clockin` are **not generated** — see
  decisions below for why each is a real scope item, not an oversight.
- `/more/alerts` (S9 list: two summary tiles — leaking this month / how many open — then a card
  per alert, icon+title+subtitle+$ impact, calm non-accusatory copy throughout) and
  `/more/alerts/[id]` (S9 detail: impact amount, an explicit "this can be an honest mistake, not
  an accusation" note per docs/02-design-system.md's tone rule, an action link, "Mark as
  reviewed"/"Dismiss"). Deliberately simpler than `alert-detail.html`'s per-employee void
  breakdown and transaction log — see decisions, the underlying per-line data isn't stored yet.

Verified in-browser: Home's Fixture-A numbers unchanged (M7 touched only the real-DB path, so the
fixture fallback is provably unaffected — a full page-text diff against M3/M6's verified output
matched exactly), `/more/alerts` renders its correct empty state ("Nothing needs your attention")
since Supabase isn't connected, RTL and 200% zoom checked. `npm run build`/`lint`/`test` clean
(50 tests — no new ones this milestone; alert generation needs a live Postgres to test meaningfully
and none exists in this environment).

Next: M8 (pilot hardening — error states, loading skeletons, reconnect flow, delete account,
privacy page, screen-view analytics, Sentry), then deploy.

### 2026-09-26 — M6 CSV import for Toast/other POS (done)
Built the generic column mapper docs/06-integrations.md asks for — works for Toast, Clover, or any
other register's exports (not Toast-specific), matching this session's "don't build Square-only"
instruction:
- `supabase/migrations/20260926000010_csv_import_mappings.sql` — a `csv_import_mappings` table
  (business_id, kind, column_mapping jsonb) with RLS, added because `docs/04-data-model.md` has no
  table for saved mappings even though `docs/06-integrations.md` explicitly asks for them.
- `lib/pos/csv/` — `csvUtils.ts` (shared date/cents/timestamp parsing, extracted from M4's bank-
  statement parser rather than duplicated), `parseSalesCsv.ts` and `parseLaborCsv.ts` (mapping-
  driven, not auto-detecting like the bank importer — the owner picks which column is which).
  3 Vitest tests against realistic Toast-shaped export text (product-mix row, AM/PM clock times,
  an open shift with no clock-out).
- `lib/actions/csvImport.ts` — `getSavedMapping`/`saveMapping` (one per business+kind, upserted so
  the next upload can reuse it) and `importSalesRows`/`importLaborRows`, which write into the same
  `orders`/`order_lines`/`timecards` tables real POS syncs use, then call M5's
  `recomputeDailyRollup` for every affected date — the rest of the app can't tell a CSV import from
  a Square sync. One synthetic order per item per day (the doc's own suggestion, since Toast's
  product-mix export is already aggregated), `pos_order_id` prefixed `csv-` so it never collides
  with a real register's own ids.
- `/more/uploads` is now a real hub (sales report / labor / bank statement) instead of a
  placeholder; `/more/uploads/sales` and `/more/uploads/labor` are the mapper screens: upload →
  columns auto-detected client-side (Papaparse, no round trip needed for that part) → the owner
  matches fields from dropdowns (pre-filled from the saved mapping when its columns still match
  the new file's headers) → live row-count preview → import.

Verified in-browser, driven end to end through the real file input (not just built-and-assumed): a
Toast-shaped product-mix CSV was uploaded, its columns were correctly detected, mapped, and the
preview correctly showed "2 sale rows ready to import" — confirming `detectCsvColumns` +
`parseSalesCsv` run correctly client-side before any server call. **Caught and fixed a real bug
this way**: the preview string contained a literal `{count}` meant for a client-side
`.replace()`, but next-intl parses `{count}` in any translated string as an ICU MessageFormat
placeholder — calling `t("salesPreview")` with no `count` argument threw a `FORMATTING_ERROR` that
next-intl's default error handling silently rendered as the literal text "CsvImport.salesPreview"
instead of the sentence. Fixed by escaping the braces in all three locales (`'{count}'`) rather
than passing the count through next-intl var substitution, since the value isn't known until the
client parses the file. Also caught (via the same browser test) that a failed import showed no
error at all — added error state/display to both importer components.

`npm run build`/`lint`/`test` all clean (50 tests). RTL and 200% zoom checked on `/more/uploads`.

Next: M7 (alerts — missing bill, voids, meal break, early clock-in, overstaffed slot, covered
milestone — the calc-layer predicates already exist from M2, this wires them to real data,
generation, and the alert screens).

### 2026-09-26 — M5 Square connection + onboarding (done)
Built:
- `lib/pos/types.ts` — the one `PosAdapter` interface every register implements (`fetchOrders`,
  `fetchCatalogItems`, `fetchEmployees`, `fetchTimecards`, all normalized, money in cents). Nothing
  outside `lib/pos/` ever branches on provider (per this session's explicit "don't build for Square
  only" instruction).
- `lib/pos/square/` — `oauth.ts` (authorize URL, code exchange, refresh — sandbox vs. production
  host from `SQUARE_ENVIRONMENT`, read-only scopes only per CLAUDE.md rule 5), `client.ts`
  (429/5xx exponential backoff, cursor pagination), `adapter.ts` (maps Square's Orders/Payments/
  Catalog/Team-Member/Timecard v2 APIs onto `PosAdapter` — field names follow Square-Version
  2025-05-21 docs from training knowledge; **flagged inline and here as unverified** — confirm
  against a real sandbox account and Square's current docs before trusting it, per
  `docs/06-integrations.md`'s own instruction).
- `lib/pos/toast/adapter.ts`, `lib/pos/clover/adapter.ts` — typed stubs matching the same
  interface, every method throwing `PosNotConnectedError` until real credentials exist. Toast
  needs partner/plan approval (`docs/06-integrations.md`); Clover isn't in the docs at all — added
  because the session instructions said don't build Square-only. The CSV path (M6) is what
  actually works for both today.
- `lib/pos/sync.ts` + `lib/pos/rollup.ts` — backfill/incremental sync (idempotent upsert on
  `pos_*_id`) and `daily_rollups` recomputation from raw orders/order_lines/timecards, reusing
  `lib/calc`'s ingredient costing so the rollup numbers are computed the same way the screens
  expect them.
- `lib/security/tokenCrypto.ts` — AES-256-GCM encrypt/decrypt for `pos_connections.*_token_enc`
  (docs/06-integrations.md "Security"). **Actually tested** (3 Vitest tests: round-trip, random IV,
  tamper detection via the GCM auth tag) — this one doesn't need a live Square account to verify.
- `app/api/pos/square/connect` + `/callback` — full OAuth round trip with CSRF state cookie,
  token exchange, location lookup, encrypted token storage, then an inline 90-day backfill.
- `app/[locale]/onboarding/` — the 5-step wizard (S2): register choice (Square/Toast/Clover/Other,
  every choice leads somewhere — Square to OAuth, the other three to Uploads), monthly bills
  (reuses M4's `BillsManager`), payroll tax rate, a top-drinks step that explains the standard-
  recipe starting point (see decisions), and bucket-order reordering (reuses M3's up/down pattern).
  `lib/actions/onboarding.ts`'s `ensureOwnBusiness()` creates the user's real "My café" business on
  first visit — via the **admin/service-role client**, deliberately: RLS's `is_member()` can't
  pass for an INSERT into `businesses` before any membership row exists, so this is the one place
  that bypass is correct rather than a shortcut.
- Rebuilt `/more` as a real hub (café switcher + links to Monthly bills/Uploads/Break-even/Connect
  register) instead of the M0 placeholder — the Demo café / My café switch the session instructions
  asked for (`components/more/BusinessSwitch.tsx`, `lib/actions/setActiveBusiness.ts`, a cookie
  `getActiveBusinessId()` already read since M3).

Verified in-browser: the full onboarding flow renders and is navigable end to end without Supabase
configured (Square button correctly disabled with a translated message; steps 2/3/5 degrade
gracefully — step 5 still shows the default bucket order so it's never a dead end); the More hub's
café switch renders with "My café" correctly disabled (no owned business yet); RTL and 200% zoom
checked on `/onboarding` and `/more`. **Not verified** (no Square sandbox credentials in this
environment): the actual OAuth round trip, the adapter's field-name assumptions against a real
Square response, and the backfill/rollup pipeline against real order data — all flagged in "Needs
connecting" below with the specific things to check first.

`npm run build`/`lint`/`test` all clean (47 tests).

Next: M6 (CSV import for Toast/Clover/Other — column mapper, saved mappings; the "Other register"
path from onboarding step 1 currently only points at Uploads, which M6 makes real).

### 2026-09-26 — M4 Cost capture (done)
Built:
- `lib/ai/` — provider-agnostic `completeStructured(task, {system,user,imageDataUrl?,schema})`
  (`complete.ts`): picks the provider from `AI_PROVIDER`, validates the response with zod, retries
  once on invalid JSON, logs token usage only (never prompt/response content). Three thin
  fetch-based provider adapters (`providers/anthropic.ts` default model `claude-haiku-4-5-20251001`,
  `openai.ts` `gpt-4o-mini`, `moonshot.ts`, all overridable via `*_MODEL` env vars), each supporting
  an optional vision image (needed for receipt reading). The three prompts from
  `docs/06-integrations.md` verbatim (`prompts/statementCategorizing.ts`, `receiptReading.ts`,
  `voiceExpense.ts`).
- `lib/expenses/` — `dedupeKey.ts` (sha256 per `docs/04-data-model.md`'s exact spec),
  `keywordRules.ts` (PG&E/EBMUD/Comcast-AT&T/Safeway-Costco-Restaurant Depot →
  category, from `docs/06-integrations.md` step 5), `categorize.ts` (the full waterfall:
  vendor_rules → keyword rules → AI, AI called only for lines neither could place, and skipped
  cleanly with an "uncategorized" result if no AI provider is configured — never blocks the rest
  of the flow), `parseStatementCsv.ts` (column-detection CSV parser: single amount column or
  debit/credit pair, common US date formats, opening+lines=closing balance check). PDF statements
  are **not built** — CSV first per the M4 acceptance criteria; see decisions.
- `lib/actions/` — server actions for manual entry, recurring-bill CRUD, statement-line review
  (`statementReview.ts`), receipt review/save (`receiptReview.ts`, one `expenses` row + N
  `expense_lines`), voice review (`voiceReview.ts`). All duplicate-`dedupe_key` inserts are caught
  (Postgres `23505`) and silently skipped rather than erroring — this is the "a receipt and its
  bank line don't double count" mechanism. Corrections made in the statement review screen are
  written to `vendor_rules` so the next upload uses them automatically.
- Screens: `/add-cost` (S10, 4-option picker), `/add-cost/type` (amount keypad → category tiles →
  date), `/add-cost/statement` (upload → review list with per-line category override and
  confidence flag → save all), `/add-cost/receipt` (camera capture, client-side compressed to
  ≤1600px JPEG before it ever leaves the browser, → AI review card → save), `/add-cost/voice`
  (hold-to-talk via the browser's `SpeechRecognition` API → AI parse → confirm card), `/more/bills`
  (S11, tap a category tile to add/edit/remove a recurring bill).

Every AI-dependent and DB-dependent path degrades to a clear, translated message instead of
crashing when unconfigured (same pattern as M1) — verified in-browser for all 5 new screens: the
"Type it" flow was driven end-to-end (keypad → category → save) and correctly showed "Sign in to
add a cost"; a real sample CSV (PG&E, Costco, a Square payout) was fed through the actual file
input and came back with "Sign in and connect Supabase..." only at the DB-write step, confirming
`parseStatementCsv` + `categorizeLines`'s keyword path ran correctly first (also covered by 4
Vitest tests using the same kind of real bank-CSV text). Voice entry correctly fell back to "not
supported in this browser" copy. RTL and 200% zoom checked on `/add-cost` and `/add-cost/type`
(grids, no overflow).

Verified: `npm run build`/`lint`/`test` clean (44 tests total).

Next: M5 (Square OAuth — sandbox first, backfill, webhooks + poll, rollups, onboarding wizard).

### 2026-09-26 — M3 Core screens on demo data (done)
Built Home (`app/[locale]/page.tsx`), Money (`app/[locale]/money/page.tsx`, cost recovery + profit &
costs behind a segmented switch), Menu (`app/[locale]/menu/page.tsx`), and Break-even
(`app/[locale]/more/break-even/page.tsx`), all from `docs/03-screens.md` + the mockups, all numbers
sourced through `lib/viewmodels/*` → `lib/calc/*`, never computed in a component.

New supporting layers:
- `lib/data/` — `BusinessSnapshot` type, real Supabase query implementation (`snapshot.server.ts`,
  unverified — see "Needs connecting"), Fixture-A-derived fallback (`fixtureSnapshot.ts`), the
  `getSnapshot()` entry point, and `getActiveBusinessId()` (demo vs. the user's own business).
- `lib/viewmodels/` — `period.ts` (Today/Week/Month day-window + running-cost proration, including a
  same-month + previous-month fallback for running costs so a week/today comparison that dips into
  the prior month doesn't silently zero out), `costRecoveryShared.ts` (day contributions, weekday-
  average projections per the doc's rule), `homeViewModel.ts`, `moneyViewModel.ts`,
  `menuViewModel.ts`, `breakEvenViewModel.ts`.
- `components/icons/` — `ExpenseIconDefs.tsx` (one SVG sprite, symbols adapted from
  `cost-recovery.html` for rent/power/insurance/loan/software/supplies/cup, new ones added for
  water/internet/repairs/other/ingredients/milk/card/staff/payroll_tax/profit), `FillIcon.tsx` (the
  bottom-up fill metaphor via a two-stop gradient — no clip-path, direction-safe in RTL), `PlainIcon.tsx`.
- `lib/actions/recoveryOrder.ts` — server action for reordering cost-recovery buckets (see decisions).

Verified extensively in-browser (not just built-and-assumed): every Fixture A expected value from
`docs/05-calculations.md`'s table appears correctly on screen — Home's Today/Month owner profit
($580.48 / $5,224.32), the cost-recovery hero and all 6 bucket cover dates, the Sep 9 "current
bucket = loan, 58%, $295.68 to go" snapshot, "on track for $17,414.40", "yours so far" on day 26,
health bands (27%/32%/60%, all Healthy), break-even (315 drinks, the +25¢ what-if → 294), and the
rent & bills share per drink ($0.6667). Two real bugs were caught this way, not by inspection (see
decisions below): a viewmodel double-counting `projectedMonthEndProfitCents`, and the hero "all
covered by" date pointing at the wrong bucket. Also verified: `npm run build`/`lint`/`test` all
clean; RTL on all 4 screens (icon fill direction, stacked bar mirroring, calendar grid, FAB position
via logical `end-4`); 200% root-font-size zoom on all 4 screens plus `/login` with zero horizontal
overflow (`document.body.scrollWidth` checked programmatically after each fix, several real bugs
found and fixed this way — see decisions).

Not built yet (deferred, not blocking M3's acceptance criteria): the Menu screen's per-item recipe
editor and price-change simulator (S6 point 5 — M4/M6 territory once cost-capture UI exists); Staff
and More/Settings stay M0 placeholders (Staff detail is explicitly v1.5 in `docs/01-product.md`;
Settings/onboarding is M5+).

Next: M4 (monthly bills, manual/voice entry, bank statement upload, receipt photos, vendor rule
learning, dedupe).

### 2026-09-26 — M2 Calculations (done)
`lib/calc/`: `types.ts`, `money.ts` (round-half-up-to-cent, only ever applied at the end of a
calculation, never on intermediates), `staff.ts` (paid hours from timecard + unpaid breaks, open
shifts count to `now`, payroll tax, loaded staff cost), `runningCosts.ts` (`monthlyAmountForCategory`,
period proration), `profit.ts` (owner profit, total costs, health bands), `perDrink.ts`, `breakEven.ts`
(+ 3 what-ifs), `costRecovery.ts` (the sequential-fill algorithm from the doc's pseudocode, ported
faithfully including the "slipped back" un-covering rule and the projected-days-never-un-cover
behavior, plus `computeTodayInCups`), `ingredients.ts` (theoretical recipe costing), `alerts.ts` (pure
predicates for all 6 alert rules — M7 wires these to real data/UI). Fixture A lives in
`lib/calc/__fixtures__/fixtureA.ts`, Fixture B in `fixtureB.ts`, consumed only by tests (see M1
decisions for why the seeded demo data is separate).

**Found and fixed a real bug via testing, not inspection:** `runningCostsForPeriodCents` initially
built month boundaries with `Date.UTC(...)` and fed them to date-fns's `getDaysInMonth`/
`differenceInCalendarDays`, which read the Date object's *local* getters. In any timezone behind UTC
(all of the US, including the business's default `America/Los_Angeles`), that silently miscounted a
30-day September as 31 days — every running-cost proration would have been ~3% low. Caught immediately
by the Fixture A owner-profit test (`$15,092.48` expected, `$14,668...` got) before it ever reached a
screen. Fixed by using local `Date` construction throughout `runningCosts.ts` (date-fns's `parseISO`
already parses date-only strings as local midnight for exactly this reason — the bug was in mixing
UTC construction into a local-calendar-math module, not in date-fns itself). Left a comment in the
file so nobody reintroduces it.

Verified: all 40 Vitest tests pass, including every expected value in Fixture A's table (cost recovery
covered-on dates, the Sep 9 "as of" snapshot, yours-so-far, projected month-end, month-to-date and
single-day owner profit, break-even + the price what-if, rent share per drink, all three health bands)
and Fixture B (staff cost per prep-second, per-item staff time, card fee, extra money from one more
latte). `npm run build` and `npm run lint` clean.

Next: M3 (Home, Money, Menu, Break-even screens on demo data, built from the mockups).

### 2026-09-26 — M1 Database + demo seed (done)
Built (not yet run against a live Supabase project — see "Needs connecting"):
- `supabase/migrations/*.sql` (9 files): every table from `docs/04-data-model.md` verbatim, plus RLS on every business-owned table via an `is_member()` helper (direct-column tables looped with a `do $$ ... $$` block; child tables without their own `business_id` — `ingredient_prices`, `recipe_lines`, `order_lines`, `expense_lines` — join to their parent), `expense_categories` seeded with the exact QuickBooks mapping from the doc, and the new-user-gets-demo-access trigger.
- `lib/supabase/`: `client.ts`/`server.ts` moved to `@supabase/ssr` (cookie-based sessions), new `admin.ts` (service-role, `server-only`-guarded), new `middleware.ts` (`refreshSupabaseSession`, called from `proxy.ts` alongside the existing next-intl middleware — no-ops gracefully when Supabase isn't configured yet).
- Magic-link auth: `/login` (adapted from `connect.html` per S1's spec: language buttons, headline, trust line, email field), `/auth/callback` (code exchange), `lib/auth/requireUser.ts` (server guard, used by all 5 tab pages, all now `force-dynamic`). Verified in-browser at 375px for `en` and `ar` (RTL mirrors correctly — language pills, trust-line icon, text alignment all flip); confirmed the app renders cleanly with **no** Supabase env vars set (graceful no-op) rather than 500ing, and that the "sign-in isn't connected yet" message shows on submit.
- `scripts/seed/demoData.mjs` + `scripts/seed/rng.mjs`: deterministic (seeded PRNG) generator for "Sunrise Café" — 90 days ending today, weekday/weekend/slow-day order patterns with hourly rush weighting, 12 menu items × 14 ingredients with recipes, one mid-window milk price increase (with the receipt that "caused" it, mapped to the ingredient), 6 staff on rotating opener/mid/closer/rush shifts (one shift deliberately has no meal break, ~2 recent months run hot on voids), 8 of 9 running-cost categories as recurring bills (repairs and this month's water deliberately absent to exercise the missing-bill alert and completeness line), a handful of receipt/statement expenses. Smoke-tested standalone (no DB): ~34k orders/43k lines/90 rollup days, ratios in the target bands (see Decisions above).
- `scripts/db-reset.mjs`: loads `.env.local`, applies migrations then reseeds the demo business (delete-by-id cascades, then bulk parameterized inserts) via `pg`, then ensures a `demo@cafeprofit.app` login user (owner, `can_see_profit: true`) via the Supabase admin API. No-ops with a clear message if Supabase env vars are missing, instead of failing.

Verified: `npm run build`, `npm run lint`, `npm run test` all clean; in-browser check of `/login` (en + ar) with zero console errors on a fresh tab. **Not verified:** the actual migration SQL and seed insert against a real Postgres instance (no Supabase CLI/Docker in this environment) — this is the top risk item for M1, re-check first once credentials land.

Next: M2 (`lib/calc/`, all formulas in `docs/05-calculations.md`, Fixture A/B as Vitest tests).

### 2026-09-26 — M0 Skeleton (done)
Scaffolded with `create-next-app` (Next 16.3.6, Turbopack, TS strict) into a temp dir, then hand-merged into this repo so the existing `CLAUDE.md`/`AGENTS.md`/`README.md`/`docs/`/`design/` were untouched. Built:
- `app/[locale]/` routing via next-intl (`i18n/routing.ts`, `request.ts`, `navigation.ts`, root `proxy.ts`) for en/es/ar; `getDirection()` flips `dir="rtl"` for Arabic. Verified in-browser: `/ar` renders `lang="ar" dir="rtl"`, tab bar mirrors, IBM Plex Sans Arabic loads.
- Tailwind v3 config (`tailwind.config.ts`) with every color/font/radius token from `docs/02-design-system.md`; Fraunces/Figtree/IBM Plex Sans Arabic via `next/font/google`.
- Bottom tab bar (`components/TabBar.tsx`): Home/Money/Menu/Staff/More, icon+label, 48px targets, active-tab highlight, `aria-current`.
- PWA: `public/manifest.json` + `public/sw.js` (minimal network-falling-back-to-cache) + `components/ServiceWorkerRegister.tsx`. Manifest verified loading in-browser; **SW registration could not be verified** — it fails with "unknown error fetching the script" specifically inside this session's sandboxed preview browser (the `/sw.js` file itself serves fine via plain `fetch`, 200/correct content-type). Registration is wrapped in try/catch so this fails silently rather than breaking the app; re-verify in a real Chrome/Safari tab before relying on installability.
- `lib/supabase/client.ts` + `server.ts`: anon-key client factories, env-var driven. No DB/auth wiring yet (M1).
- Empty screens for all 5 tabs, all using `next-intl` messages (no hardcoded strings).
- `npm run dev/build/lint/test/db:reset` all exist and work; `db:reset` is a placeholder that logs until M1 adds migrations.

Verified: `npm run build` (all 15 pages — 3 locales × 5 routes — prerender), `npm run test` (2 passing smoke tests on `lib/utils/cn.ts`), `npm run lint` (clean), `npm run dev` + manual browser check at mobile width (375px) for en and ar, and a real **Lighthouse accessibility audit against the Home screen scored 100/100** (target was ≥95).

Next: M1 (Supabase migrations from `docs/04-data-model.md`, RLS, Fixture A seed, magic-link login).

## Phase 1 — AI operations team MVP (2026-10-02)

Plan:
- Add one shared deterministic operating-task model, agent routing, lifecycle transitions, and transport-neutral staff communication boundary.
- Add additive RLS-protected task/response persistence schema without applying it to production.
- Build deterministic team/inbox projections and compact localized Home + operations surfaces that remain useful without AI.
- Cover pricing provenance, staff responses/expiry, truthful handled states, qualitative supply checks, routing, and no-AI behavior with tests.
- Run typecheck, lint, tests, and production build; then commit as a standalone Phase 1 change.

No dependency added: existing Next.js, next-intl, Supabase, and Vitest facilities are sufficient.

Phase 1 result:
- [x] Shared deterministic agent routing, operational task contracts, evidence, lifecycle transitions, qualitative supply responses, and truthful staff coverage states.
- [x] Explicit unavailable staff communication provider; no delivery is claimed without transport.
- [x] Additive `operating_tasks` / `operating_task_responses` migration with tenant RLS (not applied).
- [x] Localized compact Home team surface and `/operations` Needs you / Handled / Watching inbox.
- [x] Pricing review tasks consume unchanged PricingEngine output; no POS price mutation exists.
- [x] Typecheck, lint, and 238 tests pass. Production build is blocked only by this environment failing to download the three existing Google fonts.

## Phase 1 review follow-up (PR #8)

Plan:
- Scope operating-task keys and response relationships by business, including employee tenant consistency in migration 23.
- Restore task-kind/agent routing invariants and remove capped Home status rendering.
- Add validated teammate query navigation and focused operations context.
- Separate employee coverage responses, owner approval, and successful schedule completion so only real completion can be handled.
- Add regression tests, run all required checks, and commit as one PR #8 follow-up.

Phase 1 review result:
- [x] Migration 23 now uses business-scoped task identity and tenant-consistent composite task/employee response references.
- [x] Every generated task's agent matches `agentForTask`, including Maya's supply watch.
- [x] Team statuses render actual counts without a 0–5 cap; regression coverage includes Alex and Leo counts above five.
- [x] Teammate links use validated `?agent=` navigation with safe full-inbox fallback.
- [x] Staff confirmation, owner approval, and verified schedule-action completion are distinct; only successful completion marks coverage handled/applied.
- [x] Typecheck, lint, and 245 tests pass. Build remains blocked only by failed network downloads for the existing Google fonts.

## Phase 1 final foundation follow-up (PR #8)

Plan:
- Label benchmark-derived Alex recommendations as estimates while preserving deterministic pricing mode, confidence, and evidence.
- Carry Leo's stable missing-cost category code and localize it at render time.
- Persist response actor provenance and actor/employee consistency in migration 23.
- Keep accepted price changes incomplete until a later deterministic observation verifies the selling price changed.
- Add focused regressions and rerun typecheck, lint, tests, and build.

Phase 1 final foundation result:
- [x] Benchmark pricing tasks carry mode/estimate metadata and render localized Estimate treatment with benchmark-only wording.
- [x] Leo stores stable category codes and resolves localized labels only in the operations UI.
- [x] Migration 23 persists actor type and enforces employee identity for employee responses and no employee identity for owner responses.
- [x] Use-price stays Watching until a trusted later observation matches the accepted recommendation; keep-current can complete immediately.
- [x] Typecheck, lint, and 248 tests pass. Build is blocked only by network failures fetching the three existing Google fonts.

## Phase 2 — UX clarity and visual hierarchy (2026-10-02)

Plan:
- Add truthful calendar month progress and lighter menu pricing-warning/real-size management experiences.
- Make Staff current-state and Manage Staff summaries/actions clearer, including reactivation, schedule truthfulness, and selected controls.
- Elevate the Home AI team with distinct accessible teammate identities and carry those accents into filtered operations work.
- Verify responsive layouts at 375px, 390px, desktop, and en/es/ar RTL; then run typecheck, lint, full tests, and build.

No dependency added; existing UI, i18n, data, and test facilities are sufficient.

Phase 2 result:
- [x] Calendar shows recorded/profitable month progress with 48px day targets.
- [x] Product detail uses real menu-item IDs for size navigation, adds actionable size rows, and softens pricing warnings.
- [x] Staff distinguishes active/empty shifts; Manage Staff is summary-first with reachable reactivation, truthful current-month/varied schedules, strong selectors, and collapse-after-save behavior.
- [x] Home AI team is a major warm section; Alex, Olivia, Maya, and Leo have distinct accessible identities carried into selected inbox work.
- [x] Home section surfaces now vary by domain while preserving good/warn semantics and the warm café palette.
- [x] English, Spanish, and Arabic copy added; logical RTL classes and mobile/desktop responsive constraints retained.
- [x] Typecheck, lint, and all 248 tests pass. Build reaches compilation but is blocked by the environment denying downloads for the three existing Google fonts. Browser screenshots could not be captured because no browser runtime is installed in this environment.

## Phase 2 review follow-up (PR #10)

Plan:
- Correct empty/active Staff hero hierarchy without changing staff calculations.
- Preserve validated product-detail tabs across real size IDs, complete per-size management context, and lighten catalog warning copy.
- Add editor-by-editor Manage Staff disclosure while keeping summaries, reactivation, and collapse-after-save behavior.
- Move Leo to a non-semantic ochre identity and restore calendar bill-coverage operating signals.
- Add focused regressions, verify responsive/RTL/touch logic, and rerun typecheck, lint, full tests, and build.

Phase 2 review follow-up result:
- [x] Empty Staff hero now shows only the truthful today-so-far cost; active shifts emphasize combined hourly cost with minute/today context.
- [x] Product headings use base names; validated URL-backed tabs survive real size-ID navigation.
- [x] Size rows show each size's own selling price, recipe cost/completeness, deterministic pricing status, and View / Edit action.
- [x] Menu catalog warnings are secondary text lines rather than dominant pills.
- [x] Manage Staff opens one selected editor at a time, preserves summary-first rows and 48px reactivation, and collapses after details/schedule saves.
- [x] Leo now uses non-semantic ochre; success green remains reserved for healthy states.
- [x] Calendar month progress again states actual or projected bill-coverage dates, or an honest not-covered/insufficient-data state.
- [x] Focused tab, staff-summary, and calendar-signal regressions added; typecheck, lint, and all 258 tests pass.
- [x] Responsive class logic reviewed for 375px/390px/desktop and logical RTL behavior in en/es/ar; touched controls remain at least 48px.
- [ ] Production build remains blocked only by the existing environment failure to fetch Figtree, Fraunces, and IBM Plex Sans Arabic from Google Fonts.

## Phase 2 final Manage Staff follow-up (PR #10)

Plan:
- Consume new-employee schedule guidance after the first successful schedule save so later expansions stay summary-first.
- Restore clearer weekly/month-only scope labels and supporting copy in en/es/ar while preserving selected states and 48px targets.
- Run focused/full tests, typecheck, and lint, then commit as one small PR #10 follow-up.

Phase 2 final Manage Staff follow-up result:
- [x] The first successful schedule save consumes new-employee guidance, refreshes, collapses, and leaves future expansions with no editor selected.
- [x] Schedule scope now says “Use every week” / “Only this month” with clear supporting copy in en/es/ar.
- [x] Selected `aria-pressed` styling and 48px scope controls are preserved.
- [x] Typecheck, lint, and all 259 tests pass.

## Phase 3 — Scan-fast owner workspace (2026-10-02)

Plan:
- Promote AI Team into primary desktop/mobile navigation and compress Home into truthful task counts plus a responsive summary grid.
- Add tenant-safe operating-task persistence that upserts deterministic tasks without erasing lifecycle state, and build one URL-backed agent/status inbox from persisted history.
- Add portrait-style agent avatars and entity-preserving, domain-correct deep links without inventing unsupported inventory or applying POS prices.
- Stabilize menu-size ordering, make exact-size editing real and validated, strengthen compact menu status cues, and complete the product overview summary/photo placeholder.
- Separate predicted schedule timecards from confirmed actual shifts for break alerts and add timezone-safe regression coverage.
- Verify typecheck, lint, full tests, build, responsive UI, RTL, and 48px targets; then commit, push, and open a PR without merging.

No migration or pricing-formula change; migration 23 is already deployed.

Phase 3 result:
- [x] AI Team is a primary six-destination nav item; Home uses a truthful compact task summary and a responsive two-column secondary grid.
- [x] Deterministic tasks are tenant-checked, inserted idempotently, refreshed without erasing persisted lifecycle payload/status, and read back with real handled/watching history and responses.
- [x] Operations has URL-backed agent/status tabs, scoped counts, portrait-style identities, preserved entity metadata, and domain-correct deep links.
- [x] Menu size ordering is deterministic and selection-independent; View / Edit is a real 48px exact-size action with validated edit mode.
- [x] Product Overview now includes size, price, recipe cost/completeness, pricing state, sales, and a future-photo placeholder without schema changes.
- [x] Predicted schedule rows still estimate wages but cannot create real meal-break warnings/alerts; confirmed shifts retain 4.5h/5h thresholds and qualifying-break suppression.
- [x] Typecheck, lint, and full tests pass. Build is blocked only by the existing environment failure to fetch the three Google fonts; no browser runtime is installed for screenshots.

### Phase 3 correctness follow-up (PR #11)

Plan:
- Make legacy bare-number and custom size ordering deterministic by normalized label and stable item ID.
- Reconcile managed deterministic tasks by refreshing current facts and expiring obsolete unresolved tasks without touching staff/future external tasks or handled history.
- Add validated owner Keep current/Later actions using the existing task response lifecycle and migration-23 tables.
- Preserve the selected inbox status across teammate and All team navigation, then run all required checks and commit one PR #11 follow-up.

Result:
- [x] Bare numeric, same-unit, named, and custom sizes now sort independently of selected-item input order, with stable ID tie-breaking.
- [x] Obsolete unresolved managed tasks expire; handled history and external staff tasks remain untouched; refreshed deterministic facts override stale facts while workflow-only payload survives.
- [x] Alex cards support tenant-validated Keep current and Later decisions through the existing response lifecycle, with compensating cleanup if the guarded task update fails.
- [x] Teammate and All team links retain the active status tab.
- [x] Typecheck, lint, and full tests pass. Build is blocked only by the known Google Fonts network failure for Figtree, Fraunces, and IBM Plex Sans Arabic.

### Phase 3 final correctness follow-up (PR #11)

Plan:
- Make same-item View / Edit update local product state immediately instead of relying on query navigation to remount the component.
- Reactivate re-derived expired deterministic tasks, persist status/resolution clearing, and restrict synthetic supply expiry to projection-owned monthly watchers.
- Update the binding six-destination navigation documentation and localize the AI section label in en/es/ar.
- Run typecheck, lint, full tests, and build, then commit and push one PR #11 follow-up.

Result:
- [x] Current-size View / Edit immediately selects Overview, opens editing, and updates the query; other sizes still navigate by item ID.
- [x] Re-derived expired deterministic tasks reactivate and clear their old resolution, while handled/current lifecycle states remain preserved.
- [x] Only projection-owned monthly `supplies:{monthKey}` watchers expire automatically; real `supply:{itemId}` work survives.
- [x] Binding navigation docs now specify six destinations and the localized AI brand label is used in en/es/ar.
- [x] Typecheck, lint, and full tests pass. Build is blocked only by the known Google Fonts network failure for Figtree, Fraunces, and IBM Plex Sans Arabic.

### Phase 4B review follow-up (PR #15)

Plan:
- Base item-sales periods on trustworthy POS backfill/sync coverage rather than requiring a rollup on every calendar day, and move the pure calculation/tests into `lib/calc/`.
- Reconcile RecipeMatrix drafts when refreshed recipe props arrive after a successful save, and raise the newly added recipe status labels to the 17px body-text minimum.
- Run typecheck, lint, tests, build, and diff checks; then commit and push one focused PR #15 follow-up without applying migration 24.

Result:
- [x] Item-sales periods now use completed Square backfill/sync bounds; closed days need no synthetic rollup, unsupported coverage remains unavailable, and the pure calculation/tests live in `lib/calc/`.
- [x] Recipe refreshes remount the matrix from the saved recipe signature while staged additions remain visible until refreshed props arrive, so a successful addition never flashes back to Add.
- [x] Recipe state labels use the 17px body minimum. Typecheck, lint (one pre-existing image warning), all 294 tests, and diff checks pass; build is blocked only by Google Font fetch failures.

## Focused Menu UX correction (2026-10-02)

Plan:
- Replace the external recipe add panel with a compact, searchable inline draft row that supports existing or new ingredients across sizes while preserving conversion and staged Save/Cancel behavior.
- Restore information-rich size cards with truthful price/recipe state, cost and keep metrics, and per-card Today / 7 days / 30 days sales controls; refine the shared product hero and focused-size treatment.
- Verify responsive/RTL/accessibility behavior, add focused regressions where useful, run every requested check, capture the runnable UI if available, then commit and open one unmerged PR.

Result:
- [x] Recipe editing now stays inside the responsive matrix: one searchable draft row supports an existing or newly named ingredient, compact type selection, compatible per-size units, missing-size additions, row/cell removal, and staged Save/Cancel.
- [x] Product overview cards restore the approved visual hierarchy with price/cost/You keep, a truthful cost-versus-keep bar, separate amber/green price and recipe states, card actions, and inactive-size controls.
- [x] Units sold periods are scoped to each card and limited to Today / 7 days / 30 days, retaining trustworthy no-coverage messaging; the product hero and selected-size treatment are quieter and clearer.
- [x] English, Spanish, and Arabic UI copy is complete. Typecheck, all 294 tests, diff checks, and lint pass (one pre-existing ProductPhotoEditor `<img>` warning); production build is blocked only by Google Fonts network fetches. No browser runtime is installed for a screenshot.

### PR #16 final correction (2026-10-03)

Plan:
- Add an optional compact purchase-cost expression to genuinely new inline recipe ingredients, converting physical display quantities through the existing unit system before using the server action's existing cost fields.
- Expose canonical per-item daily quantities already loaded from order lines and render a truthful per-card sales mini-chart for Today / 7 days / 30 days, with no chart when trusted coverage is unavailable.
- Keep all other PR #16 behavior unchanged, run the full requested validation suite, and commit one follow-up to the existing branch without merging.

Result:
- [x] Genuinely new inline ingredients now accept an optional compact package price / quantity / physical-unit expression; existing catalog matches are selected without asking for cost, and the existing action receives base-unit quantity plus integer cents once.
- [x] The existing canonical order-line dates now produce coverage-gated daily item series for Today / 7 days / 30 days, including truthful covered zero-sale days, and each size card renders those real values as a compact bar chart.
- [x] Typecheck, diff check, lint (one pre-existing ProductPhotoEditor `<img>` warning), and all 296 tests pass. Build remains blocked only by failed Google Fonts network fetches.

### PR #16 locale-formatting follow-up (2026-10-03)

Plan:
- Replace the browser-default Units sold number formatting with the active next-intl formatter only.
- Run the requested typecheck, lint, test, and diff checks, then commit the isolated review fix without merging.

Result:
- [x] Units sold now uses `useFormatter().number(...)`, keeping server/client output deterministic and honoring the active en/es/ar locale.
- [x] Typecheck, all 296 tests, and diff checks pass; lint passes with the one pre-existing ProductPhotoEditor `<img>` warning.

### AI Team visual redesign (PR #18, 2026-10-04)

Plan:
- Add the four approved transparent character assets and centralize avatar, color, surface, and role-icon metadata in one reusable identity system.
- Rebuild the AI Team selector with raised characters, organic role backdrops, rich default/hover/selected states, accessible toggle filtering, responsive layout, and RTL-safe navigation; remove the separate All team control.
- Reuse compact forms of the same avatars in task cards without changing any task derivation, persistence, actions, or lifecycle behavior.
- Run typecheck, lint, tests, build, and diff checks; capture desktop, mobile, and Arabic RTL screenshots if the runnable environment supports them; then commit and open one unmerged PR.

Result:
- [x] Approved Alex, Olivia, Maya, and Leo cutouts are optimized as local transparent WebP assets and drive one shared visual definition with role colors and icons.
- [x] The responsive selector now raises each character above an organic CSS backdrop and information panel, adds reduced-motion-aware hover/focus treatment and a richer selected glow/name pill, and toggles the active agent while preserving task status.
- [x] The standalone All team control is removed; task cards reuse compact versions of the same character art and tinted identity surfaces without task-logic changes.
- [x] Typecheck, all 299 tests, diff checks, and lint pass (one pre-existing ProductPhotoEditor `<img>` warning). Build is blocked only by the known Google Fonts network failure. No browser runtime is installed for screenshots.

### PR #18 completion audit (2026-10-04)

Plan:
- Audit every AI Team acceptance criterion against the implementation, correcting any behavior or interaction-state gaps without changing task logic.
- Re-run the full requested validation suite and record any environment-only limitations.

Result:
- [x] Agent toggles now preserve a status parameter only when one is actually present, so clearing an agent from `/operations?agent=alex` returns to `/operations` while explicit status filters remain intact.
- [x] Keyboard focus now receives the same raised-card, stronger-backdrop treatment as pointer hover while retaining the separate accessible focus outline and reduced-motion behavior.

### PR #18 binary-diff compatibility (2026-10-04)

Plan:
- Preserve the exact approved transparent avatar pixels while replacing binary Git patch entries that the PR creation interface cannot submit.
- Re-run the required validation and commit the text-only asset representation so the diff-screen Create PR action can succeed.

Result:
- [x] Each approved WebP payload is now embedded losslessly in a local SVG wrapper; the rendered character artwork, transparency, dimensions, and reusable per-agent identity remain unchanged.
- [x] The PR diff contains no binary file entries, avoiding the interface's “Binary Files are not supported” rejection without adding remote assets or dependencies.

## Processing fees in pricing economics (Phase 1 only — 2026-10-05)

Plan:
1. Verify the requested pricing, POS, CSV, workbook, category-profile, and Alex-task behavior on
   `main` after PR #18, while keeping this PR limited to processing fees in pricing economics.
2. Add normalized monthly processing fees to the pricing read model and pure business economics,
   sourced from the existing provider-neutral daily rollups and counted exactly once.
3. Add deterministic scenario coverage for monthly scaling, profitable/shortfall/capped economics,
   warnings, and representative suggested-price movement; preserve the 1.15 cap and all existing
   tuning, then run the full validation suite. No dependency or migration planned.

Result:
- [x] Verified all 11 requested baseline findings on `main` after PR #18: CSV fees remain a hard-
  coded zero; pricing read/economics omitted rollup fees; Square already supplies actual fees;
  Excel reads only sheet 1; stability compares only the current price; task identity includes the
  suggestion; no recommendation cooldown/history exists; profiles share one target set; missing or
  zero recipe cost is unavailable; and the $19.50 wage is isolated to the break-even what-if.
- [x] Actual provider-neutral `daily_rollups.card_fees_cents` now becomes a separately named monthly
  processing input on the same 90-day-to-30-day basis as other variable economics and is included
  exactly once. Existing snapshot profitability is unchanged because its formerly combined
  ingredient-plus-fee amount is now split into the two canonical inputs.
- [x] Scenario tests cover factor 1.00 with fees, a fee-created 1.03 shortfall, a raw 1.20 factor
  capped at 1.15 with `BUSINESS_ADJUSTMENT_CAPPED`, exact-once composition, monthly scaling, and a
  representative suggestion moving from $5.25 to $5.50. The cap, target margin, rounding, current-
  price gate, ingestion, task lifecycle, provenance, and category profiles were not changed.
- [x] Typecheck, 304 tests, and diff checks pass. Lint passes with the one pre-existing product-photo
  `<img>` warning. Build remains blocked only by the known inability to fetch the existing Figtree,
  Fraunces, and IBM Plex Sans Arabic Google Fonts.

## Owner review — simulator, account identity, processing-fee UX, Staff truth, Money/Menu cleanup, aggregate ingredient cost (2026-10-06 — reviewed; implementation pending)

This review was performed after reading `AGENTS.md`, the binding design system, calculations,
integration docs, and the current implementation. **No calculation, POS, staff, recipe, pricing,
payroll, or break-even logic is changed by this documentation pass.**

### Findings and required follow-up

1. **Profit goal simulator Run button appears non-functional**
   - Current UI initializes the submitted target to 15% and computes the simulation immediately on
     first render.
   - Clicking **Run simulation** with the initial 15% therefore causes no visible state change; on
     unavailable data the click can also appear to do nothing.
   - [ ] Make Run simulation a real submit/run interaction (for example, no result until submitted,
     then update/focus the result and provide visible feedback) without changing
     `simulateProfitGoal()` math.

2. **Signed-in account identity should be visible without turning email into a café field**
   - Café profile currently calls `requireOwnBusiness()` but ignores the returned authenticated
     user, so the page has no understated indication of which account is signed in.
   - Email is account identity, not editable café data.
   - [ ] Add a calm, secondary **Signed in as <email>** account-identity treatment in the appropriate
     profile/settings context. Do not create a fake editable “your email” box and do not imply the
     email belongs to the café/location.

3. **Processing-fee estimate form needs owner-friendly explanation/progressive disclosure**
   - The existing math/source precedence is intentional and remains unchanged:
     connected POS actual > manual actual > owner-confirmed estimate > temporary estimate > missing.
   - Current fields represent: processor label; effective-from date; share of sales processed;
     share of orders processed; optional average processed ticket; and one or more rate rules with
     percentage fee, fixed fee/order, sales mix, and order mix.
   - The form is mathematically expressive but too technical for many owners.
   - [ ] Keep a simple blended-rate path as the default owner experience, with advanced multi-rate
     mixes only when needed; improve inline explanations without weakening provenance or actual-data
     precedence.
   - When a connected POS supplies trustworthy actual processing fees, those actual fees must
     automatically outrank the estimate. If a POS supplies sales/order facts but not trustworthy
     fee facts, the owner-confirmed estimate remains a fallback.

4. **Staff needs expected-vs-actual truth, a complete team/timing pane, and source reconciliation**
   - Current Staff view says “No one is clocked in right now” when `onShift` is empty, even though
     manual schedules are expected data rather than literal clock-ins.
   - Current `buildStaffViewModel()` can treat a materialized manual schedule as on-shift while the
     current time is inside the scheduled interval, but the screen does not clearly distinguish
     **Scheduled now** from **Clocked in now**, and it does not show the full active employee list
     with today’s/saved timings.
   - Current schedule materialization protects existing timecards when schedules are materialized.
     However, if a schedule-generated row exists first and an actual POS timecard arrives later,
     the POS sync can create a separate row instead of reconciling the expected row. This risks
     duplicate staff cost/status.
   - Required product rule: manual schedule = expected plan; trustworthy POS/imported timecard =
     actual. Use the manual schedule when actual attendance is unavailable. When actual arrives,
     actual wins for actual hours/cost/current status, while the schedule is retained as the
     comparison baseline so AI Cafe can show a calm discrepancy (expected vs actual) without double
     counting.
   - [ ] Design and test canonical schedule-vs-actual reconciliation before changing staff math.
   - [ ] Add a Staff/team pane listing active employees and their relevant timings/status, with
     **Add staff** located on that pane.
   - [ ] Distinguish source/status in plain language (for example Scheduled / Clocked in / Actual
     from Square) rather than calling scheduled data a clock-in.
   - [ ] Remove the duplicate plus on Add staff: the button already renders a Plus icon while the
     English label is currently “+ Add staff”.

5. **Money break-even card should be simpler**
   - [ ] Remove the visible **Ingredients at break-even** and **Processing fees at break-even**
     sub-cards from Money.
   - This is presentation-only: ingredient cost and processing fees remain required variable costs
     inside the true break-even calculation and its data-quality gates.
   - Keep the owner-facing summary focused on **Monthly break-even sales**, **Monthly bills**, and
     **Staff & employer costs**, with detail available deeper if needed.

6. **Menu Add button has a duplicate plus**
   - The button renders a Plus icon and the English label is currently “+ Add”.
   - [ ] Use one plus only (icon + “Add”, or text-only), preserving the 48px touch target and
     localized labels.

7. **Some owners only know total ingredient cost per menu item**
   - Current source-of-truth recipe cost is calculated from individual `recipe_lines` and
     ingredient price history. Do not fabricate a fake ingredient line merely to force a total into
     that model.
   - Product decision to make before implementation: support an owner-provided **total ingredient
     cost per item/size** as an explicitly sourced/statused fallback when a detailed recipe is not
     available, while keeping detailed recipe costing as the richer source once available.
   - A future implementation should preserve provenance, avoid double counting, define deterministic
     precedence, and surface the difference if a later complete recipe total disagrees with the
     owner-entered total.
   - [ ] Do not change current recipe/pricing logic until this fallback model, precedence, UI copy,
     and regression cases are explicitly approved.

### Suggested implementation sequencing

- [ ] **UI-only cleanup first:** real Run interaction, signed-in account identity treatment, remove
  duplicate plus signs, remove the two Money detail cards. No business-math changes.
- [ ] **Staff reconciliation second:** expected schedule vs actual POS/imported attendance, no
  duplicate costs, full team/timing view, discrepancy presentation.
- [ ] **Processing-fee comprehension pass:** simplify default UI/copy while retaining current
  canonical fee math and source precedence.
- [ ] **Aggregate ingredient-cost design decision:** add only after the fallback/provenance and
  recipe-precedence rules are agreed and covered by tests.

## UI + Staff provenance/reconciliation implementation (2026-10-06 — PR pending)

Scope intentionally combines the owner-requested first two passes only. Processing-fee UX/rate
entry and aggregate ingredient-cost fallback remain separate follow-up work.

Implemented:
- [x] Profit Goal Simulator is now submit-driven instead of pre-running the initial 15% target.
- [x] Café Profile shows the authenticated account as quiet account identity, not an editable café field.
- [x] Money removes the two visible Ingredients-at-break-even / Processing-fees-at-break-even cards;
      break-even math and data-quality requirements are unchanged.
- [x] Menu and Staff Add buttons render only one plus.
- [x] Added explicit timecard provenance: owner_schedule, owner_manual, connected_pos, imported,
      ai_cafe, with provider detail where available.
- [x] Staff shows a full active-team pane with today's hours and source tags; Add staff lives on that pane.
- [x] POS timecards reconcile into an existing employee/day row instead of creating a second
      timecard when owner schedule/manual/AI Cafe data already exists.
- [x] Reconciled actual POS rows retain their schedule_id for comparison but are treated as actual,
      not schedule predictions; schedule edits only rebuild true owner_schedule rows.
- [x] When connected actual clock times differ from the prior owner/AI-Cafe hours, an Olivia
      needs-owner operating task is written with both prior and actual timestamps/provider evidence.
- [x] Schema reserves ai_cafe provenance so the future worker-messaging clock-in/out transport can
      write canonical actual attendance without another provenance redesign.
- [x] Added regression coverage that a POS-confirmed timecard remains actual even when it retains
      its schedule baseline.

Deployment order:
- Apply migration 30 (`20261007000030_timecard_provenance.sql`) before deploying this application code.

Still intentionally deferred:
- [ ] Processing-fee estimate comprehension/progressive-disclosure redesign and automatic-field rules.
- [ ] Owner-provided total ingredient-cost fallback/provenance and precedence model.
- [ ] Worker messaging transport that invokes AI Cafe clock-in/out; this PR provides the canonical
      source boundary but does not pretend messaging delivery exists yet.

## Processing-fee UX + automatic-source pass (2026-10-06 — PR pending)

Scope is intentionally limited to processing-fee comprehension and automatic-use behavior. No pricing,
break-even, ingredient, or source-precedence formula changed.

Implemented:
- [x] Processing Fees now leads with what AI Cafe already knows instead of opening on a technical
      rate-plan form.
- [x] Connected POS/provider identity is surfaced when available.
- [x] The screen shows recent sales-day coverage by actual / estimated / missing processing fees.
- [x] Connected/imported actual fees remain canonical and automatically outrank the owner estimate.
- [x] If recent sales days are fully covered by actual fees, the fallback estimator is collapsed by
      default instead of asking the owner for unnecessary assumptions.
- [x] Added a direct path to upload an actual processing-fee report; owners with actual fee amounts
      are encouraged to use actuals rather than convert them into percentages.
- [x] Simplified the default manual fallback to: processor, effective date, one processed-sales
      share, percentage fee, and optional fixed fee.
- [x] In simple mode, the processed-sales share is also used for processed-transaction share. Owners
      with a materially different transaction mix can open Advanced settings.
- [x] Advanced settings retain the existing multiple-rate model, separate transaction share, sales
      mix, transaction mix, and rule labels.
- [x] Added tap/click info help for every technical processing-fee field.
- [x] AI Cafe detects recent days with trustworthy real provider order counts. For fixed per-payment
      fees, those order counts are used automatically. Average processed payment is requested only
      when fixed-fee math needs a transaction estimate and trustworthy order counts are unavailable.
- [x] Active connected provider pre-fills the processor label when there is no saved owner plan.
- [x] EN / ES / AR copy updated for the simplified owner flow and help text.
- [x] Existing deterministic source priority is unchanged:
      connected POS actual > manual/imported actual > owner-confirmed estimate > temporary estimate > missing.

Provider behavior confirmed during implementation:
- Square Payments exposes assessed processing fees on the Payment object, so Square actual fees can
  be used directly when complete.
- Do not assume Toast/Clover expose merchant contract rate terms. If a provider returns trustworthy
  actual fee amounts, use them; otherwise keep the owner-confirmed estimate as fallback.
- Rate-plan terms are not required when actual processing fees are available.

No migration is required for this pass.

Still deferred:
- [ ] Owner-provided aggregate ingredient cost per menu item/size with explicit fallback provenance
      and deterministic precedence against a complete recipe.
- [ ] Additional POS-specific tender/payment-method ingestion if we later want AI Cafe to derive the
      processed-sales share itself rather than asking the owner when that fact is unavailable.

## Pricing evidence analysis + processing-fee info popover (2026-10-08 — implementation in progress)

Owner correction:
- "Your price looks right" is too strong. KEEP_CURRENT_PRICE only means the deterministic cost-based
  engine does not currently recommend a price change; it is not proof of market fit or demand.
- Pricing analysis must separate cost evidence, the café's own sales response after a real price
  change, and sourced market/competitor evidence. Never call an internal cost benchmark an
  "industry standard."
- When a price changes, preserve source-aware price history so later analysis can compare covered
  sales days before vs after the change. If there is not enough comparable history, explicitly say
  there is not enough sales data instead of predicting demand.
- Nearby competitor claims are allowed only when sourced market observations exist. With no verified
  market observations, show that nearby competitor pricing is unavailable rather than guessing.
- Processing-fee info popovers should close on outside click/tap and Escape; owners should not need
  to click the info icon a second time.

Plan:
1. Replace the native persistent <details> processing-fee help with a controlled accessible popover
   that closes on outside interaction/Escape.
2. Add additive menu price-history provenance and record real owner/POS price changes idempotently.
3. Add pure/tested before-vs-after sales-response analysis using only sales-covered days with a
   minimum sample requirement; report units/day and revenue/day changes as observations, not causal
   predictions.
4. Add source-aware market-price observation support. The UI may compare against verified nearby
   observations when present and must otherwise say market evidence is unavailable.
5. Replace "Your price looks right" / equivalent copy with evidence-specific language and surface
   the price-change sales analysis on the product size card. Localize EN/ES/AR.
6. Run focused regression checks and keep pricing recommendation math unchanged.

Result:
- [x] Processing-fee help uses a controlled 48px info button; open help closes on outside
      click/tap and Escape instead of requiring a second click on the icon.
- [x] "Your price looks right" / "Prices look right" is replaced with neutral cost-evidence copy:
      "No cost-based price change suggested." This does not claim market or demand optimality.
- [x] Migration 31 adds tenant-scoped menu price history with source provenance and an atomic
      set-menu-price RPC. Owner edits and connected POS catalog changes now record real price
      changes without changing deterministic recommendation math.
- [x] Price response analysis compares 14 calendar-day windows around the latest recorded price
      change using only days explicitly marked with actual sales coverage. It requires at least
      7 covered days on each side and at least 20 pre-change units; otherwise the UI says there is
      not enough sales data.
- [x] When sufficient data exists, the product size view reports the recorded price increase/decrease,
      units sold per sales day before vs after, and revenue per sales day before vs after, with an
      explicit note that correlation is not proof of causation.
- [x] The price screen separates the deterministic product-cost benchmark from market evidence and
      explicitly says the cost benchmark is not an industry or competitor price.
- [x] Migration 31 adds source-aware nearby market observations. A market comparison requires at
      least 3 distinct observations within 8 km and no older than 90 days, then compares current
      price with their median. Without enough sourced observations, AI Cafe says so and does not guess.
- [x] EN / ES / AR copy updated, including AI Team zero-state wording so it no longer says
      "Prices look steady" as if demand/market fit were proven.
- [x] Added pure regression tests for insufficient sales data, observed before/after changes,
      covered zero-unit days, cost-benchmark comparison, competitor minimum sample, distance,
      freshness/deduplication, and median comparison.

Deployment order:
- Apply migration 31 (`20261008000031_pricing_evidence.sql`) before deploying this application code.
- Price-response analytics become trustworthy for price changes recorded after this migration.
  Existing current prices are seeded as an initial baseline; AI Cafe deliberately does not infer
  historical list-price changes from discounted order-line revenue.
- Nearby competitor comparison remains unavailable until a trusted collection process writes
  sourced observations. This milestone builds the evidence boundary and truthful UI; it does not
  scrape or invent competitor menus.

## Aggregate product-cost fallback (2026-10-09 — implementation in progress)

Owner-approved scope:
- Some cafés know the total ingredient/cup cost of a menu item/size but do not know every recipe
  line. Support that fact directly instead of fabricating a fake ingredient.
- A complete detailed recipe remains the preferred source. An owner-entered total cost is a fallback
  only when the detailed recipe is missing or incomplete.
- Preserve both values when both exist and surface their difference; never add them together.
- Every displayed/used product cost must expose provenance.
- Pricing, Profit Goal Simulator, and Break-even must use the same deterministic product-cost
  resolver so one screen cannot treat a cost as known while another treats it as missing.
- Aggregate fallback does not provide ingredient-level theoretical usage/waste detail; future waste
  analytics must continue to require detailed recipe evidence.

Plan:
1. Add a tenant-scoped per-menu-item aggregate cost table with explicit source/status and timestamps.
2. Add a pure `resolveProductCost()` calculation:
   complete recipe > owner-confirmed total > unavailable.
   If both complete recipe and owner total exist, recipe wins and the difference remains visible.
3. Wire the resolver into Menu edit/read models, operational pricing inputs, Profit Goal Simulator,
   and Break-even variable ingredient cost. Break-even must refuse rather than undercount when a
   sold item still has no resolved cost.
4. Add a simple per-size owner-total editor in the product Recipe workspace and source labels in
   Overview. Keep detailed recipe editing intact and clearly explain which source is currently used.
5. Localize EN / ES / AR and add focused regression tests for precedence, no double counting,
   incomplete-recipe fallback, complete-recipe override, and break-even missing-cost behavior.
6. No POS writes. No ingredient-level usage is inferred from the aggregate total.



Implementation result:
- [x] Added migration 32 with a tenant-scoped per-size aggregate product-cost fallback. It stays
      separate from recipe lines and carries source/status provenance.
- [x] One pure resolver now drives Menu, pricing, Profit Goal Simulator, and Break-even:
      complete recipe > owner total > unavailable. The two values are never added together.
- [x] When both values exist, the detailed recipe remains active while the owner total and
      difference stay visible for review.
- [x] Product Recipe workspace lets the owner enter/remove one total per size; Overview labels the
      active source as Calculated from recipe or Owner entered.
- [x] Break-even now derives ingredient cost from resolved sold-item costs and refuses to calculate
      when a sold item still lacks a usable product cost.
- [x] Alex/pricing evidence copy now says product cost rather than recipe cost.
- [x] Aggregate totals intentionally do not create ingredient-level usage/waste data.
- [x] EN / ES / AR copy and focused resolver/break-even regressions added.

Deployment order:
- Apply migration 32 (`20261010000032_aggregate_product_cost.sql`) before deploying this app code.
- Because production migration history is historically unreconciled, apply migration 32 deliberately;
  do not run a blanket `supabase db push` across old migrations.

Verification and review closure:
- [x] Moved sold-item product-cost aggregation/rounding into `lib/calc/productCosts.ts` so both
      break-even surfaces use one pure money calculation.
- [x] Archived menu items sold inside the break-even window remain in the resolved cost set even
      though they stay excluded from the active Menu display.
- [x] Estimated fallback provenance now propagates into Profit Goal / break-even quality, and
      imported/estimated costs are labeled truthfully in Menu.
- [x] The drinks/day break-even restores missing-sales precedence before missing-product-costs.
- [x] GitHub branch verification passed `npx tsc --noEmit` and the full `npm test` suite.
- [x] Vercel preview deployment succeeded after the strict-TypeScript fix.
- [x] Temporary branch-only verification workflow removed before merge; no permanent CI behavior
      is introduced by this phase.

## Supervisor-first Home UI (2026-10-10 — review ready, PR #33)

Owner-approved scope:
- Reorganize the existing Home into a Supervisor-first experience without replacing trusted Home calculations.
- Reuse the existing persisted operating-task system for Needs you / Handled / Watching; do not create a second inbox or status model.
- Keep /operations as the transparent Team workspace, but remove Team from primary navigation and expose it through a prominent Home Team button.
- Build the Ask anything composer as presentation-only in this PR. No fake AI responses, no conversational backend, no voice/transcription transport, and no new database migration.
- Use only current deterministic Home / Today-at-a-glance values. Do not invent labor or other metrics because they appear in a concept image.
- Preserve the existing Business overview sections beneath the new Supervisor/task area.

Plan:
1. Add a warm, mobile-first Supervisor hero, Team button, disabled future-ready Ask anything composer, and suggestion chips.
2. Add a compact Today snapshot from existing Home/Today viewmodels.
3. Add compact Needs you / Handled / Watching previews from persisted operating tasks, with existing teammate avatars/colors and links into the existing Team inbox.
4. Move the existing period-based money/detail content under a clear Business overview section, removing duplicated above-the-fold metrics where appropriate.
5. Change shared primary navigation to Home / Money / Menu / Staff / More while keeping /operations intact and reachable from Home.
6. Update EN / ES / AR copy and the binding navigation design note. No schema, calculation, pricing, POS, or task-lifecycle changes.
7. Verify TypeScript, lint, tests, build, and diff cleanliness. Use a temporary branch-only verification workflow if local dependency installation is unavailable, then remove it before review.

Asset note:
- Current main has only Alex / Olivia / Maya / Leo under public/ai-team; no approved standalone Supervisor avatar is present. This PR must not substitute one of those teammates or invent a new character. The hero will reserve the intended large Supervisor visual area using a neutral brand treatment until the approved asset is supplied.

Implementation result:
- [x] Home now leads with one warm Supervisor surface, a prominent Team button, the exact “Ask anything…” composer wording, future attachment/voice/send affordances, and suggestion shortcuts. The composer is deliberately disabled in this UI-only PR so it cannot pretend a conversation or action succeeded.
- [x] The Supervisor visual area is 150px on mobile and 190px on desktop. Main currently contains no approved standalone Supervisor avatar under `public/ai-team/` (only Alex, Olivia, Maya, and Leo), so this PR uses a neutral café/AI brand treatment rather than inventing or substituting a teammate. Swap in the approved Supervisor asset when it is supplied.
- [x] The compact Today snapshot reuses existing deterministic Home/Today-at-a-glance data for sales, owner profit, orders, and total costs, including existing Estimate / Partial truth labels where applicable.
- [x] Home now previews the existing persisted operating-task inbox as Needs you / Handled / Watching, with existing teammate avatars/colors and existing task destinations. No second task table, lifecycle, or status model was created.
- [x] Existing owner-profit, cost recovery, margin, missing-cost, profit/cost, staff, menu, break-even, and alerts features remain under Business overview; money calculations and deterministic engines are unchanged.
- [x] Shared primary navigation is now Home / Money / Menu / Staff / More. `/operations` remains intact and is reached through Home’s prominent Team button.
- [x] EN / ES / AR Supervisor Home copy and the binding design-system navigation note are updated.
- [x] No database migration, Supabase push, AI conversation backend, provider call, task action, POS write, or new dependency is part of this PR.

Verification:
- [x] `npx tsc --noEmit`
- [x] ESLint on every changed TS/TSX file
- [x] `npm run test`: 426 tests passed (including six new Home estimate-source regressions)
- [x] `npm run build`
- [x] `git diff --check origin/main...HEAD`
- [ ] Full-repository `npm run lint` still has two pre-existing errors outside this PR: `components/menu/AggregateProductCostEditor.tsx:41` (React set-state-in-effect rule) and `scripts/seed/demoData.mjs:639` (invalid-character parse error), plus existing warnings. The changed Supervisor Home files lint cleanly.

Phase-one review closure:
- [x] Verified `main` still ends at PR #32 and that this PR changes no `lib/calc/`, existing operating-task lifecycle, pricing engine, POS adapter, or database migration files.
- [x] New Today snapshot labels estimates when positive running costs, today's card processing fees, or today's payroll taxes use estimated sources; no new money calculation was introduced.
- [x] Task previews distinguish verified price application, owner-kept prices, future reminders, and pending verification. Supply checks route to existing Team inbox.
- [x] Review findings addressed: all See all links have at least 48px touch targets; task body and empty-state text use 17px.
- [x] The Home screen specification now documents the Supervisor-first layout while preserving the original business overview below it.
- [x] CI on the final implementation (before removing the temporary branch-only workflow) passed TypeScript, changed-file ESLint, all 426 Vitest tests, Next.js production build, and diff whitespace check.
- [x] Vercel preview for the implementation passed. The temporary branch-only verification workflow is removed in the final cleanup commit.
- [x] All three original PR review threads were addressed and resolved. No merge was performed.

## Supervisor Phase 2 — trusted read-only engine boundary (2026-10-10, review ready)

Verified starting point:
- PR #33 merged into main at a09dbb7; Phase 1 Home and all existing money/pricing/POS/task workflows remain unchanged.
- Existing `cafeStateFromSnapshot()` presented a full month's recurring costs against only the loaded sales days and marked snapshots fully known despite uncovered sales, missing card fees or product costs. The pricing slice was always unavailable despite canonical `getMenuControlCenter()` evidence; the tool interface returned unknown/unlabeled records and `getExpenseChanges` returned non-change rows.
- Phase 2 fixes the **AI-only** read boundary; it must not touch Home, money calculations, the canonical pricing engine, task persistence, POS writes, or production migrations.

Planned:
1. Make snapshot-to-CafeState period-scoped: use the existing pure cost math and calendar-day running-cost proration, keep observed partial slices visible as partial, and refuse confident profitability when source coverage or crucial costs are missing.
2. Carry source/estimate quality, dates, and missing-input reasons explicitly through typed `KnownSlice` results. Mark unavailable inventory, suppliers, unknown historic comparisons, and unsupported date ranges rather than inventing figures.
3. Add an optional, explicitly supplied canonical menu-pricing loader to the state service. It may only project items belonging to the loaded café; never compute new suggestions or interpret a cost benchmark as verified market evidence.
4. Make `StructuredCafeTools` return typed, evidence-carrying slices for profitability, pricing, products, labor, sales, and costs. Add a business-scoped tool facade so future Supervisor calls cannot supply arbitrary café IDs.
5. Add focused regression tests: Fixture A exact owner-profit numbers, correct proration, sparse/missing/estimated data, unsupported periods, canonical pricing evidence, tenant safety, and absent-service cases.
6. Run TypeScript, changed-file lint, Vitest, build, whitespace checks. Open review PR and do not merge; no new schema or `supabase db push`.

Implementation result:
- [x] `CafeState` now computes period-specific cents using existing `lib/calc` functions for profit and calendar-prorated monthly costs. A complete 9-day Fixture A gives sales 2,160,000¢, total costs 1,637,568¢, and owner profit 522,432¢; one day gives owner profit 58,048¢.
- [x] Individual bill lines for a requested period reconcile to the same rounded aggregate, with no parallel money formula.
- [x] Missing sales-day coverage, fees, expected bills, or sold-product cost prevents a "verified profitability" claim; estimated cost sources remain marked. Past/invalid/cross-month date requests fail closed until an authoritative historical bill loader is available.
- [x] Authenticated production factory binds the owner's current café, reads the same `getSnapshot` + `getMenuControlCenter` sources used by the existing screens, and projects only canonical pricing results belonging to that café. Historical reads never treat current pricing as historic pricing.
- [x] `StructuredCafeTools` exposes typed `KnownSlice` responses for profitability, product economics, sales trends, pricing, period costs, labor, and unavailable inventory. `getExpenseChanges` explicitly refuses change claims without matched prior-period evidence.
- [x] `BusinessScopedCafeTools` removes caller-supplied business IDs from future Supervisor tools; tenant mismatches are rejected.
- [x] Read-only `getTeamTasks` queries the existing persisted task inbox under RLS, preserves `needs_owner` / `handled` / `watching` evidence, and NEVER invokes the task reconciliation/writing function. Raw pricing signals remain separate from actionable task status.
- [x] No existing Home/Money/Menu calculation, task lifecycle, POS adapter, pricing formula, UI route, production migration, AI provider, or external API was modified or invoked.
- [x] Added `docs/supervisor-phase2-engine-boundary.md` for next-phase integration boundaries and known missing capabilities.

Verification and handoff:
- [x] GitHub branch CI: `npx tsc --noEmit`, changed-file ESLint, **456 Vitest tests**, `npm run build`, `git diff --check origin/main...HEAD` all passed.
- [x] Vercel preview successful on the tested implementation.
- [x] Temporary branch-only verification workflow removed before PR review. No permanent CI workflow is introduced.
- [ ] The existing whole-repository lint baseline still has errors unrelated to this phase (see Phase 1); this PR's files pass lint.
- [ ] Phase 3 is conversation identity/schema/threads/messages/grounded routing. The Home Ask anything field remains disabled until working backend wiring is reviewed and deployed.

## Supervisor Phase 3 — secured conversation foundation (2026-10-10, review ready)

Starting point: PR #34 is merged on main at 3c06226. The trusted Phase 2 read-only tool boundary, pricing and financial calculations, Team task lifecycle, POS behavior and the Phase 1 disabled composer must not change.

Scope:
1. Add additive `ai_threads` / `ai_messages` schema with strong owner+café identity, RLS, append-only owner message writes, composite tenant-consistent foreign keys, client-idempotency keys and room for future structured responses. Do not run blanket `supabase db push`.
2. Implement authenticated Next.js APIs for thread creation/listing and owner-message append/history, with bounded Zod validation, strict tenant+owner scoping, CSRF/origin safeguards and no-cache responses. Do not let callers insert Supervisor messages or alter business/owner identity.
3. Ensure source-of-truth owner messages are stored as owner messages. Do not fabricate AI replies, change tasks or invoke providers. The Ask anything composer stays disabled until grounded response routing is implemented in a subsequent PR.
4. Define typed Supervisor intent/grounding/structured reply contracts and a strict evidence gate for later connection to `BusinessScopedCafeTools`; any missing verified data is explicitly insufficient evidence.
5. Add regression tests for role spoofing, cross-owner/café isolation, malformed inputs, idempotency, incomplete grounding, and read-only semantics. Verify TypeScript, changed-file lint, tests, production build, Vercel and migration review. No production migration applied automatically.

Deploy order: review/apply migration 33 explicitly after reconciling production migration history, then deploy Phase 3 API code. The new routes fail closed if migrations are unavailable.

Phase 3 implementation / verification:
- [x] New additive migration 33 creates owner-private `ai_threads` and `ai_messages` with strict owner+café RLS, no authenticated UPDATE/DELETE policies, composite tenant/owner consistency, request/message idempotency keys, and structured future Supervisor message schema.
- [x] No authenticated owner can insert a Supervisor response or invent AI-generated facts; only owner text can be appended through session-authenticated API. The current Home composer intentionally stays disabled; sending a stored message returns `replyStatus: "not_enabled"`.
- [x] Authenticated owner-only thread/message endpoints support bounded strict JSON, same-origin POST protection, privacy/no-store headers, cursor-offset pagination, retries, conflict detection, and sanitized errors. No fixture fallback.
- [x] Phase 4 contracts cover Supervisor intent, evidence references, typed reply blocks, and a fail-closed verified/estimated/insufficient-evidence assessment; no generic model path or café-specific AI guesses added.
- [x] PostgreSQL integration RLS smoke test executes migration 33 on a disposable isolated Postgres instance. Proved owner A can write/read, owner B of the same café cannot read owner A, manager and outsider cannot read/write, authenticated owner cannot forge Supervisor messages or edit/delete history, and trigger timestamps update.
- [x] No changes to `lib/calc/`, Home/Money/Menu/Staff screens, pricing engine, POS integration, Team task lifecycle, or existing financial tables; no new dependencies and no production database mutations.
- [x] CI on tested commit d7058b2: `npx tsc --noEmit`, changed-file ESLint, **482 Vitest tests**, PostgreSQL RLS smoke test, `npm run build`, and `git diff --check` all passed; Vercel preview succeeded.
- [x] Temporary branch-only verification workflow removed after checks; the PostgreSQL smoke test script remains available for future execution.
- [ ] Before activating this PR in production, review/reconcile migration history and apply migration 33 deliberately (do not blanket `supabase db push`). Staging Supabase end-to-end session tests should supplement disposable-Postgres RLS tests.
- [ ] Phase 4 implements grounded tool routing, structured Supervisor replies, safe authorized response persistence and finally enables the Home Ask anything UI after successful end-to-end checks.

## Supervisor Phase 4 — grounded read-only conversation (2026-10-10, review ready)

Starting point: PR #35 is merged at b160197. Production migration #33 may have been applied manually; deployment history must be reconciled and authenticated staging tested. No further production SQL push in this phase.

Plan:
1. Reuse the authenticated, owner-scoped Phase 3 message flow and Phase 2 café tools. Add deterministic, allow-listed intent selection for overview/profit, Team tasks, staff, menu price review and bill summaries. Unknown requests must say they are unsupported; never route arbitrary model-suggested tools.
2. For every answer, require real per-business evidence (existing profit engine, pricing engine, or persisted operating_tasks), classify verified vs estimated vs insufficient, and return typed structured reply blocks. Money always remains integer cents from trusted tools.
3. Store Supervisor blocks via an audited privileged **server-only writer** bound to a previously authenticated owner message, with deterministic idempotency; never expose an insert-Supervisor endpoint or permit client-selected business/user/role/evidence.
4. Enable the Home text composer, suggestion chips and persisted chat history behind `SUPERVISOR_CHAT_ENABLED=true` plus configured service role and authenticated session. Keep +, microphone and WhatsApp disabled until their real workflows are available. EN/ES/AR and accessible controls. No fake replies.
5. Keep read-only: no price updates, task status changes, POS writes, new tables, or calculations. Add router, idempotency, fail-closed, data quality and tenant-isolation tests; run build/CI and open an unmerged PR.

Phase 4 implementation and safety closure:
- [x] New finite intent router handles recorded-profit summaries for Today/last seven calendar days/current month; recurring bills; canonical pricing-review suggestions; persisted Team and Olivia task status; unsupported questions return an honest no-evidence response.
- [x] Historic or future periods not backed by the Phase 2 trusted dataset are refused. Missing or stale data never becomes a verified metric; estimated sources are labeled. No pricing action, staff action, POS write, task reconciliation, AI provider guess, or business formula was added.
- [x] Phase 1 Supervisor hero and placeholder preserved. The Home text composer, suggested prompts, history and new threads are functional behind `SUPERVISOR_CHAT_ENABLED=true`; voice/attachments remain disabled.
- [x] Authenticated owner scope comes from Phase 3. A server-only service-role writer writes structured vetted Supervisor blocks with exact evidence, immutable original owner-message provenance and stable reply ID for race-safe retries. No client-accessible Supervisor insert endpoint.
- [x] Localized response and Home chat text in EN/ES/AR. No additional SQL migration or npm dependency.
- [x] Regression coverage includes missing/unverified/stale sources, exact owner-profit cents, pricing provenance, false period interpretation, persisted task statuses, owner/café-bound reply persistence and idempotency.
- [x] GitHub Actions verified TypeScript, changed-file ESLint, **501 Vitest tests**, Next.js production build and `git diff --check` on implementation commit b2897c8. The temporary branch-only workflow was removed afterward.
- [ ] Vercel deployment preview could NOT be verified: Vercel's commit status points to `upgradeToPro=build-rate-limit`. This is a deployment-rate limit; GitHub CI production build passed. Re-try preview after Vercel rate-limit clears before production activation.
- [ ] Phase 3 migration #33's live Supabase application and migration history are not independently confirmed in this chat. Enable `SUPERVISOR_CHAT_ENABLED=true` only after reconciling migration 33 and staging end-to-end owner/RLS checks.
- [ ] Whole-repository lint baseline errors identified in Phase 1 remain unrelated; changed files pass.

## Supervisor Phase 5 — owner rules, reviewed policies and safe permissions (2026-10-10, review ready)

Merged baseline: PR #36 (main 82b7c907). Existing priced/menu/staff/POS financial math and the persisted Team task workflow MUST remain untouched.

Phase 5 scope:
1. Store typed Supervisor/Alex/Olivia/Maya/Leo owner instructions as owner-only café-scoped **drafts**. Activation or rejection requires a separate explicit owner approval. Pausing and resuming are owner-reviewed state transitions; every transition is immutable audited history.
2. Validate and enforce all transitions server-side and database-side. No free-form rule text is ever evaluated as code, SQL, an action, or permissions escalation.
3. A default-deny authorization contract preserves existing read-only tools; no price, staff schedule, POS, supplier email, payroll or expense changes may be executed by the Supervisor merely because an owner wrote a rule or approved a policy. Existing Team price-review/coverage pathways remain canonical, not duplicated.
4. Provide an accessible localized Team → Rules screen for creating draft instructions per agent, reviewing/approving/rejecting, pausing/reactivating, and viewing the audit trail. Add a small link on the existing Team page without displacing its persisted inbox.
5. Add authenticated bounded JSON APIs, owner+café RLS SQL and separate disposable PostgreSQL security checks. Build/tests/lint/Next prod compile, PR open but not merge. Additive migration #34 must be reviewed/applied in order after migration #33; never blanket db push.

Phase 5 implementation and handoff:
- [x] Adds explicit owner-only, café-scoped AI Team rules for Supervisor, Alex, Olivia, Maya and Leo. Instructions are immutable human guidance. Owners save drafts, then approve/reject; active rules can be paused/resumed. No draft silently activates or becomes a new Team operating task.
- [x] Includes `ai_team_rules` and append-only `ai_rule_events` (additive migration 34), database-enforced transition graph and owner role RLS, concurrent version checks, actor/time attribution, no direct audit insert or rule delete permission.
- [x] New owner-authenticated JSON APIs, versioned change review, bounded strict validation, same-origin write protection and sensitive no-store responses. New Team → Rules page and history, localized EN/ES/AR and accessible text/buttons.
- [x] The Phase 4 grounded Supervisor can **read back** up to three active approved instructions on request, citing the authenticated rules source. It never executes or interprets arbitrary instruction text as permission.
- [x] A typed `evaluateSupervisorPermission` boundary permits allow-listed reads only; new AI-side price, payroll, staff, supplier, POS and unknown writes always deny. Existing Team task and domain action workflows remain unchanged.
- [x] No edits to `lib/calc/`, business pricing formulas, POS connections, payroll engines, operating_tasks lifecycle or existing money pages. No new npm packages.
- [x] Verified TypeScript, changed-file ESLint, **516 Vitest tests**, PostgreSQL migration/RLS/approval checks for both migrations 33 and 34, Next.js production build, and `git diff --check`, on commit 5e0faee. GitHub CI succeeded.
- [ ] Vercel preview was **not** verified; Vercel returned a build-rate-limit account link (`upgradeToPro=build-rate-limit`). GitHub Next.js production build passed; retry preview after rate limit clears.
- [ ] Before production rollout, review and apply migration `20261010000034_ai_owner_rules.sql` **after confirming migration 33 is installed**, reconcile Supabase migration history and verify owner/manager/other-café RLS in staging. **No blanket `supabase db push`** and no production migration executed here.
- [ ] Free-form owner instructions are stored and auditable, but do not drive new autonomous business operations. Owner approval of a rule is **not** approval to execute an operational action; future executor must bind to canonical existing task/decision workflow.
- [x] Temporary branch-only CI workflow removed before handoff; no permanent workflow added.

## Phase 6 — owner-reviewed voice and private reference files (2026-10-10)
- [x] Browser voice recognition where supported; transcript appears in editable Home input and is never automatically sent. No audio persisted.
- [x] Additive migration 35 creates private Storage bucket and owner/café/thread RLS metadata; server validates 2 MiB limit, content-type and file signature. Uploaded documents are **unanalysed references** only and never change café prices, costs or reply evidence.
- [x] Authenticated owner-only attachment list/upload API; localized EN/ES/AR Home affordances; source filenames visible in conversation and reopenable using owner-authenticated 60-second download links.
- [x] CI TypeScript, changed-file lint, tests, build and diff passed. No financial calculation modifications or new packages.
- [ ] Browser support varies; device tests still required. No OCR/document extraction or server audio-transcription fallback in this phase.
- [ ] Apply migration 35 after reconciling 33/34; test actual Supabase Storage RLS with multiple identities before deployment.

## Phase 7 — opt-in proactive owner WhatsApp task alerts (2026-10-10)
- [x] Owner phone consent is explicit, tied to the current verified Supabase Auth phone by API and database trigger, owner/café-scoped under RLS; opt-out is supported.
- [x] The daily cron reads the existing persisted `operating_tasks` inbox and only selects an actual `needs_owner` task. Checks membership and phone verification again before delivery.
- [x] Meta WhatsApp template adapter makes a real configured provider call, returns success only on a provider receipt, sends task category only and reserves a unique outbox row first. No automatic resend after an uncertain result.
- [x] Owner-facing localized EN/ES/AR preference panel. Default off unless AI_CAFE_WHATSAPP_ENABLED, verified consent, CRON_SECRET, Meta credentials and approved template.
- [x] Tests, TypeScript, changed-file lint and production build passed. No existing operating-task, pricing or finance engine mutation.
- [ ] Migration 36 needs a deliberately reconciled SQL rollout after 33–35. Provider Meta template, account, cron environment and staging verification are external prerequisites.
- [ ] Staff-to-AI WhatsApp conversations and employee consent/webhook responses are **not** enabled by this owner alert delivery phase.
