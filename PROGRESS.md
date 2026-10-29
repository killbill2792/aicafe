Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Now
- [ ] Set `OPENAI_API_KEY` in production before deploying #216 (receipts and statements now always use OpenAI).
- [ ] Security: enable RLS on `businesses` (the only table without it) and add a CI check that fails if any `public` table has RLS off. Verify production first: `select relrowsecurity from pg_class where relname='businesses';`
- [ ] Golden owner questions: ~10 fixed fixture questions with exact expected numbers on both chat and screen paths; replace the `>= 0` cost check in `metricsParity.test.ts` with exact equality.

## Next — the AI reads all POS data (AGENTS.md 4b)
- [ ] 4a. Capture every Toast endpoint daily: the #210 sampler runs on a schedule per café for the last three closed days that are not complete (`toast-raw-capture-daily.yml`, into `toast_raw_samples`). Owner turns on scheduled runs with the repository variable `TOAST_DAILY_CAPTURE_ENABLED=true`.
- [ ] 4b. Point the canonical views (#212) at that store, so cash, stock, kitchen and dining options are fresh; add views for the remaining endpoints.
- [ ] 4c. Merge `describe_data` / `query_data` (#212) with a dictionary entry for every source; screens move to the same readers.
- [ ] 4d. "Today so far" live layer: provisional, replaced at closeout.
  - [x] Chat reads today's Toast sales live when asked (`get_today_so_far`, read-only, not stored, 3-minute cache). The old poll (`lib/pos/toast/poll.ts`) was never switched on: it needs four flags and an outside scheduler, and it writes to a staging table the chat does not read.
  - [ ] Add payments, time entries, stock and cash to the live read; a scheduled refresh every 10–15 minutes while open (for the proactive monitor), reusing `isCafeCurrentlyOpen`.

## Next — the operator loop (AGENTS.md 4–5)
- [ ] One experiment system: keep the Supervisor loop (propose → approve → monitor → report already works); fold in or delete owner initiatives.
- [ ] Operating Board: add "Running" (active experiments/monitors, day X of Y, early read) and "Recent reports" to `ChatStart`, reading the same data as the chat tools.
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
- PR #217: AGENTS.md rewritten around the AI café operator direction.
- PR #216: cleanup — model text passthrough, café currency in price proposals, short-history estimates, retired code removed.
- PR #215: model-driven milk tool, fact-card resume, scoped costs and localization.
- PR #214: owner fact cards, saved new-thread answers and milk-swap adapter.
- PR #211: shared café math, partial results and read-only refresh.
- PR #213: stored Toast facts and schedules exposed in chat.
- PR #210: Toast read-only diagnostics across all documented GET APIs.
- PR #209: manual Toast raw sample workflow.
- PR #208: Toast raw data samples.
- PR #207: GitHub Actions cron for Test Cafe sync.
