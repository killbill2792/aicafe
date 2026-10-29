Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Now
- [ ] Set `OPENAI_API_KEY` in production before deploying #216 (receipts and statements now always use OpenAI).
- [ ] Owner: apply migration 122 (RLS on `businesses`, merged in #220) to production: `alter table public.businesses enable row level security;`
- [ ] Owner: set `DAILY_BRIEF_ENABLED=true` in Vercel production to turn on the morning brief (#226).
- [ ] Owner: apply migrations 123 (drop empty owner-initiative tables, #231), 124 (live today reading, #238) and 125 ("needs a look" cleanup, #240). The code works before 124 is applied (it reads Toast live).

## Next — the AI reads all POS data (AGENTS.md 4b)
- [x] 4a. Daily capture of every Toast endpoint (#218). Owner: run it once by hand, then set the repository variable `TOAST_DAILY_CAPTURE_ENABLED=true`.
- [ ] 4b. Point the canonical views (#212) at that store, so cash, stock, kitchen and dining options are fresh; add views for the remaining endpoints.
- [ ] 4c. Merge `describe_data` / `query_data` (#212) with a dictionary entry for every source; screens move to the same readers.
- [ ] 4d. "Today so far" live layer: provisional, replaced at closeout.
  - [x] Chat reads today's Toast sales live when asked (`get_today_so_far`, read-only, not stored, 3-minute cache). The old poll (`lib/pos/toast/poll.ts`) was never switched on: it needs four flags and an outside scheduler, and it writes to a staging table the chat does not read.
  - [x] Saved reading every 15 minutes (`/api/cron/today-live`, table `toast_today_live`); Home's Today sales and the chat read the same one (#238).
  - [ ] Add payments, time entries, stock and cash to the live read; wire the Money screen's "today at a glance" card to it.

## Next — the operator loop (AGENTS.md 4–5)
- [x] One experiment system: the Supervisor loop. Owner initiatives deleted (#229, tables dropped by #231); goals (#230), goal check-ins (#232) and a price-test orders guardrail (#233) added to the loop.
- [x] Operating Board: "Running" (waiting on your POS change, or day X of Y) and "Recent reports" on `ChatStart`, from the Supervisor loop tables. Mid-run early read comes with the mid-run updates item.
- [ ] Inbox + notifications: final reports (existing), mid-run updates (#225) and the morning brief (#226) are each an `operating_tasks` item plus a chat message. Left: an unread badge on the board (needs a "seen" timestamp, so a migration).
- [ ] Proactive monitor:
  - [x] Morning brief once per café per day in the latest thread: yesterday's sales, known costs, what was kept, and how many things need the owner (#226; off until `DAILY_BRIEF_ENABLED=true`).
  - [ ] Live checks every ~30 minutes while open, with duplicate suppression and a daily cap (after 4d part 2).
- [x] Mid-run experiment updates: one halfway message in the experiment thread plus a watching inbox item (#225).

## Next — Toast data answers every question (owner priority)
- [x] Sales answers use imported Toast days even when a day is flagged (#234).
- [x] Processing fees: Toast's fee per payment, estimates only for gaps, hourly re-pull of days imported before payments were saved (#235).
- [x] One reader for saved daily totals, used by every screen and chat tool (#236).
- [x] Toast page: Re-pull and "Looks right" say exactly what happened (#237); Toast Analytics is an optional line (#239).
- [x] "Needs a look" lists real problems only; stale flags cleared (#240, migration 125).
- [ ] Fold the pricing and economics row mappers into `rowToDailyFacts`; decide whether ad-hoc data queries may answer sales/fee numbers (canonical views are a second path).

## Later
- [ ] Email delivery of inbox items.
- [ ] Currency: remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts` (`formatCents` callers, BillsManager, etc.). More page and card-fee setup done in #227.
- [ ] Merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts` into `lib/metrics/core`, with parity tests.
- [ ] Rolling conversation summary; tool-result size cap enforced in code.
- [ ] Add `npm run smoke:agent` (live owner smoke test run by the owner before release).
- [ ] Browser push, Toast webhooks, "always allow" per action type, WhatsApp/SMS sending once a verified business sender exists.

## Done (last 10)
- PR #240: "needs a look" lists real problems only; stale `changed_snapshot` flags cleared (migration 125).
- PR #239: Toast Analytics is a small optional line for cafés without it.
- PR #238: live today's sales, saved every 15 minutes, same number on Home and in the chat (migration 124).
- PR #237: Toast page actions say exactly what happened.
- PR #236: one reader for saved daily totals across screens and chat.
- PR #235: processing fees from Toast for every day; only gaps estimated.
- PR #234: sales answers use imported Toast days even when flagged.
- PR #233: price tests watch total café orders.
- PR #232: goal check-ins.
- PR #230: goals in the Supervisor loop.
