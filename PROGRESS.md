Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Now
- [ ] Security: enable RLS on `businesses` (the only table without it) and add a CI check that fails if any `public` table has RLS off. Verify production first: `select relrowsecurity from pg_class where relname='businesses';`
- [ ] Finish cleanup PR #216: restore discarding of a failed call's partial text (AGENTS.md §6 exceptions), make its guard tests pass by fixing code, fix the 2 failing plan/period tests, show the partial-period note, update the 4 workflows that reference deleted files.
- [ ] Currency: remove hard-coded USD from price proposals (`menuPriceChange.server.ts`, `priceExperiment.server.ts`), `formatCents` callers and `BillsManager`; use the café currency everywhere.
- [ ] Golden owner questions: fixed fixture questions with exact expected numbers on both chat and screen paths; replace the `>= 0` cost check in `metricsParity.test.ts` with exact equality.

## Next
- [ ] One experiment system: choose between the Supervisor loop and owner initiatives, migrate the other into it, delete the loser.
- [ ] Operating Board: add "Running" (active experiments/monitors, day X of Y, early read) and "Recent reports" to `ChatStart`, reading the same data as the chat tools.
- [ ] Inbox + notifications: every proactive finding, experiment update and report becomes an `operating_tasks` item plus a chat message, with an unread badge on the board.
- [ ] Proactive monitors: daily job finds notable changes (costs, sales, labor, coverage, missing data) and posts a short report with a suggested action; duplicate suppression and daily cap.
- [ ] Mid-run experiment updates (not only the final report).
- [ ] Email delivery of inbox items (no business WhatsApp needed).
- [ ] Merge duplicate money formulas into `lib/metrics/core` (fees, break-even, labor) with parity tests.
- [ ] Expose stored Toast data to chat (voids, refunds, discounts, guest counts, dining options) via the canonical data layer (PR #212), with screens on the same reader.
- [ ] Rolling conversation summary; tool-result size cap enforced in code.
- [ ] Add `npm run smoke:agent` (live owner smoke test run by the owner before release).
- [ ] Later: browser push, "always allow" per action type, WhatsApp/SMS sending once a verified business sender exists.

## Done (last 10)
- PR #215: model-driven milk tool, fact-card resume, scoped costs and localization.
- PR #214: owner fact cards, saved new-thread answers and milk-swap adapter.
- PR #211: shared café math, partial results and read-only refresh.
- PR #213: stored Toast facts and schedules exposed in chat.
- PR #210: Toast read-only diagnostics across all documented GET APIs.
- PR #209: manual Toast raw sample workflow.
- PR #208: Toast raw data samples.
- PR #207: GitHub Actions cron for Test Cafe sync.
- PR #206: new-drink pricing explanation fix.
- PR #150: pantry starter ingredients, recipe-size templates and pricing helpers.
