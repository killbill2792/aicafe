# Progress

State file so any agent (Claude Code, Codex, Kimi) can pick up where the last one stopped.
Read `CLAUDE.md` (or `AGENTS.md`) first, then this file, then only the `docs/` files the next task needs.

## Milestones

- [x] **M0. Skeleton** — Next.js + TS + Tailwind + Supabase + next-intl (en/es/ar, RTL) + PWA manifest, design tokens, fonts, bottom tab bar (5 tabs, empty screens), CLAUDE.md commands work.
- [x] **M1. Database + demo seed** — Supabase migrations for `04-data-model.md`, RLS on, demo café seed (realistic 90-day dataset), magic-link login. **Not yet verified against a live Supabase project — see "Needs connecting".**
- [x] **M2. Calculations** — `lib/calc/` implementing every formula in `05-calculations.md`; Fixture A/B pass as Vitest tests.
- [x] **M3. Core screens on demo data** — Home, Money (cost recovery + profit & costs), Menu, Break-even, built from mockups.
- [x] **M4. Cost capture** — Monthly bills, manual/voice entry, bank statement upload (CSV; PDF not yet — see decisions), receipt photos, vendor rule learning, dedupe.
- [x] **M5. Square connection** — OAuth (sandbox first), backfill, rollups, onboarding wizard. Webhooks/10-min poll not built — see decisions.
- [x] **M6. CSV import for Toast/other POS** — Column mapper, saved mappings.
- [ ] **M7. Alerts + milestones** — Missing bill, voids, meal break, early clock-in, overstaffed slot, covered milestone cards.
- [ ] **M8. Pilot hardening** — Error states, loading skeletons, reconnect flow, delete account, privacy page, screen-view analytics, Sentry.

v1.5 (after pilot starts): Staff screen live, "Why today was different", weekly text, native-speaker translation review.

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

## Needs connecting

_(built behind a mock/sandbox-ready adapter; wire up the real thing when credentials exist — see the credentials list from the start of this session)_

- **Supabase project** — nothing works end-to-end (auth, `db:reset`, every screen) until `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` are in `.env.local`. Until then the app degrades gracefully (`requireUser()` is a no-op, screens render from the Fixture-A-derived snapshot instead of crashing) — verified in-browser, every M3 screen checked against Fixture A's numbers. **`supabase/migrations/*.sql`, `scripts/db-reset.mjs`, and `lib/data/snapshot.server.ts` (the real Supabase query path) have not been run against a real Postgres instance** (no CLI/Docker available in this environment) — re-run `npm run db:reset`, then load Home/Money/Menu/Break-even as the demo user and fix anything that surfaces the first time real credentials are added. Most likely trouble spots: the `order_lines` → `orders` foreign-table filter syntax in `getMenuItemSnapshots`, and RLS on the `recovery_order` write in the reorder server action.
- **AI provider key** (M4) — `AI_PROVIDER` + one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`MOONSHOT_API_KEY`.
- **Square sandbox app** (M5) — `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_REDIRECT_URI`.
- **Vercel** — for the actual deploy at the end of M8.
- **Sentry** (M8, optional for pilot) — `SENTRY_DSN`.

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
- **`orders` has no `provider` column, despite the doc saying CSV imports write `provider = 'csv'`.** `docs/04-data-model.md`'s `orders` table has no such column at all (same category of doc/schema mismatch as the missing `landlord_name` noted in M4). Resolution: CSV-imported orders are identified by their `pos_order_id` prefix (`csv-...`) instead, which already can't collide with a real register's own ids. No schema change made — flag this if a future feature actually needs to branch on "was this order CSV-imported."
- **Webhooks + 10-minute safety poll not built.** `docs/06-integrations.md` wants incremental sync via webhooks plus a poll during open hours. Only the OAuth backfill (inline, 90 days) exists. A cron/queue-driven poll (and a webhook receiver route + signature verification) is real additional infrastructure — deferred until there's a real Square account to test webhook delivery against. Note in the same callback route: the 90-day backfill runs inline inside the OAuth callback request, which risks a serverless route handler's execution time limit against a busy real café's order volume — move it to a background job before pointing this at a real merchant.
- **Onboarding step 4 ("top drinks") doesn't build a recipe confirmation UI.** `docs/03-screens.md` S2 step 4 asks the owner to confirm ingredients-per-drink from a template for their top 10 sellers. Given M3/M4 already deferred the Menu screen's full recipe editor (no per-item recipe-quantity UI exists anywhere yet), step 4 is a single explanatory screen instead — consistent with those earlier decisions, not a new gap. Build the real step once the recipe editor exists.
- **PDF bank statements deferred to a fast-follow.** `docs/06-integrations.md` says CSV first, then PDF; M4's acceptance criteria only requires CSV. Building PDF text extraction (`pdf-parse`) plus a vision fallback for scanned PDFs is real additional scope — not started. The statement upload screen accepts `.csv` only for now.
- **Receipt-line ingredient mapping UI deferred.** `docs/06-integrations.md` describes mapping a receipt line to an ingredient (which writes an `ingredient_prices` row). `saveReceiptExpense` accepts an `ingredientMappings` param and is ready for it, but the review screen doesn't yet offer that mapping step — it saves the receipt and its lines without linking any to `ingredients`. Revisit once the Menu screen's recipe editor exists (same M4 gap noted in M3's decisions) so there's a natural place to do the mapping.
- **Landlord-name keyword rule not wired.** `docs/06-integrations.md` step 5 says the landlord's name (entered in onboarding) should auto-categorize matching statement lines as rent, but `docs/04-data-model.md`'s `businesses` table has no column to store it. `matchKeywordCategory()` accepts an optional `landlordName` and works correctly without one; nothing currently passes one in. Add a `businesses.landlord_name` column (or reuse the `rent` recurring cost's `label`) once onboarding (M5) collects it.
- **200%-text-zoom bugs are real bugs, found by testing, not by inspection.** Several cards (Home's 3 sales tiles, the Profit & costs teaser's 2-column legend, the cost-recovery hero number, bucket rows, the login language pills) used fixed-width flex/grid layouts with unbreakable money strings (`$8,104.32` has no space to wrap at). At 200% root font-size these overflowed the 375px viewport — a real WCAG 1.4.4 failure, not a hypothetical one. Fixed with `flex-wrap` + `min-w-0`/`break-words` on the money-bearing containers; verified overflow is gone screen-by-screen (`document.body.scrollWidth` check) after each fix, not just visually.

## Session log

_(newest first)_

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
