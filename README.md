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

## How to demo this to a café owner

The app ships with a built-in "Demo café" — a realistic 90-day dataset (weekday/weekend patterns,
a milk price increase, a couple of voided orders, a missed meal break, 6 staff, 12 drinks) — so you
can run a full demo **before connecting any real credentials**. Every owner-facing screen works
against it out of the box.

### 1. Get it running
```bash
npm install
npm run dev
```
Open `http://localhost:3000` on your phone (same Wi-Fi) or in a browser sized to ~390px wide — this
is a mobile-first app, and it looks best that way. No `.env.local` is required for this walkthrough;
the app automatically falls back to the demo dataset when Supabase isn't configured.

### 2. The 5-minute walkthrough
Sit next to the owner, phone in landscape-off, and walk through in this order — it mirrors how the
product is meant to be understood, from the big number down to the details:

1. **Home** — "This is what you'd see every morning." Point at the owner-profit number and the
   "today in cups" row — every cup sold today is theirs, free and clear, because rent and bills are
   already covered for the month in this demo. Scroll down to Profit & costs, Staff, Menu, and
   Break-even teasers — the whole picture in one scroll, no digging.
2. **Money → Paying back bills** (the signature screen — matches `design/mockups/cost-recovery.html`) —
   this is the one to spend the most time on. Explain the metaphor: each cup pays for its own milk,
   cup, card fee, and staff time first; what's left pays down rent, then power, then insurance, in
   the order *they* choose (tap the arrows to reorder live). Once everything's covered, the rest is
   theirs — that's the fill animation.
3. **Menu** — "Here's what each drink actually costs you, not just what it sells for." Point out the
   rent & bills share per drink — this is the number Square/Toast never show them.
4. **More → Break-even plan** — "This is how many drinks a day you need just to open the doors."
   Try a what-if (raise prices 25¢) live — the number visibly drops.
5. **More → Alerts** — if anything's open in the demo (a missing bill, an unusual void pattern, a
   missed meal break), show the calm, non-accusatory tone: "worth a look," never "someone did
   something wrong."
6. Switch language with the pill in the top-right corner (EN / ES / AR) to show it isn't an
   afterthought — the whole app, including the RTL layout for Arabic, is fully translated.

### 3. If they want to connect their own café
From **More → Connect your register**, the onboarding wizard offers Square, Toast, Clover, or "Other
register" (a CSV upload that works with literally any POS export) — every path leads somewhere real,
none of them dead-end. Square is a live OAuth connection (once `SQUARE_APPLICATION_ID`/
`SQUARE_APPLICATION_SECRET` are set — see "Needs connecting" below); the other three work today via
CSV, no waiting on a partner integration.

Their own café and the shared Demo café never mix — **More → (café switcher at the top)** flips
between "My café" and "Demo café" at any time, and it's obvious at a glance which one they're
looking at.

## Deploy to Vercel

No Vercel account is available in this build environment, so here are the exact steps to deploy it
yourself:

1. Push this repo to GitHub (if it isn't already):
```bash
git remote add origin https://github.com/<you>/cafe-profit.git
git push -u origin main
```
2. Go to [vercel.com/new](https://vercel.com/new), sign in, and import the GitHub repo. Vercel
   auto-detects Next.js — leave the build settings as default (`npm run build`).
3. Before the first deploy, add every variable from `.env.local.example` under **Settings →
   Environment Variables** (Production, and Preview if you want PR previews to also work). At
   minimum for the app to do anything beyond the demo data: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. See "Needs connecting" in
   `PROGRESS.md` for the full list and exactly what each one unlocks — the app runs and is fully
   demoable with **zero** of them set, so it's fine to deploy first and add credentials later.
4. For Square, once you have real app credentials, update `SQUARE_REDIRECT_URI` to your production
   URL (`https://<your-app>.vercel.app/api/pos/square/callback`) — both in Vercel's env vars and in
   the Square Developer Dashboard's own redirect URL allowlist, or the OAuth callback will fail.
5. Click Deploy. Every subsequent `git push` to `main` redeploys automatically.
6. Run `npm run db:reset` once **locally** (pointed at your production `SUPABASE_DB_URL` via
   `.env.local`) to apply migrations and seed the Demo café — this is a one-time setup step, not
   something Vercel runs for you on every deploy.

## What NOT to demo yet
- The **Staff** tab is a placeholder (planned for v1.5) — don't tap into it.
- Voice entry needs a browser with `SpeechRecognition` support (Chrome/Edge; not Safari/Firefox) —
  test on the device you'll actually demo from beforehand.
- Receipt photo reading and bank statement categorizing need an AI provider key configured
  (`AI_PROVIDER` + one API key in `.env.local.example`) — without one, they still save correctly,
  just uncategorized.
