# 07 — Build plan

Milestones are ordered so each one leaves a working app. Any agent can pick up the next unticked milestone from `PROGRESS.md`.

## Milestones and acceptance criteria

**M0. Skeleton**
Next.js + TS + Tailwind + Supabase + next-intl (en/es/ar with RTL) + PWA manifest. Design tokens from `02-design-system.md` in `tailwind.config`. Fonts loaded. Bottom tab bar with 5 tabs and empty screens. Commands from CLAUDE.md work.
✅ Runs locally and on Vercel. Switching to Arabic flips layout to RTL. Lighthouse accessibility ≥ 95 on an empty screen.

**M1. Database + demo seed**
All tables from `04-data-model.md` as Supabase migrations, RLS on. Seed = Fixture A demo café (30 days of identical data, recipes, staff, bills). Magic-link login; seeded demo user is owner of the demo café.
✅ `npm run db:reset` creates a working demo. A second user cannot read the demo café's rows.

**M2. Calculations**
`lib/calc/` with every formula in `05-calculations.md`: owner profit for any period, cost recovery, per-drink costs, break-even + what-ifs, health bands, alert rules.
✅ All Fixture A/B expected values pass as Vitest tests. No UI yet.

**M3. Core screens on demo data**
Home, Money (Cost recovery + Profit & costs), Menu, Break-even. Built from the mockups, with icons and the fill animation.
✅ Every number on screen matches Fixture A. Works at 360px wide and at 200% text size. Arabic view readable.

**M4. Cost capture**
Monthly bills, manual entry, voice entry, bank statement upload (CSV first, then PDF), receipt photos, review screens, vendor rule learning, dedupe.
✅ Upload a real anonymized bank CSV: ≥ 85% of lines categorized correctly without edits; corrections are remembered on the next upload. A receipt photo and its bank line don't double count.

**M5. Square connection**
OAuth (sandbox first), backfill, webhooks + poll, rollups. Onboarding wizard (S2).
✅ With a Square sandbox account containing test orders and timecards, one day's net sales, fees and hours match Square's own reports exactly.

**M6. CSV import for Toast/other POS**
Column mapper and saved mappings.
✅ Import a Toast-style product mix CSV and time entries CSV; screens populate.

**M7. Alerts + milestones**
Missing bill, voids, meal break, early clock-in, overstaffed slot, covered milestone. Shown as supporting cards only.
✅ Each alert shows $ impact and one action. Wording reviewed against the design system tone.

**M8. Pilot hardening**
Error states, loading skeletons, reconnect flow, delete account, privacy page, basic analytics (screen views only), Sentry.
✅ A non-technical person completes onboarding in ≤ 15 minutes without help, on a phone.

v1.5 after the pilot starts: Staff screen live, "Why today was different", weekly text, native-speaker translation review.

## Using several AI tools on one repo
- The repo is the shared brain: `CLAUDE.md` (Claude Code) and `AGENTS.md` (Codex, Kimi and others) hold the same instructions; `docs/` holds the spec; `PROGRESS.md` holds state.
- Every session starts with: "Read CLAUDE.md (or AGENTS.md) and PROGRESS.md. Do the next unticked task in milestone Mx only."
- Every session ends with: tests pass, `PROGRESS.md` updated with what was done and what's next, commit with a clear message.
- Suggested split:
  - **Hard logic** (M2 calculations, M5 Square sync, M4 statement parsing): your strongest coding agent.
  - **Screens from mockups** (M3, M7 UI): any agent; give it the specific mockup file and the screen section from `03-screens.md`.
  - **Tests and review**: a different agent than the one that wrote the code — ask it to review a diff against the docs.
- When one tool hits its usage limit, commit, then continue in another tool with the same start prompt.

## Token-saving rules
- Point the agent at specific files ("read docs/05-calculations.md sections Cost recovery and Fixture A") instead of the whole repo.
- One milestone task per session; clear context between tasks.
- Don't paste mockups into chat; reference the file path.
- Ask for a plan first on big tasks, approve it, then let it implement.

## First prompt to paste into Claude Code
```
Read CLAUDE.md, then docs/01-product.md and docs/07-build-plan.md.
Create PROGRESS.md with all milestones M0–M8 as checklists.
Then do milestone M0 only. Before coding, show me a short plan. After coding, run the app and tests, update PROGRESS.md, and commit.
```
