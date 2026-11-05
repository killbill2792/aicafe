# Café Operator — agent instructions (single source of truth; CLAUDE.md only points here)

Read this file fully before any task. If any other doc, PROGRESS entry, PR description or code comment
conflicts with it, THIS FILE WINS. Docs marked "historical" or "background" in `docs/README.md` are not
instructions. If a rule here blocks the task you were given, stop and ask the owner. Never work around it.

## What AI Cafe is (read this first)
1. AI Cafe is an AI operator for independent café owners.
2. At its core is Supervisor: one universal agent for the café, in one chat.
3. Supervisor answers anything from all stored café data: POS sales and orders, staff and schedules,
   costs and bills, stock, events, experiments, and the owner's own inputs.
4. Its numbers come from that data and the one `calculate` tool, labelled actual, estimate or incomplete.
5. It acts proactively: it watches the café and tells the owner about problems and chances, with a next step.
6. It finishes tasks end to end: it drafts, the owner says yes, it does the work, monitors it and reports back.
7. Nothing with an effect happens without the owner's yes.
8. The chat and every screen show the same numbers from the same code.
9. Answers are short and plain: café owners are busy and many are not technical.
10. It is a web app first, for phone and desktop browsers; WhatsApp carries the brief and short replies.

## Standing rules from the owner (every agent: Claude, ChatGPT, Codex, Grok and any future agent)
Where an older line in this file conflicts with these rules, these rules win.
1. **Product first.** Read "What AI Cafe is" above before any task, and build toward it.
2. **The owner is the builder.** The owner's product decisions are final. You may push back once, with
   evidence and a better option. Then build what the owner chose. No refusing and no re-arguing.
3. **Architecture first for all infrastructure** (data, APIs, jobs, crons, approvals, tools, connectors).
   Before coding, write down: what the source really sends, field by field; one record per object and
   its key; what happens when it changes; which table it goes to; what is not kept and why; gaps; and
   how the source may differ between cafés. Get the owner's approval, then build.
4. **One path per capability.** Before adding code, find the existing path that already does the job and
   extend it. Never add a second path to get the same data or do the same job. If a new path replaces
   an old one, the PR says so, and the old one is deleted in the same PR or in a named follow-up
   deletion PR.
5. **No hardcoding.** No hardcoded currency (such as USD), café names, IDs, time zones, dates, prices, or
   values that only make a test or scenario pass. Read them from settings or data. Tests check real
   behavior on realistic data, and the PR states how each acceptance test proves it.
6. **English only for now.** Do not add or update Spanish or Arabic strings or translation logic until the
   owner says so (new strings go in `messages/en.json` only). Do not break the existing ones.
7. **Parallel and dependent PRs open now.** Open planned PRs immediately, even when they depend on
   another open PR. Never tell a chat "blocked until X merges" or "start only after X merges" as a
   reason not to open its PR. Independent PRs branch from the latest `main`. If PR B depends on open
   PR A, open B with **base = A's branch (not `main`)**; keep B's code ready and its CI green on that
   base. **B merges only after A is on `main`.** Then rebase B onto (or retarget B to) the latest
   `main`, re-run CI and Codex review, re-check migration numbers, and list any other open PRs that
   touch the same files. Merge only under the auto-merge rule.
8. **Merge readiness.** A PR is mergeable only when CI is green, the Codex review is clean (or every comment
   is fixed and re-reviewed), it is rebased on current main, and the PR body says what changed, what was
   deleted and what was not touched.
9. **No silent data loss.** Every save records success or failure. Failures retry automatically with
   backoff and stay visible in the health check until they are recovered. The owner is never asked to
   fix data.
10. **Screen and chat match.** Supervisor's numbers come from the same shared calculations as the app
    screens (`lib/metrics/core`), never a formula the model invents.
11. **Proactive by default.** Every feature says how Supervisor brings it to the owner without being asked.
12. **The database aggregates.** Supervisor reads small summaries built in the database, not raw rows, to
    keep tokens low.
13. **Proof, not claims.** The PR body matches the diff, and "done" means verified on real café data, not
    only on fixtures.
14. **Read before you build, update after.** Every task starts by reading AGENTS.md and PROGRESS.md.
    PROGRESS.md is updated when the PR merges.
15. **Plan before the PR, with the owner.** Before any PR that adds or changes data, jobs, crons, tools or
    connectors starts coding, present the owner a short plain-words plan: where the data comes from
    (field by field), what is saved, where and under what key, who reads it, what Supervisor says or
    does from it, and the gaps. The owner reviews it and may propose a simpler way. Coding starts only
    after the owner agrees. The PR body then repeats the agreed plan.
16. **Parallel PR waves.** We ship in days with several PR chats at once. Before a wave starts, the plan
    lists each PR, the files and tables it owns, and the shared pieces it uses or adds (connectors,
    settings, views, tools). Shared pieces are built once in a small foundation PR that merges first;
    dependent PRs open now against that foundation branch, reuse its work, and keep their own CI green.
    If two PRs need the same file, assign the overlap to one owner or the foundation PR; do not hold
    the other PR unopened. Open it against the owning PR's branch instead. Independent PRs use latest
    `main`. After each prerequisite merges, update the dependent PR onto latest `main`, switch to
    merged shared pieces, take the next free migration number, and re-run CI and Codex. Only merge when
    its prerequisites are on `main` and all checks are green under the auto-merge rule.
17. **End-to-end testing.** "Done" means every acceptance scenario was tested end to end on the real app
    and real café data (chat answer, screen, stored rows, scheduled job), not only unit tests or a few
    happy paths. The PR lists each scenario with pass or fail. Partial passes are not done. Keep CI fast:
    if a check gets slow or flaky, fix it or split it rather than waiting.
18. **Use an existing skill first.** Before building anything, check for an official Anthropic/OpenAI skill or a repository skill that already does the job; reuse it instead of rebuilding it.

## Code Review Rules
Codex must review the whole PR first, then review only newly changed lines on later rounds. Check:
- **One path per capability:** no duplicate reader, calculator, attention list, inbox, agent loop or experiment system; explicitly name any replacement and deletion.
- **No hardcoded values:** no literal currency, café ID/name, time zone, dates, price, or scenario-only test value in production paths; values come from the actual café's data/settings.
- **Migration naming:** any new migration follows the repository's existing timestamped filename convention, uses the next free number on latest main, and does not collide with other PRs; RLS and compatibility must be checked.
- **PR size:** one concern, ideally under 400 changed lines of behavioral code; call out mechanical documentation moves separately.
- **Owned files:** every changed file must be in this PR's declared scope. Flag unrelated edits and overlaps with parallel PRs.
- Check action approvals, real data/unknowns, money calculations, tests, and security against the detailed rules below. Treat the P1/P2 review process in section 11 as binding.

## Detailed rules (binding)
The linked files below are part of these instructions, not optional background. Read the relevant file before changing that capability. If a detail conflicts with the standing owner rules above, the standing rules win.
- [1–3. Product, approval levels and one system](docs/rules/product-and-autonomy.md)
- [4. Operating Board, inbox and proactive reports](docs/rules/operating-board.md)
- [4b. POS storage and today](docs/rules/pos-data.md)
- [4c. Morning brief](docs/rules/morning-brief.md)
- [5. Experiments](docs/rules/experiments.md)
- [6. AI architecture, conversation state and budget](docs/rules/ai-architecture.md)
- [7. Numbers and money](docs/rules/numbers-and-money.md)
- [8. Safety and privacy](docs/rules/safety-and-privacy.md)
- [9. Regression tests](docs/rules/tests.md)
- [10–12. Work, review and retired paths](docs/rules/workflow-and-review.md)

## Stack (do not swap without asking)
Next.js 16 App Router + TypeScript strict + Tailwind · Supabase (Postgres, Auth, Storage, RLS on every table)
· Vercel (responsive web app / PWA) · next-intl (en, es, ar) · zod · date-fns(-tz) · Vitest
· OpenAI Responses API via `lib/ai/`. Next.js 16 differs from your training data: read
`node_modules/next/dist/docs/` before using framework APIs.

## Where things are
See [docs/README.md](docs/README.md) for current docs and historical designs.

## Commands
`npm run dev` · `npm run build` · `npm test` · `npm run lint` · `npx tsc --noEmit` · `npm run db:reset`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know
Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
