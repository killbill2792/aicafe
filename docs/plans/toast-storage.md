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
5. **Real-messiness tests.** Fixtures with reordered lists, the same order on two pages, re-pulls, retries,
   partial days: same data in → same stored rows out.
6. **More organized fields.** Toast sales category on order lines, item made/fulfilled times, server per
   payment, service charges — one additive change each.
7. **WhatsApp brief sends every morning** (template unchanged, no new Meta approval):
   - no verified event → "Today" says no major events were found nearby;
   - the same-weekday sales watch runs automatically for every café with the brief, so the template's
     "I'm watching today's sales" is true;
   - the brief (an approved template) no longer needs an owner message in the last 24 h; later alerts follow
     Meta's 24 h rule and go to the in-app inbox outside it;
   - still required: a linked owner number and WhatsApp settings on in Vercel.
