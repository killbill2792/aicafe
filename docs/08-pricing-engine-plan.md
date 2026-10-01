# Suggested Pricing Engine

## Context

The existing "suggested price" on `/menu/manage` (`recommendedPriceCents` in `lib/calc/ingredients.ts`)
only ever targets ingredient cost at 30% of price. Across a long back-and-forth with the client's
real question ("I want to sell based on your suggestion"), it became clear this was never going to
be a complete, trustworthy selling price — it ignores labor entirely, ignores whether the café
already has real sales/economics to learn from, and never compares against what's already on the
menu. The client explicitly wants a number she can actually price her menu from, not a cost-health
floor. Raj specified a complete, deterministic pricing-engine design (reproduced faithfully below)
that fixes this: ingredient + labor cost as the true product cost, a configurable per-category
pricing profile (not hardcoded ratios), automatic detection of whether a café has enough real sales
history to adjust for its own economics, and a price-change-stability gate so it never nags about
trivial differences or auto-changes a menu price. **This plan is being handed to Codex (OpenAI's
coding agent CLI) to implement in full** — Raj is running it as a second agent in parallel. The
plan is written so it's directly executable without further design decisions.

This explicitly does **not** redesign the existing ingredients, staff, monthly-expenses, or
Toast/Square import systems — it only adds new code that reads from them.

## Architecture (new files only; nothing existing is redesigned)

```
lib/constants.ts                     (extend) — MENU_ITEM_CATEGORY_CODES, MenuItemCategoryCode type
lib/calc/types.ts                    (extend) — PricingProfile, PricingMode, PricingStatus, PricingConfidence, engine I/O types
lib/calc/pricingBaseline.ts          (new)    — Step 3: baselinePriceCents
lib/calc/pricingMode.ts              (new)    — Step 4: detectPricingMode (pure decision over a precomputed signal)
lib/calc/pricingBusiness.ts          (new)    — Steps 5/6: businessEconomics, businessAdjustmentFactor
lib/calc/pricingRounding.ts          (new)    — Step 7: applyRounding
lib/calc/pricingCategorySanity.ts    (new)    — Step 8: categorySanityWarnings
lib/calc/pricingStability.ts         (new)    — Step 9: priceChangeStatus
lib/calc/pricingConfidence.ts        (new)    — Step 12: pricingConfidence, explanationCodeFor
lib/calc/pricingEngine.ts            (new)    — orchestrator: suggestPrice(input) composes all of the above, per item
lib/calc/ingredients.ts              (modify) — DELETE recommendedPriceCents + its test cases (fully superseded)
lib/calc/index.ts                    (modify) — export the new pricing* modules

lib/pricing/profiles.ts              (new)    — PricingProfile default values + tunable thresholds (plain config, not lib/calc)

lib/data/getPricingInputs.ts         (new)    — dedicated server-only fetch; does NOT reuse or modify snapshot.server.ts
lib/data/getMenuItemsForEdit.ts      (modify) — widen `category` field type to MenuItemCategoryCode

lib/viewmodels/pricingViewModel.ts   (new)    — calls getPricingInputs, resolves each item's profile, builds category-peer stats, calls suggestPrice per item

lib/actions/menuItems.ts             (modify) — widen category zod schema to MENU_ITEM_CATEGORY_CODES

components/menu/ManageMenuPanel.tsx  (modify) — category picker (8 values, was 2), suggested-price block replaced with full engine output
app/[locale]/menu/manage/page.tsx    (modify) — fetch the pricing viewmodel, pass it + new labels down

messages/en.json, es.json, ar.json   (modify) — new category names, status/confidence/warning copy (see "UI copy" below)

supabase/migrations/<ts>_remap_menu_item_categories.sql (new) — one-time data migration for existing rows, see "Category migration" below. No CHECK-constraint migration needed — `menu_items.category` is already a plain unconstrained `text` column (confirmed in 20260926000004_catalog.sql).

lib/calc/pricingBaseline.test.ts, pricingMode.test.ts, pricingBusiness.test.ts,
pricingRounding.test.ts, pricingCategorySanity.test.ts, pricingStability.test.ts,
pricingConfidence.test.ts, pricingEngine.test.ts                        (new Vitest files)
```

**Confirmed reused as-is, do not touch:**
- `itemIngredientCostCents` (`lib/calc/ingredients.ts`) — sole source of ingredient cost, unchanged.
- `menu_item_quantities_sold(p_business_id, p_from, p_to)` RPC (`supabase/migrations/20260928000013_menu_item_quantities_rpc.sql`) — plain date-ranged function, not hardcoded to 28 days. Reuse directly with a wider range.
- `staffCostCentsForPeriod`, `netSalesCentsForPeriod`, `bandFor` (`lib/calc/profit.ts`).
- `businesses.payroll_tax_rate` access pattern — `supabase.from("businesses").select("payroll_tax_rate").eq("id", businessId).single()`, fallback `0.12`.
- The `HealthBand`-style enum → Tailwind-color → i18n-copy idiom in `components/money/ProfitCostsView.tsx` (`bandFor` → `BAND_COLOR` map → `t("bandHealthy"/"bandWatch"/"bandHigh")`) — reuse this exact pattern for the new status/confidence badges instead of inventing a different one.
- Resale/wholesale items (e.g. a vendor-bought croissant) already work today as a 1-line recipe with an "each"-based ingredient — verified end-to-end this session. `itemIngredientCostCents` already handles them with zero special-casing, so Step 1 needs no extra logic for this case.

**Explicitly NOT touched:** `lib/data/snapshot.server.ts`'s private `getMenuItemSnapshots()`/`rowToDailyFacts()` and the shared `allDays`/`last28Days` window it computes for Home/Money/Menu. It hardcodes a `"drink"|"food"` category coercion and a fixed ~28-day window that this feature must not inherit or widen — `getPricingInputs.ts` is a fully independent query.

## Step 1 — Product cost

`productCostCents = itemIngredientCostCents(recipeLines, latestIngredientPriceMicros)` — already exists,
just called from the new data layer. Do not add staff or monthly expenses here. Packaging/disposables,
when the owner wants to track them, are just another recipe-line ingredient (no new schema — same
mechanism already verified for resale items).

## Step 2 — `lib/calc/types.ts` additions

```ts
export type PricingCategory =
  | "ESPRESSO_DRINK" | "BREWED_COFFEE" | "COLD_BREW" | "TEA"
  | "SPECIALTY_DRINK" | "PASTRY" | "FOOD" | "RETAIL";

export type RoundingRule = { incrementCents: number; mode: "nearest" | "up" | "down" };

export type PricingProfile = {
  businessType: "COFFEE_SHOP";
  category: PricingCategory;
  targetProductCostPercent: number;      // 0.30 default (existing docs/05-calculations.md midpoint)
  minimumProductCostPercent: number;     // 0.25
  maximumProductCostPercent: number;     // 0.35
  minimumPriceChangePercent: number;     // 0.05 — Raj's own example value, use verbatim
  minimumPriceChangeAmountCents: number; // 25   — Raj's own example value ($0.25), use verbatim
  reviewWindowDays: number;              // 90   — upper bound of Raj's "approximately 60-90 days"
  roundingRule: RoundingRule;            // { incrementCents: 25, mode: "nearest" }
  targetOperatingMargin: number;         // 0.15 — see "Open default" note below
  businessAdjustmentCap: number;         // 1.15 — Raj's own example value, use verbatim
};

export type PricingMode = "BENCHMARK" | "BUSINESS_ADJUSTED";
export type PricingStatus = "NEW_PRICE" | "KEEP_CURRENT_PRICE" | "REVIEW_PRICE";
export type PricingConfidence = "LOW" | "MEDIUM" | "HIGH";

export type BusinessEconomicsInput = {
  monthlyRevenueCents: number;
  monthlyVariableProductCostCents: number;
  monthlyStaffCostCents: number;
  monthlyOperatingCostCents: number;
};
export type BusinessEconomicsResult = {
  totalMonthlyCostCents: number;
  operatingSurplusCents: number;
  operatingMargin: number; // 0 when revenue is 0, never NaN/Infinity
};
export type BusinessAdjustmentResult = {
  businessAdjustmentFactor: number;
  cappedForReview: boolean;
};

export type PosHistorySignal = {
  daysWithSalesInWindow: number;
  windowDays: number;
  totalOrdersInWindow: number;
  itemUnitsSoldInWindow: number;
};

export type CategoryPeerStats = { medianPriceCents: number; medianProductCostPercent: number } | null;

export type PricingWarningCode =
  | "BUSINESS_ADJUSTMENT_CAPPED"
  | "CATEGORY_PRICE_OUTLIER"
  | "CATEGORY_COST_PERCENT_OUTLIER"
  | "INCOMPLETE_RECIPE"
  | "LOW_SAMPLE_SIZE";

/** Field names reconcile the spec's Step 9 ("calculatedSuggestedPrice") and Step 11
 * ("suggestedPrice") into one canonical name — they're the same value. */
export type PricingResult = {
  productCostCents: number;
  baselinePriceCents: number;
  calculatedSuggestedPriceCents: number; // post-rounding (Step 7), pre-stability-gate
  currentPriceCents: number;
  recommendedPriceCents: number;         // post-stability-gate (Step 9) — what the UI shows as "the" number
  calculationMode: PricingMode;
  businessAdjustmentFactor: number;
  confidence: PricingConfidence;
  status: PricingStatus;
  explanationCode: "BENCHMARK_EXPLAINER" | "BUSINESS_ADJUSTED_EXPLAINER" | "INCOMPLETE_DATA_EXPLAINER";
  warnings: PricingWarningCode[];
};
```

**Open default flagged for Raj/Codex to revisit if it feels wrong in practice**: `targetOperatingMargin
= 0.15` (15%) — a commonly-cited healthy net margin for an independent café after all costs. This is
the single biggest lever on how aggressively BUSINESS_ADJUSTED mode nudges prices up, so if it ever
looks too pushy or too timid against a real café's numbers, this is the one constant to tune first —
it lives in `lib/pricing/profiles.ts`, not buried in engine logic.

## Step 3 — `lib/calc/pricingBaseline.ts`

```ts
export function baselinePriceCents(productCostCents: number, targetProductCostPercent: number): number;
// = productCostCents / targetProductCostPercent, guarded against 0/negative inputs (return 0)
```

## Step 4 — `lib/calc/pricingMode.ts`

```ts
export function detectPricingMode(signal: PosHistorySignal): PricingMode;
```
Pure decision, no I/O. Proposed concrete thresholds (spec gives no numbers — these are flagged
defaults, named constants in `lib/pricing/profiles.ts` so they're as tunable as everything else):
```
MIN_COVERAGE_RATIO = 0.5       // at least half the window's days have any sales
MIN_ORDERS_IN_WINDOW = 200     // ~2/day over 90 days — clears quickly for any real café, excludes a freshly-connected POS with a handful of test orders
```
`BUSINESS_ADJUSTED` when `daysWithSalesInWindow/windowDays >= MIN_COVERAGE_RATIO AND totalOrdersInWindow >= MIN_ORDERS_IN_WINDOW AND monthlyRevenueCents > 0`. `BENCHMARK` otherwise.

For item-level confidence (not mode): `MIN_ITEM_UNITS_SOLD = 20` — an item sold fewer than 20 times
in the window doesn't support claiming HIGH confidence about its own cost%, even when the business
overall is BUSINESS_ADJUSTED.

## Step 5 & 6 — `lib/calc/pricingBusiness.ts`

```ts
export function businessEconomics(input: BusinessEconomicsInput): BusinessEconomicsResult;
// totalMonthlyCostCents = monthlyVariableProductCostCents + monthlyStaffCostCents + monthlyOperatingCostCents
// operatingSurplusCents = monthlyRevenueCents - totalMonthlyCostCents
// operatingMargin = revenue === 0 ? 0 : operatingSurplusCents / monthlyRevenueCents

export function businessAdjustmentFactor(
  economics: BusinessEconomicsResult,
  monthlyRevenueCents: number,
  targetOperatingMargin: number,
  cap: number,
): BusinessAdjustmentResult;
// targetMonthlySurplus = monthlyRevenueCents * targetOperatingMargin
// surplusShortfall = targetMonthlySurplus - economics.operatingSurplusCents
// shortfall <= 0 -> { businessAdjustmentFactor: 1.00, cappedForReview: false }
// shortfall > 0  -> requiredRevenue = monthlyRevenueCents + surplusShortfall
//                   rawFactor = requiredRevenue / monthlyRevenueCents
//                   businessAdjustmentFactor = Math.min(rawFactor, cap)
//                   cappedForReview = rawFactor > cap
```
Never allocate rent/payroll per item — both functions operate purely at the business level, exactly
as specified. The cap must never be exceeded by the *applied* factor — this is the single
highest-stakes piece of the whole engine (an uncapped factor could suggest an absurd price swing),
so it needs the most thorough test coverage (see Testing below).

## Step 7 — `lib/calc/pricingRounding.ts`

```ts
export function applyRounding(rawCents: number, rule: RoundingRule): number;
```
`"nearest"` rounds to the closest multiple of `incrementCents` (ties round up — document this
explicitly in a comment). `"up"`/`"down"` are ceil/floor variants, kept available since `"up"` matches
the old `recommendedPriceCents`'s "never land under target" guarantee exactly — useful if a future
profile wants that behavior back for a specific category.

`calculatedSuggestedPriceCents = applyRounding(baselinePriceCents × businessAdjustmentFactor, profile.roundingRule)`
(in BENCHMARK mode, `businessAdjustmentFactor` is always 1.00, so this correctly reduces to just the
rounded baseline).

## Step 8 — `lib/calc/pricingCategorySanity.ts`

```ts
export function categorySanityWarnings(
  calculatedSuggestedPriceCents: number,
  productCostPercent: number, // productCostCents / calculatedSuggestedPriceCents
  peers: CategoryPeerStats,
): PricingWarningCode[];
```
Validation-only — never mutates the price. `peers === null` → `[]` (too few comparable items).
Proposed flagged thresholds (named constants in `lib/pricing/profiles.ts`):
```
MIN_CATEGORY_PEERS = 3              // need at least 3 other active items in the category to compare against
CATEGORY_PRICE_OUTLIER_RATIO = 0.5  // suggestion >50% above/below the category's median price -> CATEGORY_PRICE_OUTLIER
CATEGORY_COST_PCT_OUTLIER_PP = 0.15 // item's cost% >15 percentage points from category median -> CATEGORY_COST_PERCENT_OUTLIER
```
`peers` (median price, median cost%) is computed in `pricingViewModel.ts` from the already-fetched
`items` list grouped by category — no extra query needed.

## Step 9 — `lib/calc/pricingStability.ts`

```ts
export function priceChangeStatus(
  currentPriceCents: number, // 0 or null-ish for a brand-new item with no price yet
  calculatedSuggestedPriceCents: number,
  minimumPriceChangePercent: number,
  minimumPriceChangeAmountCents: number,
): { status: PricingStatus; recommendedPriceCents: number };
```
`currentPriceCents <= 0` → `{ status: "NEW_PRICE", recommendedPriceCents: calculatedSuggestedPriceCents }`.
Otherwise: `threshold = Math.max(currentPriceCents * minimumPriceChangePercent, minimumPriceChangeAmountCents)`;
`Math.abs(calculatedSuggestedPriceCents - currentPriceCents) < threshold` → `KEEP_CURRENT_PRICE` with
`recommendedPriceCents = currentPriceCents`; else `REVIEW_PRICE` with `recommendedPriceCents =
calculatedSuggestedPriceCents`. The `Math.max(...)` of the two threshold types matters — test both a
high-priced item (percent dominates) and a low-priced item (flat amount dominates).

**Deferred by design, not an oversight**: no `price_suggestion_history` table. The spec's "don't react
to one unusual week" concern is already substantially addressed by Step 5's 60-90 day averaging
window — a single bad week is a small fraction of that window before the business-adjustment factor
is even computed. Every page load recomputes fresh and is idempotent; nothing requires persisted
state to satisfy Step 9 as written. Add a history table later only once there's a concrete second
reason for it (e.g. "show me how this changed over 3 months" as an actual feature request) — building
it now means committing to a write-trigger design (on view? nightly cron? neither exists yet) the
spec doesn't actually require.

## Step 10 — No waste input

Not implemented. Use recipe cost as-is; this step is explicitly future-scoped in the spec itself
("if inventory/purchase data exists") and inventory data doesn't exist in this app yet.

## Step 11 — `lib/calc/pricingEngine.ts` (orchestrator)

```ts
export type SuggestPriceInput = {
  productCostCents: number;
  currentPriceCents: number;
  hasCompleteRecipe: boolean;
  profile: PricingProfile;
  posSignal: PosHistorySignal;
  economics: BusinessEconomicsInput | null; // null is fine when mode will clearly be BENCHMARK
  categoryPeers: CategoryPeerStats;
};

export function suggestPrice(input: SuggestPriceInput): PricingResult;
```
Composes Steps 3–9 and 12 for exactly one item. `itemIngredientCostCents` is never called from here —
`productCostCents` arrives pre-computed from the caller, keeping this file pure per the existing
`lib/calc` convention (no Supabase, no `Date.now()`, no I/O).

## Step 12 — `lib/calc/pricingConfidence.ts`

```ts
export function pricingConfidence(
  mode: PricingMode,
  hasCompleteRecipe: boolean,
  hasEnoughSample: boolean, // itemUnitsSoldInWindow >= MIN_ITEM_UNITS_SOLD
  businessAdjustmentCapped: boolean,
): PricingConfidence;

export function explanationCodeFor(mode: PricingMode, confidence: PricingConfidence): PricingResult["explanationCode"];
```
`BENCHMARK` → always `MEDIUM` (per spec, explicit, not data-dependent). `BUSINESS_ADJUSTED`: all of
{complete recipe, enough sample, not capped} true → `HIGH`; exactly one false → `MEDIUM`; two or more
false → `LOW`. Never upgraded by guesswork — confidence only ever comes from these concrete flags.

## Data layer — `lib/data/getPricingInputs.ts` (new, independent of `snapshot.server.ts`)

```ts
export type PricingItemInput = {
  id: string;
  name: string;
  category: MenuItemCategoryCode;
  currentPriceCents: number;
  productCostCents: number;
  hasCompleteRecipe: boolean; // recipeLines.length > 0 && productCostCents > 0
  unitsSoldInWindow: number;
};
export type PricingBusinessInput = {
  windowDays: number;
  daysWithSalesInWindow: number;
  totalOrdersInWindow: number;
  monthlyRevenueCents: number;
  monthlyStaffCostCents: number;
  monthlyOperatingCostCents: number;
  monthlyVariableProductCostCents: number;
};

export async function getPricingInputs(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ items: PricingItemInput[]; business: PricingBusinessInput }>;
```
Implementation:
1. Business timezone + today's date, same pattern as `lib/actions/menuItems.ts`/`snapshot.server.ts`.
   `windowDays = 90` (from the default profile). `fromDateStr = today − 90 days`.
2. `menu_items` — select `id, name, price_cents, category` for this business, active only. Keep the
   full `category` string as-is; do **not** coerce to `"drink"|"food"` the way `snapshot.server.ts`
   does for its own, separate purpose.
3. `recipe_lines` + `ingredient_prices`, joined exactly like `getMenuItemsForEdit.ts` already does, to
   compute `productCostCents` per item via `itemIngredientCostCents`.
4. `supabase.rpc("menu_item_quantities_sold", { p_business_id, p_from: fromDateStr, p_to: today })` —
   reused as-is with the wider range, for `unitsSoldInWindow` per item.
5. `daily_rollups` rows in `[fromDateStr, today]` → `daysWithSalesInWindow` (count of rows with
   `orders_count > 0`), `totalOrdersInWindow` (sum), `monthlyRevenueCents = Σ net_sales_cents ×
   (30/windowDays)`, `monthlyStaffCostCents = staffCostCentsForPeriod(mappedRows) × (30/windowDays)`
   (reuses the existing pure `lib/calc/profit.ts` function — calling a `lib/calc` function from
   `lib/data` matches the existing convention elsewhere in this codebase).
6. `monthlyOperatingCostCents` — **new, simple**: sum `recurring_costs.amount_cents` directly for this
   business where `category_code != 'ingredients'` and the row is currently active (mirror the
   `active_from <= today AND (active_to IS NULL OR active_to >= today)` filter already used in
   `snapshot.server.ts`, but as a flat sum here, not a per-category breakdown — do not extract or
   touch `snapshot.server.ts`'s own `runningCostLines` logic to get this number).
7. `monthlyVariableProductCostCents = Σ_items(unitsSoldInWindow × productCostCents) × (30/windowDays)`.

## Viewmodel — `lib/viewmodels/pricingViewModel.ts` (new)

```ts
export type PricingRow = { itemId: string; result: PricingResult };
export function buildPricingViewModel(input: {
  items: PricingItemInput[];
  business: PricingBusinessInput;
}): PricingRow[];
```
Pure — no Supabase. For each item: resolve `getPricingProfile(item.category)`, build its
`PosHistorySignal`/`BusinessEconomicsInput`/`CategoryPeerStats` (peer stats from grouping `items` by
category inline here), call `suggestPrice()`.

## `lib/pricing/profiles.ts` (new — where defaults actually live)

```ts
const COFFEE_SHOP_DEFAULT: Omit<PricingProfile, "category"> = {
  businessType: "COFFEE_SHOP",
  targetProductCostPercent: 0.30,
  minimumProductCostPercent: 0.25,
  maximumProductCostPercent: 0.35,
  minimumPriceChangePercent: 0.05,
  minimumPriceChangeAmountCents: 25,
  reviewWindowDays: 90,
  roundingRule: { incrementCents: 25, mode: "nearest" },
  targetOperatingMargin: 0.15,
  businessAdjustmentCap: 1.15,
};
// All 8 categories share this today. A category needing different numbers later gets its own
// entry here — lib/calc/pricingEngine.ts never branches on category, only on whatever
// PricingProfile getPricingProfile() returns.
const OVERRIDES: Partial<Record<PricingCategory, Partial<PricingProfile>>> = {};
export function getPricingProfile(category: PricingCategory): PricingProfile { ... }

export const MIN_COVERAGE_RATIO = 0.5;
export const MIN_ORDERS_IN_WINDOW = 200;
export const MIN_ITEM_UNITS_SOLD = 20;
export const MIN_CATEGORY_PEERS = 3;
export const CATEGORY_PRICE_OUTLIER_RATIO = 0.5;
export const CATEGORY_COST_PCT_OUTLIER_PP = 0.15;
```
Lives outside `lib/calc` (sibling to `lib/data`/`lib/actions`/`lib/viewmodels`) because it's
configuration data, not a pure function — keeps the engine's own unit tests exercising profiles as
an injected input, and means a future `businessType` (e.g. `BAKERY`) only touches this one file.

## `menu_items.category` — widening + migration

`lib/constants.ts` addition (not inside any `"use server"` action file — same reason `NEW_EMPLOYEE`
lives there: a `"use server"` file may only export async functions):
```ts
export const MENU_ITEM_CATEGORY_CODES = [
  "ESPRESSO_DRINK", "BREWED_COFFEE", "COLD_BREW", "TEA",
  "SPECIALTY_DRINK", "PASTRY", "FOOD", "RETAIL",
] as const;
export type MenuItemCategoryCode = (typeof MENU_ITEM_CATEGORY_CODES)[number];
```
`lib/actions/menuItems.ts`'s `MenuItemSchema.category`: `z.enum(["drink","food"])` →
`z.enum(MENU_ITEM_CATEGORY_CODES)`. This is the only write path for `menu_items.category` — confirmed
`addMenuItem` is the sole writer. No DB migration needed to widen the column itself (already plain
unconstrained `text`), but existing rows need a **one-time data remap**: `supabase/migrations/<ts>_
remap_menu_item_categories.sql` — `UPDATE menu_items SET category = 'ESPRESSO_DRINK' WHERE category =
'drink'; UPDATE menu_items SET category = 'FOOD' WHERE category = 'food';` (generic "drink" maps to
ESPRESSO_DRINK as the most representative default for a coffee shop's primary drink category, not
SPECIALTY_DRINK). Run via the existing `scripts/db-migrate.mjs` applier (idempotent, safe against
live data per its own established pattern this session).

`getMenuItemsForEdit.ts` and `getPricingInputs.ts` both get their `category` field type widened to
`MenuItemCategoryCode` — neither should coerce unknown values the way `snapshot.server.ts` does for
its own, deliberately untouched purpose.

## UI — `components/menu/ManageMenuPanel.tsx`

**Category picker**: replace the 2-button `"drink"/"food"` toggle with a `<select>` over the 8
`MenuItemCategoryCode` values (same `<select>` pattern already used elsewhere in this file for the
ingredient-unit picker). New label keys: `categoryEspressoDrink`, `categoryBrewedCoffee`,
`categoryColdBrew`, `categoryTea`, `categorySpecialtyDrink`, `categoryPastry`, `categoryFood`,
`categoryRetail`.

**Suggested-price block** (currently ~line 378-384, gated on `item.ingredientsCostCents > 0`):
replace with the full `PricingResult` for that item (passed down via `pricingViewModel`, not computed
client-side). Using the `HealthBand`/`BAND_COLOR` idiom from `ProfitCostsView.tsx`:
- A status pill: `KEEP_CURRENT_PRICE` → good ("Your price looks right"), `REVIEW_PRICE` → warn
  ("Worth reviewing"), `NEW_PRICE` → good ("Suggested price").
- The headline number is always `recommendedPriceCents` (post-stability) via `formatCents` — never
  `calculatedSuggestedPriceCents` directly, so the UI never nudges toward "fixing" a price that's
  already within tolerance.
- A confidence caption resolved from `explanationCode` via next-intl — internal enum values
  (`BENCHMARK`, `HIGH`, etc.) never render as owner-facing text, only the mapped plain-language copy:
  - `pricingExplainerBenchmark`: "Based on your recipe cost and coffee-shop pricing assumptions. More operating history will improve this recommendation."
  - `pricingExplainerBusinessAdjusted`: "Based on your recipe cost plus your café's recent sales and operating economics."
- Warnings render only when present, each its own translated key, plain language (e.g.
  `pricingWarningCategoryOutlier`: "This price is noticeably different from similar drinks — worth a
  second look."), never raw jargon like "operating margin" or "businessAdjustmentFactor".
- No "apply suggestion" button — purely informational, exactly matching "suggestions never
  auto-change menu prices." The owner still types her own price into the existing Price field.

`app/[locale]/menu/manage/page.tsx`: fetch `getPricingInputs` + `buildPricingViewModel` alongside the
existing `getMenuItemsForEdit()` call, pass the per-item `PricingResult` map to `ManageMenuPanel`
keyed by item id, extend `labels` with the new category/pricing copy keys.

## Testing (Vitest, mirrors the existing `lib/calc/*.test.ts` style — pure inputs, no mocking)

- `pricingBaseline.test.ts`: basic ratio math; zero/negative guards.
- `pricingMode.test.ts`: coverage below floor → BENCHMARK even with high order count; orders below
  floor → BENCHMARK even with full coverage; zero revenue → BENCHMARK; both floors met → BUSINESS_ADJUSTED.
- `pricingBusiness.test.ts`: `operatingMargin` is 0 (not NaN) when revenue is 0; shortfall ≤ 0 →
  factor 1.00; shortfall > 0 → `requiredRevenue/monthlyRevenue` exactly; **a fixture where the raw
  factor would be 1.40 must come back as exactly 1.15 with `cappedForReview: true`** — this is the
  single most important test in the whole suite given the spec's explicit "don't blindly apply"
  requirement.
- `pricingRounding.test.ts`: nearest-25¢ tie-break (document round-half-up explicitly); `"up"` mode
  reproduces the deleted `recommendedPriceCents`'s exact behavior on its own old fixture ($1.60 →
  $5.50) as a regression check that no behavior was silently lost; `"down"` mode; a non-25¢ increment.
- `pricingCategorySanity.test.ts`: `peers = null` → `[]`; within thresholds → `[]`; price >50% off
  median → `CATEGORY_PRICE_OUTLIER`; cost% >15pp off → `CATEGORY_COST_PERCENT_OUTLIER`; both at once
  → both codes present.
- `pricingStability.test.ts`: below both thresholds → `KEEP_CURRENT_PRICE`; above → `REVIEW_PRICE`;
  `currentPriceCents = 0` → `NEW_PRICE`; a high-priced item where percent-based threshold dominates
  and a low-priced item where the flat-amount threshold dominates — proves `Math.max(...)` is used,
  not just one.
- `pricingConfidence.test.ts`: BENCHMARK → always MEDIUM; BUSINESS_ADJUSTED with all flags good →
  HIGH; one flag bad → MEDIUM; two+ flags bad → LOW.
- `pricingEngine.test.ts` (end-to-end composition, add a `__fixtures__/pricingFixtureA.ts` mirroring
  the existing `fixtureA.ts` pattern): (a) brand-new café, no POS history → BENCHMARK, confidence
  MEDIUM; (b) established café, healthy economics → factor 1.00, HIGH confidence; (c) established
  café needing a lift within the cap → factor between 1.00–1.15, REVIEW_PRICE; (d) needing more than
  the cap → factor pinned at 1.15, `BUSINESS_ADJUSTMENT_CAPPED` warning present; (e) suggestion close
  to current price → `KEEP_CURRENT_PRICE` regardless of mode.

## Verification (same discipline this project has used all session)

1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run build` — all clean, including every
   new test file above.
2. Run the category-remap migration via `scripts/db-migrate.mjs` against the real Supabase project
   (idempotent, safe against live client data per its established pattern).
3. Live-verify on the `mail2raj27` test account, **not** any real client's account — use the
   session-injection technique already established this session: admin API `generate_link` (type
   magiclink) → `/auth/v1/verify` (token_hash) → real access/refresh tokens → inject via the app's
   own `createBrowserClient` from `@supabase/ssr` (not plain `supabase-js`'s `createClient` — that
   mismatch caused a real near-miss earlier this session where a different client's live account
   was briefly viewed by mistake; always confirm the signed-in email/business name on the page
   before making any change).
4. Concretely: add/confirm a recipe + current price on an existing test item, verify BENCHMARK mode
   shows with MEDIUM confidence and a sensible rounded price; if feasible, seed enough synthetic
   `daily_rollups`/`order_lines` test data to cross the BUSINESS_ADJUSTED thresholds and confirm the
   mode switches automatically with no owner toggle; verify the capped-factor warning fires on a
   deliberately extreme synthetic shortfall; verify `KEEP_CURRENT_PRICE` when a price is already
   close to the suggestion. Remove all synthetic test data afterward.
5. Log the change in `PROGRESS.md` (session log + "Decisions made" style entry, matching the format
   already used throughout this file) before considering the task done.
