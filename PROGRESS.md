Direction: an AI operator that runs the café through the Supervisor chat (see AGENTS.md sections 1–5).
Each item below is one small PR, in order. Do not start an item from "Next" before "Now" is done.

## Now
- [ ] Set `OPENAI_API_KEY` in production before deploying #216 (receipts and statements now always use OpenAI).
- [ ] Owner: apply migration 122 (RLS on `businesses`, merged in #220) to production: `alter table public.businesses enable row level security;`
- [ ] Owner: set `DAILY_BRIEF_ENABLED=true` in Vercel production to turn on the morning brief (#226).
- [ ] Owner: apply migrations 111–121 to production, then merge #212 (canonical data layer); its code needs those tables.

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
- [ ] Inbox + notifications: final reports (existing), mid-run updates (#225) and the morning brief (#226) are each an `operating_tasks` item plus a chat message. Left: an unread badge on the board (needs a "seen" timestamp, so a migration).
- [ ] Proactive monitor:
  - [x] Morning brief once per café per day in the latest thread: yesterday's sales, known costs, what was kept, and how many things need the owner (#226; off until `DAILY_BRIEF_ENABLED=true`).
  - [ ] Live checks every ~30 minutes while open, with duplicate suppression and a daily cap (after 4d part 2).
- [x] Mid-run experiment updates: one halfway message in the experiment thread plus a watching inbox item (#225).

## Later
- [ ] Email delivery of inbox items.
- [ ] Currency: remove the remaining hard-coded USD listed in `lib/ai/agent/bannedPatterns.test.ts` (`formatCents` callers, BillsManager, etc.). More page and card-fee setup done in #227.
- [ ] Merge duplicate money formulas listed in `lib/metrics/core/canonicalOnly.test.ts` into `lib/metrics/core`, with parity tests.
- [ ] Rolling conversation summary; tool-result size cap enforced in code.
- [ ] Add `npm run smoke:agent` (live owner smoke test run by the owner before release).
- [ ] Browser push, Toast webhooks, "always allow" per action type, WhatsApp/SMS sending once a verified business sender exists.

## Done (last 10)
- PR #226: proactive morning brief in the chat and inbox (off until the owner turns it on).
- PR #225: one mid-run experiment update in the chat and inbox.
- PR #224: `*.test.tsx` files now run in CI; six stale expectations updated.
- PR #223: Operating Board shows running experiments and recent reports; shares the experiment reader with the chat.
- PR #222: chat answers "how is today going" from a live, provisional Toast read.
- PR #221: chat cost answer matches the Money screen; 10 golden owner questions.
- PR #220: row level security on `businesses` and a CI check for every table.
- PR #219: fonts self-hosted (no build-time Google Fonts download).
- PR #218: daily capture of every Toast endpoint for the last three closed days.
- PR #217: AGENTS.md rewritten around the AI café operator direction.
