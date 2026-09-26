# Café Profit — agent instructions

Read this file fully before any task. Then read only the docs file(s) the task needs.

## What we are building
A mobile-first web app (PWA) that tells independent café owners **how much money they actually kept, and why**.
Square/Toast already show sales, voids and labor reports. We show the full owner picture: POS data **plus** rent, bills,
supplies and payroll taxes → true owner profit, cost recovery, true cost per drink, break-even.

Pitch: "Square tells you what you sold. We tell you what you actually kept."

## Users (design for all of them at once)
Owners aged 30–70, many not tech-comfortable, some more comfortable in Arabic or Spanish than English.
Gen Z shift managers also use it. Rules: big numbers, icon + word on everything, plain language, no jargon.
See `docs/02-design-system.md` — it is binding.

## Stack (do not swap without asking)
- Next.js (App Router) + TypeScript (strict) + Tailwind CSS
- Supabase: Postgres, Auth (email magic link + phone OTP), Storage (receipts, statements), Row Level Security on every table
- Hosting: Vercel. Installable PWA (manifest + service worker, "Add to Home Screen")
- i18n: next-intl with `en`, `ar` (RTL), `es`. All user-facing strings in message files, never hard-coded
- Validation: zod. Dates: date-fns + date-fns-tz. Business timezone per location (default America/Los_Angeles)
- Tests: Vitest for all money math in `lib/calc/`
- AI (statement categorizing, receipt reading, voice entry): provider-agnostic wrapper in `lib/ai/` selected by env var
  `AI_PROVIDER` = anthropic | openai | moonshot. Always use a small/cheap model and structured JSON output

## Non-negotiable rules
1. **Money is integer cents** everywhere (`bigint`/`number` of cents). Never floats for money. Format only at display.
2. Every expense row has `source` and `status` (`estimated` | `actual`). The UI must label estimates.
3. All calculations live in `lib/calc/` as pure functions with tests. UI never does math.
4. Use the fixtures in `docs/05-calculations.md` as test cases. If a test disagrees with the doc, stop and ask.
5. POS access is **read-only**. Never ask for bank or POS passwords. OAuth or user-downloaded files only.
6. Encrypt POS tokens at rest. Never log tokens, bank lines, or receipt images.
7. Accessibility: WCAG AA contrast, 48px touch targets, 17px minimum body text, visible focus, reduced motion respected.
8. Never add features from the "Don't build" list in `docs/01-product.md`.

## Where things are
- `docs/01-product.md` — features, priorities, what not to build
- `docs/02-design-system.md` — visual rules, icons, colors, copy, accessibility, languages
- `docs/03-screens.md` — every screen: content, states, data, interactions
- `docs/04-data-model.md` — database schema (SQL) + RLS
- `docs/05-calculations.md` — every formula, the cost-recovery algorithm, test fixtures
- `docs/06-integrations.md` — Square, Toast/CSV, bank statements, receipts, AI prompts
- `docs/07-build-plan.md` — milestones with acceptance criteria, multi-tool workflow
- `design/mockups/*.html` — approved visual references. Open in a browser. Rebuild them as React components;
  do not copy inline styles verbatim — extract into Tailwind tokens from the design system.

## Working style (saves tokens, keeps quality)
- One milestone task per session. Read only the docs it needs.
- Before coding a milestone: write a short plan in `PROGRESS.md`, then implement, then run tests, then tick it off.
- Keep `PROGRESS.md` updated so any agent (Claude Code, Codex, Kimi) can continue where the last one stopped.
- Prefer small files. No new dependencies without a one-line reason in `PROGRESS.md`.

## Commands (create these in milestone 0)
- `npm run dev` · `npm run build` · `npm run test` · `npm run lint` · `npm run db:reset` (reset + seed demo café)
