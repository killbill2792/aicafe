# Toast storage: every field, once (owner plan, Nov 3 2026)

## Why
The database filled up twice (Oct 30: 762 MB; Nov 2: 505 MB) with one café and ~70 days of data.
Both times the cause was **copies**, not data:
- Oct 30: every re-import saved every order again, tagged with its import run.
- Nov 2: Toast returns lists inside an order (applied taxes, selections) in a different order on each
  download. Our "has it changed?" check fingerprinted the exact text, so a reshuffle looked like a change.
  48 days that Toast can never fully verify were also re-downloaded daily. One day held 178 orders as 695
  rows.
- A corner case left the latest import pointing at two identical copies of one order (Sep 22/23).

The pattern: "one copy per order" was a promise kept by a long chain of code (staging pages, import
runs, `seen_run_id`, moving rows between runs, fingerprints, triggers), not something the database
enforced. Nothing measured size, duplicates or totals daily, and tests used tidy data.

## The rule (AGENTS.md §4b)
- "Keep everything" = keep **every field** the POS sends. Never copies.
- **One current raw record per POS object**, every field, filed under its business date. Enforced by a
  unique key. Save = same → nothing; different → update + change-log line. List order is ignored.
- **Change log** for real changes: field, before, after, when.
- **Organized tables** for every field the app uses, one row per order/item/payment by unique key.
- **Daily health check** to the inbox; **tests with real POS messiness**.

Example (one latte order, Sep 22, tip added in Toast on Oct 23):

| | Before | After |
|---|---|---|
| Raw | 5 full copies (~30 KB), 1 real change | 1 record with every field (~6 KB) |
| History | implicit in copies | 1 line: tip 0.00 → 1.00, Oct 23 |
| Organized | ~30 of ~150 fields | same, plus sales category, item timing, server per payment, service charges |

Database vs files: everything stays in the database, where the app and AI can query it. Moving old raw
records to compressed files in Supabase Storage is not needed at one record per order (~300 MB per café
per year) and is not planned.

## PRs, in order (one concern each)
Every PR: tests on a disposable database with real-shaped data first; Seiyun's daily totals checked
before and after (must match exactly); owner approves each migration before it touches Supabase;
screens and chat read the same tables and must not change.

0. **Done — #339:** sort GUID lists before comparing; stop re-pulling exhausted days; cleanup migration
   138 (applied Nov 3); brief top drink from café categories (migration 139).
1. **This PR:** the rule in AGENTS.md §4b and this plan. Docs only.
2. **Done — migration 140: one raw record per order, enforced.** Unique key on (café, restaurant, entity, Toast GUID) for orders.
   Save becomes upsert with a list-order-insensitive comparison; a real change updates the record and writes
   a `toast_raw_changes` line (entity, GUID, field path, before, after, changed_at, run). Retire run-moving
   and `seen_run_id`; readers that select "the latest import's records" read the one current record for the
   day. One-time conversion: keep the newest version, turn older real versions into change lines, drop the
   rest. Fee trigger, typed facts, `toast_records_for` and the day check keep their outputs (tests prove it).
3. **Done — migration 141: organized tables, enforced.** Orders, payment facts, payment summaries, voids and
   rollups already had unique keys. Added: Toast line ID on order lines (one row per order + line ID) and one
   refund row per payment. Screens and the AI read `orders`, which was already one row per order.
4. **Done — migration 142: daily health check.** `/api/cron/data-health` (daily, 17:20 UTC) saves one row per
   day: database size vs plan (> 70 %), sudden growth (> max(50 MB, 20 %)), POS objects stored more than once,
   and café-days (last 30) whose stored orders ≠ the import total or the import total ≠ Toast's. Shown on
   `/admin/health` (owner decision Nov 3: system alerts go to the admin page, not café inboxes). Counts only
   in logs. First run will list repeated void, menu item, time entry, employee and job records: step 2
   enforced one record per order only; the other entities need the same rule.
4b. **Done — migration 143: one record per staged object.** The first check (Nov 3) found ~2,200 extra rows:
   migration 111 copies every update of our Toast tables (staff, jobs, menu, time entries, voids…) and our own
   `fetched_at`/`last_seen` made each download look new; voids were keyed by order. Now each snapshot is filed
   under its source table's own unique key (enforced by the existing unique capture key), our bookkeeping times
   ignored, real changes logged, voids keyed by item. One-time collapse keeps the newest version (44 real time-entry changes logged).
5. **Done — real-messiness tests.** App side (`lib/pos/toast/dayImport.test.ts`): shuffled lists in every order,
   reordered pages, one order on two pages, an older version after a newer one, re-pulls → the exact same
   import is sent. Database side (`scripts/toast-messy-import-sql-integration.sql`): re-pulls, shuffled lists and
   pages, one order on two pages, a crashed run then a retry, a partial day then the full day → the same stored
   rows as one clean import (orders, lines, archive, typed details, voids, refunds, card-fee facts, day totals,
   rollup, change log); a real tip change → the new data plus exactly one change line.
   Found and fixed (migration 144): re-imports gave each refund snapshot a new row id, logged as a change.
6. **Done — migration 145: more organized fields.** Sales category was already on `order_lines.category`.
   Added: `order_lines.ordered_at` / `fulfillment_status` (when each item was rung up, kitchen status),
   `toast_payment_summaries.server_guid` / `paid_at` (who took each payment, when), `orders.service_charges_cents`
   / `gratuity_cents` (same rule as the day totals). History is filled by `select toast_fill_organized_fields(1)` … `(4)`
   (migration 146), four separate statements run once after the migration (not inside it, so the column change never
   locks the tables for long; one statement for all four hit the SQL editor's time limit); older item lines first
   get their Toast line ID where the match is certain (all 13,660 Seiyun lines matched in a production dry run).
   Toast has no "item made" time in the orders API; `fulfillment_status` is the kitchen state it does send.
7. **Done — migration 148: WhatsApp brief sends every morning** (template unchanged, no new Meta approval; see AGENTS.md §4c):
   - no verified event → "Today" says no major events were found nearby;
   - the same-weekday sales watch is NOT built yet (owner, Nov 4): the brief no longer waits for it, and the
     current template's watch sentence carries "(automatic sales alerts are not on yet)" until the two
     proposed templates without that sentence are approved;
   - the brief (an approved template) no longer needs an owner message in the last 24 h; later alerts follow
     Meta's 24 h rule and go to the in-app inbox outside it;
   - it goes out per café, 30 minutes before opening (06:00 café time if hours are unknown), never blocked
     by a missing extra, and every skip is recorded (`/admin/briefs`);
   - still required: a linked owner number and WhatsApp settings on in Vercel.
