# Toast check modes and owner comparisons (PR H)

Toast imports remain readable while optional external evidence is unavailable.
Each café has one persisted check mode. Separate Analytics credentials must pass
an actual ERA report request/poll before they are marked verified. Detection runs
on connect and weekly. A revoked credential switches only that café to internal
checks; a report pending or timing out cannot erase a completed internal result.

Internal checks persist generation-scoped order pages and cross-day payment
lookups so work resumes after a cron slice. The `/orders/v2/payments` API is
[documented as a full GUID list](https://doc.toasttab.com/openapi/orders/operation/paymentsGet/),
without page/pageSize or nextPageToken. This implementation reads that list once,
accepts 2,500-payment days and reports `too_many_payments` above 20,000.
[Payment detail](https://doc.toasttab.com/openapi/orders/operation/paymentsGuidGet/)
provides `orderGuid` and `paidBusinessDate`. Cross-day tabs are informational;
unknown orders are re-pulled before a mismatch is declared.

Owner reports are independent records: daily net sales, optional orders,
discounts, refunds and voided-order counts, with source and actor attribution.
Typed, CSV and receipt-provider vision drafts use one strict schema. File parsing
never saves data. The owner confirms each row. The signed-session RPC rechecks
ownership, the mapped restaurant, the closed day and the demo guard; imports
refresh comparisons but never replace owner-entered numbers. Row locks serialize
the owner writer and imported-day trigger before the per-day advisory lock.

`toast_owner_attention_days_v` is the sole attention predicate.
`toast_owner_attention_counts_v` counts distinct dates for both the badge and the
page; the safe membership-checked attention RPC supplies the same flags to sales
quality readers. The mode evidence RPC exposes no credentials. A report mismatch
adds a day without removing its sales. A completed run is a good sync even with
unreadable orders; 36 hours without a completed run means stale.

Closeout changes preserve prior rollups and coverage, flag imported days for
rechecking, cancel superseded runs and discard their old staged pages. One-day
recovery runs are processed newest first and replace each import atomically.
No-op changes do not restart work. Owner comparisons survive these reimports.

## Fairness and provider limits

The cron snapshots all verified mappings in last-started order with stable tenant
and restaurant tie breakers, using database pages rather than a 100-mapping cap.
It gives each reached mapping a bounded slice, stamps its start after acquiring the
existing nonce lease, and logs `toast_tick_skipped` for each unreached mapping.
Daily imports and internal reconciliation precede historical scanning/backfill.

Credentials remain per café. Every Standard resource call sends
`Toast-Restaurant-External-ID`, so Toast ordinarily applies its client limits per
location. The local throttle remains, including 5-second OrdersBulk pacing. A
conservative additional database budget, keyed only by SHA-256(client_id), shares
20 requests/second and 10,000/rolling 15 minutes across locations, businesses and
isolates using the same client. Retry-After and exhausted Toast rate headers
persist a shared cooldown for that client, never another client's budget.
Analytics resource requests use this budget too. Auth requests have no restaurant
context; per-business auth leases and encrypted token reuse avoid login on every
tick. An account-wide provider limit can still be lower and is honored via 429.

## Migration and verification

Provisional migration: `20261027000098_toast_check_modes.sql`. Main was
`ddc36980` at implementation (PR D included; E/F not merged). Renumber after the
final prerequisite rebase if necessary. No production migration is applied here.
Every new table enables RLS explicitly and has static action policies; operational
budgets/cache stay service-role only. Members read only their own summary rows;
only owners of non-demo cafés can invoke the write RPC successfully.

The existing Toast DB workflow runs `scripts/toast-pr-h-sql-integration.sql`, plus
the earlier atomic-import, RLS and closeout tests. The closeout assertions were
updated to require visible history and cancelled stale ranges, replacing the old
requirement to hide history.

Read-only release checks:

```sql
select toast_check_mode,mode_reason,count(*)
from public.toast_api_credentials group by 1,2 order by 1,2;

select recon_state,count(*) from public.toast_day_status group by 1 order by 1;

-- Expected 0 imported days stuck pending for >24h.
select business_id,restaurant_guid,business_date,last_recon_attempt_at
from public.toast_day_status
where import_state='imported' and recon_state='pending'
  and imported_at < now()-interval '24 hours';

select comparison,count(*) from public.toast_owner_summary_entries group by 1;

-- Expected 0 for verified active mappings when cron is running normally.
select business_id,restaurant_guid,last_tick_started_at
from public.toast_location_mappings where verified_at is not null
  and (last_tick_started_at is null or last_tick_started_at < now()-interval '30 minutes');

-- Page and badge use this exact distinct-date count.
select * from public.toast_owner_attention_counts_v;
```

## Draft release gates

After E/F merge, rebase onto main, preserve overlapping changes and check the
migration number after G. Repeat the full tests, typecheck and lint. Run the real
Supabase workflow and live Standard/Analytics smoke tests. Capture before/after
English and Arabic screenshots of the mode, checklist, summary inputs and attention
list. Native Next/SWC config loading and Chromium cannot run in the current host;
no screenshot or successful production build is claimed. Keep this PR draft until
those gates and the owner's verification are complete.
