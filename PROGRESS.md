# Progress

State file so any agent (Claude Code, Codex, Kimi) can pick up where the last one stopped.
Read `CLAUDE.md` (or `AGENTS.md`) first, then this file, then only the `docs/` files the next task needs.

## Milestones

- [x] **M0. Skeleton** — Next.js + TS + Tailwind + Supabase + next-intl (en/es/ar, RTL) + PWA manifest, design tokens, fonts, bottom tab bar (5 tabs, empty screens), CLAUDE.md commands work.
- [x] **M1. Database + demo seed** — Supabase migrations for `04-data-model.md`, RLS on, demo café seed (realistic 90-day dataset), magic-link login. **Not yet verified against a live Supabase project — see "Needs connecting".**
- [x] **M2. Calculations** — `lib/calc/` implementing every formula in `05-calculations.md`; Fixture A/B pass as Vitest tests.
- [x] **M3. Core screens on demo data** — Home, Money (cost recovery + profit & costs), Menu, Break-even, built from mockups.
- [ ] **M4. Cost capture** — Monthly bills, manual/voice entry, bank statement upload (CSV/PDF), receipt photos, vendor rule learning, dedupe.
- [ ] **M5. Square connection** — OAuth (sandbox first), backfill, webhooks + poll, rollups, onboarding wizard.
- [ ] **M6. CSV import for Toast/other POS** — Column mapper, saved mappings.
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
- **200%-text-zoom bugs are real bugs, found by testing, not by inspection.** Several cards (Home's 3 sales tiles, the Profit & costs teaser's 2-column legend, the cost-recovery hero number, bucket rows, the login language pills) used fixed-width flex/grid layouts with unbreakable money strings (`$8,104.32` has no space to wrap at). At 200% root font-size these overflowed the 375px viewport — a real WCAG 1.4.4 failure, not a hypothetical one. Fixed with `flex-wrap` + `min-w-0`/`break-words` on the money-bearing containers; verified overflow is gone screen-by-screen (`document.body.scrollWidth` check) after each fix, not just visually.

## Session log

_(newest first)_

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
