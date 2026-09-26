# Café Profit — build kit

Everything an AI coding agent needs to build the pilot web app.

## How to use
1. Create an empty folder (or GitHub repo) and copy this whole kit into it.
2. Open it in Claude Code (or Codex / Kimi — they read AGENTS.md, which matches CLAUDE.md).
3. Paste the "First prompt" from `docs/07-build-plan.md`.
4. Work one milestone at a time. When a tool hits its usage limit, commit and continue in another tool with the same start prompt. `PROGRESS.md` keeps everyone in sync.

## What's inside
- `CLAUDE.md` / `AGENTS.md` — rules every agent follows
- `docs/01-product.md` — what to build, what not to build
- `docs/02-design-system.md` — the look, icons, the "fill" visual, plain-language words, languages, accessibility
- `docs/03-screens.md` — every screen in detail
- `docs/04-data-model.md` — database (SQL)
- `docs/05-calculations.md` — every formula + test numbers (the source of truth)
- `docs/06-integrations.md` — Square, Toast CSV, bank statements, receipts, voice, AI prompts
- `docs/07-build-plan.md` — milestones, acceptance checks, multi-tool workflow
- `design/mockups/` — open these in a browser. `cost-recovery.html` is the signature screen.

## You'll need
- Supabase project (free tier is fine for the pilot)
- Vercel account
- Square Developer account (sandbox for building, production for the pilot)
- One AI API key for statement/receipt reading (any cheap model)
