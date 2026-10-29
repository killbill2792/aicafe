Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Now
- [ ] Set `OPENAI_API_KEY` in production before deploying #216 (receipts and statements now always use OpenAI).
- [ ] Owner: apply migration 122 (RLS on `businesses`, merged in #220) to production: `alter table public.businesses enable row level security;`
- [ ] Tests: `*.test.tsx` files never run (vitest includes only `*.test.ts`); 6 of their tests fail today. Include them and fix the failures.

## Next — the AI reads all POS data (AGENTS.md 4b)
- [x] 4a. Daily capture of every Toast endpoint (#218). Owner: run it once by hand, then set the repository variable `TOAST_DAILY_CAPTURE_ENABLED=true`.
- [ ] 4b. Point the canonical views (#212) at that store, so cash, stock, kitchen and dining options are fresh; add views for the remaining endpoints.
- [ ] 4c. Merge `describe_data` / `query_data` (#212) with a dictionary entry for every source; screens move to the same readers.
- [ ] 4d. "Today so far" live layer: provisional, replaced at closeout.
  - [x] Chat reads today's Toast sales live when asked (`get_today_so_far`, read-only, not stored, 3-minute cache). The old poll (`lib/pos/toast/poll.ts`) was never switched on: it needs four flags and an outside scheduler, and it writes to a staging table the chat does not read.
  - [ ] Add payments, time entries, stock and cash to the live read; a scheduled refresh every 10–15 minutes while open (for the proactive monitor), reusing `isCafeCurrentlyOpen`.

## Next — the operator loop (AGENTS.md 4–5)
- [ ] One experiment system: keep the Supervisor loop (propose → approve → monitor → report already works); fold in or delete owner initiatives.
- [x] Operating Board: "Running" (waiting on your POS change, or day X of Y) and "Recent reports" on `ChatStart`, from the Supervisor loop tables. Mid-run early read comes with the mid-run updates item.
- [ ] Inbox + notifications: every proactive finding, experiment update and report becomes an `operating_tasks` item plus a chat message, with an unread badge on the board.
- [ ] Proactive monitor: daily findings plus live checks every ~30 minutes while open; duplicate suppression and daily cap.
- [ ] Mid-run experiment updates (not only the final report).

## Later
- [ ] Email delivery of inbox items.
- [ ] Currency: remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts` (`formatCents` callers, BillsManager, etc.).
- [ ] Merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts` into `lib/metrics/core`, with parity tests.
- [ ] Rolling conversation summary; tool-result size cap enforced in code.
- [ ] Add `npm run smoke:agent` (live owner smoke test run by the owner before release).
- [ ] Browser push, Toast webhooks, "always allow" per action type, WhatsApp/SMS sending once a verified business sender exists.

## Done (last 10)
- PR #221: chat cost answer matches the Money screen; 10 golden owner questions.
- PR #220: row level security on `businesses` and a CI check for every table.
- PR #219: fonts self-hosted (no build-time Google Fonts download).
- PR #218: daily capture of every Toast endpoint for the last three closed days.
- PR #217: AGENTS.md rewritten around the AI café operator direction.
- PR #216: cleanup — model text passthrough, café currency in price proposals, short-history estimates, retired code removed.
- PR #215: model-driven milk tool, fact-card resume, scoped costs and localization.
- PR #214: owner fact cards, saved new-thread answers and milk-swap adapter.
- PR #211: shared café math, partial results and read-only refresh.
- PR #213: stored Toast facts and schedules exposed in chat.
