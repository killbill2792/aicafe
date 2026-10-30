# Plan: AI CAFE — app-wide responsiveness on Vercel

Status: owner requested Oct 30, 2026. **Planning only**; none of the performance fixes in this document is complete.
Tracking: `PROGRESS.md` → "Speed — app-wide responsiveness". Plan PR: #275.
Use **one new chat per implementation PR**, following the numbered prompts below. The code in GitHub, not an
earlier chat, is the source of truth. `AGENTS.md` overrides everything in this plan. Do not change it.

## What the owner experiences

- Every tap gives immediate visible feedback. The navigation and selected tab/period change promptly.
- Home becomes usable while secondary data loads; loading indicators never invent sales or profit.
- Home, Money, Menu, Operations, Staff, More/settings and Toast pages show the same correct data as chat.
- Period switches, thread navigation and Back/Forward work on a real café (not just fixtures).
- Phone and desktop browsers in English, Spanish and Arabic work, including slow or interrupted networks.
- Live and provisional data are clearly labeled; no stale financial values presented as current.

**Provisional performance targets, not promises:** input feedback ≤ 100 ms; p75 warm navigation usable
≤ 400 ms and p95 ≤ 1,000 ms; p75 Home usable ≤ 1,000 ms and p95 ≤ 2,000 ms.
Use a named device/network, a real-size café, a cold and a warm session; publish p50/p75/p95 and sample size.
First uncached requests require network time and cannot honestly be guaranteed to finish in milliseconds.
Do not game the targets by showing a blank screen or calling incomplete money values final.

## Evidence already collected (do not re-request it)

Production Vercel timing logs, Oct 30, 2026 06:24–06:54 UTC, showed these **individual server reader**
durations, not total page or browser latency:

| Reader | Observed duration |
|---|---:|
| Home `getMenuControlCenter` | 1,411–4,720 ms |
| Home `getSnapshot` | 755–2,212 ms |
| Home `getAttentionItems` | mostly 34–106 ms; one 250 ms |
| Money `readAllPosRows.salesSources` | 893–994 ms |
| Home `readOperatingBoard` | 46–91 ms |
| Home `getSupervisorChatReadiness` | usually 109–505 ms; one 2,661 ms spike |

Different reader calls may overlap; **do not add durations** to infer page time. Multiple similar Home
requests were observed but browser request duplication is unproven until PR 1.
Earlier work #244–#247 and the Home attention fix improved one bottleneck, not the entire app.

Code entry points verified at planning time:
- `app/[locale]/page.tsx` calls `getMenuControlCenter({includeSalesEvidence:false})`, but
  `lib/data/getMenuControlCenter.ts` still calls heavy `getPricingInputs`.
- `lib/data/getPricingInputs.ts` reads 90-day orders/daily facts, monthly expenses and menu quantities.
- `lib/data/getSnapshot.ts` already applies React request caching; profile before adding more caches.
- `components/shared/PeriodSwitch.tsx` invokes both `router.replace` and `router.refresh` because a prior
  replace-only attempt left stale totals. Never undo that safeguard without behavioral proof.
- `app/[locale]/money/page.tsx` reads all sales-source orders on Recovery and Profit views, although
  only Profit & costs renders the source breakdown.
- `app/[locale]/operations/page.tsx` runs task sync during page rendering.
- `app/[locale]/menu/page.tsx` fetches full menu economics and then its item photos.
- `app/[locale]/staff/page.tsx` runs `syncStaffRuleAlerts` when the page loads.
- `app/[locale]/layout.tsx` awaits `getActiveCafeName` before returning the shell.
- `components/home/ComingUpCard.tsx` already starts a separate request after Home loads; **Claude owns
  events search and the future events UI. Do not modify these files in performance PRs.**

## Non-negotiable rules for every implementation chat

1. Read all of `AGENTS.md` first, then the latest `PROGRESS.md` and this plan; read the relevant
   `node_modules/next/dist/docs/` guides before writing Next.js 16 framework code.
2. **Start from the latest `main`, not PR #275's branch or another unmerged implementation branch.**
   Check the prerequisites below and any active PRs touching the same files. If the plan has not merged
   into `main`, the owner can explicitly provide the GitHub link to this document.
3. **One PR, one concern.** Do exactly the named numbered item; keep it small (ideally < 400 changed lines).
   Mark only that item's `PROGRESS.md` checkbox as done **in the same implementation PR**, once done and
   verified. Do not tick unrelated issues, or tick an issue for merely measuring it.
4. No new reader for an existing fact. Financial chat/screens use the same RLS-scoped `lib/data/` reader
   and the same `lib/metrics/core/` calculations; use exact equality/parity tests for touched numbers.
   No private cross-café caching, new fee percentages, hard-coded currency, invented values, or stale
   money masquerading as live. Live sales only through `lib/data/todayLive.server.ts`; daily totals only
   through `lib/data/dailyFacts.server.ts`.
5. No production migration, deploy or merge without explicit owner approval; no Toast/POS write-back,
   new Toast import/reconciliation path, or touching `lib/pos/toast/*` or cron routes unless a task
   explicitly names and approves it.
6. Test behavior, not source text. Never weaken, skip or delete existing tests. Name every modified test
   and why, and preserve EN/ES/AR, screen/chat equality, error handling and real-café period semantics.
7. Before asking for review, run `npx tsc --noEmit -p .`, `npx eslint app lib components`,
   `npx vitest run`, `npx next build` (as well as AGENTS.md's equivalent commands). Provide actual
   pass/fail output or a green CI link; **do not claim tests ran when execution was unavailable**.
8. PR description: owner-visible improvement; before/after measurement (or reason not measurable yet);
   exactly changed files; tests and their changes; remaining risks; active PR collision check.
   Don't merge; open PR for independent review.

## Ownership and dependency map

- **Claude's events work:** PR #274 is a docs-only plan; its future PR 1–9 can modify
  `lib/events/*`, `components/home/ComingUpCard.tsx`, event API routes, chat events tools, and a future
  Home events strip/panel. Performance agents **must not touch these**. In particular, coordinate any
  edits to `app/[locale]/page.tsx`, `components/home/ChatStart.tsx`, `messages/*.json` and
  `PROGRESS.md` when Claude's Home UI PR begins. Rebase on the merged PR before editing shared files.
- **Shared performance hot spots:** PR 2 and PR 8 both use `getMenuControlCenter`; **never run these
  simultaneously on separate branches**. PRs 3 and 5 may share Home/shell code; serialize them.
  PRs 1 and 6 can usually run alongside Claude's search work; PRs 9–11 can proceed after baseline
  measurement if their actual files do not overlap other open PRs.
- **Required sequence:** merge this plan after owner approval; PR 1 measurement; PR 2 → PR 8;
  PR 3 → PR 5; PR 4 after PR 1; PRs 6, 7, 9, 10, 11 after PR 1 when their hotspot is measured.
  PR 12 and PR 13 follow measured fixes. The first implementer to modify a shared file owns it until
  their PR is merged or closed. Never stack unmerged PR branches.
- **Parallel work:** Independent reader/UI fixes may run in separate chats after PR 1 with the exact
  file ownership checked each time. **One chat = one PR, not one chat per combined wave.**
- The existing separate `PROGRESS.md` issue about the chat clearing text during long continuations is
  its **own** issue and should be handled in its own chat; do not mix it with a Home performance PR.

## PR 1 — Measure click-to-usable speed across the app (required first)

**Scope:** Instrument privacy-safe browser click/navigation latency (feedback, route pending, usable
content), warm/cold server request timings and repeated RSC requests. Reuse existing `timeReader` logs;
do not add a second analytics backend or duplicate business readers. Cover Home, Money (both views),
Menu, Operations, Staff, More/settings, Toast and chat start. Measure p50/p75/p95, route, device class,
request count, and cold/warm condition, not customer content. Verify instrumentation doesn't cause
extra fetches or hurt speed; a tiny sampling strategy is preferable to noisy per-click logging.
Inspect `components/TabBar.tsx`, `components/SideNav.tsx`, `components/shared/PeriodSwitch.tsx` and
existing Vercel logs. This PR **instruments only**, no optimizations.

**Check:** reproduce at least one slow tap with correlated client/server timings and document a safe
before baseline. No owner identifiers, URL query values, prompt text or addresses in telemetry.

> **Paste into a new chat (PR 1):** Repo killbill2792/aicafe. Read AGENTS.md first, then PROGRESS.md
> and docs/plans/app-wide-performance.md. Do performance PR 1 only: privacy-safe browser/route timing
> and correlated existing server reader measurements, without changing calculations or navigation
> behavior. Use latest main; read Next.js 16 installed docs; check active PR conflicts, especially
> Claude's events work. Add real behavioral tests, run all AGENTS.md and PROGRESS.md checks, tick only
> PR 1 in PROGRESS.md, open a small PR, report measured baseline, and do not merge or deploy.

## PR 2 — Remove Home's unnecessary pricing work from its critical path

**Scope:** Profile sub-stages of `getMenuControlCenter` / `getPricingInputs`; Home currently disables
the extra order-lines scan but still triggers expensive 90-day economics. Refactor **inside existing
canonical readers** only; use a caller-appropriate projection only if it preserves the exact fields
needed by shared attention/operations code. Do not suppress needed price evidence or create a new
chat-only/menu-only pricing path. Don't change `components/home/ComingUpCard.tsx` or events.
**Check:** Home menu-reader p95 improves; exact prices, missing-data labels and attention list match
the current behavior for identical café data; Menu/chat figures remain exactly equal.

> **Paste into a new chat (PR 2):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md from the latest main. Do PR 2 only: profile and optimize Home's
> shared getMenuControlCenter/getPricingInputs critical path, keeping exactly one canonical reader and
> identical amounts/attention items. Do not modify Claude's event files or unrelated menu UI. Do not
> start while the Menu PR is editing this reader. Add parity and timing evidence, run all required
> checks, tick only PR 2, open a small PR, and do not merge/deploy.

## PR 3 — Canonical snapshot and auth/café identity latency

**Scope:** Break down `getSnapshot` and `snapshot.server` reads; identify actual sequential RLS,
business identity, daily facts, expenses and fees round trips. Cache only safely for a request/user,
not across cafés or longer than the correctness contract. Reuse shared café settings reader if the
related one-path issue is already merged; coordinate rather than create another. No money formula
changes, Toast importer changes or migrations.
**Check:** lower warm snapshot p95 with exact equality on all periods and the Supervisor's numbers.

> **Paste into a new chat (PR 3):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. On latest main do PR 3 only: measure and optimize canonical
> getSnapshot and authenticated café identity reads, preserving RLS, live freshness, partial-day
> coverage and identical money values. Check for other PRs touching shared settings or the Home page;
> no cross-request café data cache. Run required checks, tick only PR 3, open PR, don't merge/deploy.

## PR 4 — Period switch and tab/button navigation

**Scope:** In `components/shared/PeriodSwitch.tsx`, verify whether `router.replace` plus
`router.refresh` makes duplicate server work and whether removing one causes stale amounts.
Preserve selected period, thread/query state, Back/Forward and expected server fetch semantics.
Give instant pending feedback and prevent repeated taps; prefer correct one-navigation behavior over
an unverified refresh shortcut. Also verify shared navigation components where directly relevant.
**Check:** real and demo cafés; one intended navigation per tap; period URL and sales/costs/kept all
change correctly; no stale numbers or thread reset.

> **Paste into a new chat (PR 4):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 4 only: instrument/fix the Today/Week/Month and
> navigation tap experience. Preserve the existing reason for router.refresh until a behavioral test
> proves a safe alternative. Include real-café/fixture period parity, thread preservation and
> Back/Forward tests. Don't touch Claude events, money calculations or unrelated screens. Run all
> checks, tick only PR 4, open PR, no merge/deploy.

## PR 5 — Home shell, first usable render and honest progressive loading

**Scope:** After PR 3, profile `app/[locale]/layout.tsx` and `app/[locale]/page.tsx` dependencies,
including `getActiveCafeName`, chat readiness and the attention/board/live chain. Use only supported
Next.js 16 streaming/Suspense and existing readers to make the shell and chat usable while secondary
content loads. Avoid turning loading placeholders into false final financial numbers. Preserve all chat
thread state, authenticated access checks, EN/ES/AR, keyboard accessibility and real date/period.
**Do not** modify Claude's events card or the event strip. Coordinate Home file ownership first.
**Check:** first usable content, auth behavior, real/fixture amounts and failure-state behavior.

> **Paste into a new chat (PR 5):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. First verify PR 3 is merged and no Claude PR currently edits
> Home shared components. Do PR 5 only: make the authenticated Home shell and chat usable promptly
> with honest progressive rendering; use the same canonical readers and Next.js 16 installed docs.
> Do not edit events UI or change calculations. Add UI/auth/freshness tests, record before/after
> usability, run checks, tick only PR 5, open PR, don't merge/deploy.

## PR 6 — Money: don't load evidence unused by the selected view

**Scope:** `app/[locale]/money/page.tsx` unconditionally performs
`readAllPosRows.salesSources` even when `view==="recovery"`. Keep source evidence where the Profit
view needs it; avoid or defer it only when not consumed. Keep Today provisional and all period/source
labels accurate. No sales-source formula duplication or Toast file edits.
**Check:** Recovery does not issue that full scan; Profit still shows identical source evidence;
exact Money/Home/chat totals match before/after.

> **Paste into a new chat (PR 6):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 6 only: skip Money's unused full-order salesSources
> scan on the Recovery view while retaining the Profit view evidence and identical numbers. Start
> latest main, check active PR collisions, add behavioral tests, measure latency, run all checks,
> tick only PR 6, open PR, and do not merge/deploy.

## PR 7 — Operations initial page: no render-path task sync

**Scope:** `app/[locale]/operations/page.tsx` loads snapshot/menu and calls
`syncAndGetOperatingTasks` during initial render. Profile this page and move the costly sync
out of the page request while keeping the single inbox/task system and ensuring fresh tasks.
Do not change client-side teammate switching or inflate/lose attention counts. If the right
solution requires changing `app/api/cron/*`, explicitly scope that route and obtain any required
owner approval before touching it; never silently create a new job.
**Check:** first load is read-only, Home/Operations needs-you counts and task content agree,
and switching teammates still makes no server request.

> **Paste into a new chat (PR 7):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 7 only: make Operations initial rendering fast and
> read-only while preserving canonical shared attention and existing operating_tasks refresh
> semantics. No second inbox, no POS writes, no cron changes without properly scoped owner
> approval. Test behavior and measure before/after; run checks, tick only PR 7, open PR, no merge.

## PR 8 — Menu: catalog first, expensive evidence/detail later

**Prerequisite:** PR 2 merged; no concurrent PR editing `getMenuControlCenter`.
**Scope:** `app/[locale]/menu/page.tsx` waits for complete pricing/sales evidence and then
`getMenuCatalogPhotos`. Measure backend phases, photo fetching and response payload. Keep a
single menu reader and exact price, recipe, quantity, and evidence parity; defer secondary photos
or evidence only when the catalog and chat semantics remain truthful. No duplicate menu query.
**Check:** faster catalog usable time, no missing items/photos after loading, exact chat/Menu prices,
and valid pending/error states.

> **Paste into a new chat (PR 8):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Verify PR 2 merged; start latest main. Do PR 8 only:
> profile/optimize Menu catalog first-use latency and deferred secondary detail, preserving the
> single shared getMenuControlCenter/menu reader and chat equality. Do not modify Claude events or
> invent new pricing calculations. Test catalog, photos, prices and failure states; run checks,
> tick only PR 8, open PR and don't merge/deploy.

## PR 9 — Staff first load and schedule interactions

**Scope:** Measure `app/[locale]/staff/page.tsx`,
`getWeekSchedule`, `staffReadScope`, `syncStaffRuleAlerts` and week/tab controls.
Fix **the single verified dominant Staff hot spot** in this PR; if it requires a separate rule
sync change or another feature, create a separate follow-up issue rather than widening scope.
Preserve staff permissions, schedule/shift dates, alerts, approved actions and error feedback.
**Check:** before/after Staff p75/p95 and no schedule/action behavior regression.

> **Paste into a new chat (PR 9):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 9 only: measure Staff load/interaction delays and fix
> the worst confirmed hot spot, without changing schedule approvals or altering Toast logic.
> Keep one existing reader per fact; don't modify Claude's events files. Add behavioral tests and
> before/after timings, run checks, tick only PR 9, open PR, no merge/deploy.

## PR 10 — More/settings and café profile responsiveness

**Scope:** Profile `app/[locale]/more/page.tsx`, shared badge inputs, settings/profile pages,
auth/café settings reads, and user-visible action pending/error feedback. Fix **one dominant
confirmed hot spot**. Do not introduce a second café currency/timezone/settings source or change
onboarding defaults as a side effect; coordinate the separate shared café settings issue.
**Check:** More/settings navigation usable promptly; badges and settings agree with chat/screens;
access controls and locale switching remain correct.

> **Paste into a new chat (PR 10):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 10 only: measure More/settings and fix the dominant
> confirmed page-load/click bottleneck, preserving one canonical café settings reader and all
> auth/currency/locale behavior. Do not refactor onboarding or touch Claude events. Add behavioral
> tests, record before/after, run checks, tick only PR 10, open PR, don't merge/deploy.

## PR 11 — Toast screen responsiveness, read-only scope

**Scope:** Measure navigation and UI feedback on the existing Toast connection/diagnostics screens.
Improve unnecessary page-layer waits or UI pending states only. Never touch `lib/pos/toast/*`,
fee reconciliation, raw capture, payments, imports, cron, migrations, POS write behavior or trust rules.
If a slow POS operation itself is the bottleneck, **report it as separately scoped** rather than
optimizing the importer here.
**Check:** fast interface feedback; each owner-requested operation still shows the truthful result.

> **Paste into a new chat (PR 11):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 11 only: profile Toast connection/diagnostics page
> navigation and improve page-level responsiveness without touching POS/import/reconciliation
> internals, money sources, migrations or cron. Add UI tests, measure results, run all checks,
> tick only PR 11, open PR, don't merge or deploy.

## PR 12 — Vercel/Supabase production latency and safe caching

**Prerequisite:** measured browser/server bottlenecks after PRs 1–11, not a speculative settings change.
**Scope:** Verify function/server region vs Supabase region, cold vs warm starts, overfetch and serialized
database round trips, asset/prefetch and deployment behavior. Propose a single justified configuration
or query-shape optimization. Read-only audit first; **do not change production project settings or
deploy without owner approval**. Do not cross-cache private café data or introduce another reader.
**Check:** documented old/new p75/p95 under the same conditions, known cache invalidation and RLS safety.

> **Paste into a new chat (PR 12):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 12 only: inspect measured Vercel/Supabase production
> latency, region/cold starts and safe caching. Propose or implement only one justified, owner-approved
> in-scope performance change. Do not change production settings, deploy, migrate or access secrets
> without explicit permission. Record evidence, tests and checks, tick only when verified, open PR
> if code changes, no merge/deploy.

## PR 13 — Performance regression guardrails across the complete app

**Prerequisite:** PR 1 measurements and at least the P0 Home/navigation fixes.
**Scope:** Add repeatable phone/desktop browser performance smoke checks (Home, periods, Money, Menu,
Operations, Staff, More, Toast, chat start), with real-sized synthetic data and clear baselines.
Check happy, slow network and failure states, and EN/ES/AR where UI changes matter. Use available
test infrastructure; explain any new dependency before introducing it. Monitor latency without
logging business identifiers or private data. Fail regressions on **measured useful readiness**,
not on unstable random network milliseconds; make thresholds environment-specific.
**Check:** reproducible test command, test results and baseline visible on the PR/CI.

> **Paste into a new chat (PR 13):** Repo killbill2792/aicafe. Read AGENTS.md, PROGRESS.md and
> docs/plans/app-wide-performance.md. Do PR 13 only: add repeatable privacy-safe browser
> performance regression checks for the main app routes using existing test infrastructure.
> Verify P0 performance changes have merged, preserve EN/ES/AR and screen/chat parity, avoid flaky
> arbitrary CI thresholds. Run all checks, tick only PR 13, open PR and don't merge/deploy.

## Another independent chat: preserve partial Supervisor chat responses

This is **already an unchecked issue in `PROGRESS.md`**, not a second new checkbox in this plan.
It is separate from the latency PRs. Its owner journey: a long-running answer must never blank
or restart visually when server continuation or a dropped stream hands over to a watcher.

> **Paste into a new chat (existing issue):** Repo killbill2792/aicafe. Read AGENTS.md first,
> then PROGRESS.md and docs/plans/app-wide-performance.md. Fix only the existing
> "Supervisor chat reloads mid-answer" issue in PROGRESS.md. Keep previously streamed text visible
> across continuation/stream recovery, preserve genuine tool/event ordering, and show honest progress.
> Do not rewrite model text, modify Claude events or change the agent architecture. Add recorded-fixture
> tests for a >75-second continuation and stream drop, run every required check, tick that existing
> issue in PROGRESS.md, open a small PR and do not merge/deploy.

## Definition of finished

A checkbox means **implemented, measured, tested, reviewed and merged (or confirmed as not needed
with evidence and the owner's agreement)**, not merely opened as a PR. A merged fix that performs
worse on the same scenario reopens the issue. After each implementation, update the next chat's
assumptions from the latest `main` and `PROGRESS.md`; never carry a stale SHA or file list forward.
