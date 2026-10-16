-- CSV import reliability (Issue #74). Fixes two production bugs found live-testing a real 14-day,
-- 2,555-row Toast per-selection export against the Raj Café demo tenant:
--  1. The old importer processed every row sequentially inside one Server Action call (3-4 awaited
--     round-trips each) and silently died partway through on a realistically sized file, with no
--     truthful status and no owner-visible error.
--  2. Its (business_date, item) upsert key assumed an already-aggregated product-mix row per item
--     per day; a per-selection export's repeated same-day rows silently overwrote each other
--     instead of summing.
--
-- Design: aggregation happens client-side (lib/pos/csv/aggregateSalesRows.ts, pure, tested) before
-- any network call, collapsing thousands of rows to a bounded number of (date, item, category)
-- groups. Groups are staged here in one bounded insert, then promoted into canonical
-- orders/order_lines or timecards by a single `security invoker` SQL function — one Postgres
-- transaction, atomic, bounded by group count rather than raw row count. This mirrors the
-- processing_fee_daily_facts "security invoker" RPC idiom (20261006000025), not Toast's
-- SECURITY DEFINER service-role-only pattern — CSV writes as the authenticated owner, same as
-- today, and does not touch any `toast_*` table or RPC.

create table csv_import_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses on delete cascade,
  kind text not null check (kind in ('sales', 'labor')),
  status text not null default 'processing' check (status in ('processing', 'needs_review', 'needs_wage_review', 'done', 'failed')),
  content_fingerprint text not null,
  rows_in_file int not null default 0,
  group_count int not null default 0,
  date_from date,
  date_to date,
  error_message text,
  summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Database-level concurrency guard: only one job can be actively processing for a given
-- business+kind at a time. A double-click, a second tab, or a page refresh that resubmits cannot
-- start a second overlapping run — this is enforced by Postgres, not a disabled React button.
create unique index csv_import_jobs_active_unique on csv_import_jobs (business_id, kind) where status = 'processing';

-- Backstop for exact-duplicate resubmission (same file, same mapping, same aggregated content) —
-- the server action checks for a prior match first and returns it without reprocessing; this index
-- is what makes that an actual invariant instead of a race two concurrent submissions could slip
-- through, since a unique violation here is caught and treated the same as the pre-check match.
-- Excludes 'failed' so the exact same file can always be retried after a genuine failure.
create unique index csv_import_jobs_fingerprint_unique on csv_import_jobs (business_id, kind, content_fingerprint) where status <> 'failed';

alter table csv_import_jobs enable row level security;
create policy "members read" on csv_import_jobs for select using (is_member(business_id));
create policy "members write" on csv_import_jobs for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on csv_import_jobs to authenticated;

-- Staged, aggregated sales groups for one job. menu_item_id is resolved once per distinct item
-- (lib/pos/catalogMatching.ts) before staging, not re-resolved per promotion call.
create table csv_sales_import_groups (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references csv_import_jobs on delete cascade,
  business_id uuid not null references businesses on delete cascade,
  location_id uuid references locations on delete set null,
  business_date date not null,
  item_name text not null,
  category text,
  menu_item_id uuid references menu_items on delete set null,
  quantity numeric(12, 2) not null,
  net_sales_cents bigint not null,
  processing_fee_cents bigint not null default 0,
  processing_fee_status text not null default 'missing' check (processing_fee_status in ('actual', 'missing')),
  source_row_count int not null default 1,
  -- Set by csv_finalize_sales_job when a toast:-sourced order already covers this date — Toast's
  -- own guarded promotion (20261012000046) refuses to run if a non-toast order already exists for
  -- a date; this is the symmetric check so CSV never silently double-counts the same sales facts
  -- Toast already promoted.
  conflict_reason text,
  promoted boolean not null default false
);
create index csv_sales_import_groups_job_idx on csv_sales_import_groups (job_id);

alter table csv_sales_import_groups enable row level security;
create policy "members read" on csv_sales_import_groups for select using (is_member(business_id));
create policy "members write" on csv_sales_import_groups for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on csv_sales_import_groups to authenticated;

-- Staged labor rows for one job. hourly_wage_cents is nullable here (unlike canonical
-- timecards.hourly_wage_cents, which stays NOT NULL and unchanged) — a shift with no wage evidence
-- stays staged, out of payroll, until the owner explicitly supplies a rate. Never a fabricated $0.
create table csv_labor_import_rows (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references csv_import_jobs on delete cascade,
  business_id uuid not null references businesses on delete cascade,
  employee_id uuid not null references employees on delete cascade,
  pos_timecard_id text not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  hourly_wage_cents bigint,
  promoted boolean not null default false
);
create unique index csv_labor_import_rows_timecard_unique on csv_labor_import_rows (business_id, pos_timecard_id);
create index csv_labor_import_rows_job_idx on csv_labor_import_rows (job_id);

alter table csv_labor_import_rows enable row level security;
create policy "members read" on csv_labor_import_rows for select using (is_member(business_id));
create policy "members write" on csv_labor_import_rows for all using (is_member(business_id)) with check (is_member(business_id));
grant select, insert, update, delete on csv_labor_import_rows to authenticated;

-- Promotes every not-yet-promoted staged group for one job into canonical orders/order_lines in a
-- single transaction (a PL/pgSQL function body has no internal commit points — if any step raises,
-- the whole call rolls back, so a partially-applied file can never be left looking complete). A
-- date already covered by a toast:-sourced order is skipped, not merged, and flagged for review.
create or replace function csv_finalize_sales_job(p_job_id uuid)
returns table (imported_groups int, skipped_toast_conflict int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_imported int := 0;
  v_skipped int := 0;
  g record;
  v_order_id uuid;
  v_pos_order_id text;
begin
  for g in select * from csv_sales_import_groups where job_id = p_job_id and not promoted loop
    if exists (
      select 1 from orders o
      where o.business_id = g.business_id
        and o.business_date = g.business_date
        and o.pos_order_id like 'toast:%'
    ) then
      update csv_sales_import_groups set conflict_reason = 'toast_covers_date' where id = g.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_pos_order_id := left('csv-' || g.business_date::text || '-' || g.item_name, 120);

    insert into orders (
      business_id, location_id, pos_order_id, closed_at, business_date,
      gross_sales_cents, net_sales_cents, processing_fee_cents, processing_fee_status, processing_fee_provider
    ) values (
      g.business_id, g.location_id, v_pos_order_id, (g.business_date::text || 'T12:00:00Z')::timestamptz,
      g.business_date, g.net_sales_cents, g.net_sales_cents, g.processing_fee_cents, g.processing_fee_status, 'csv'
    )
    on conflict (business_id, pos_order_id) do update set
      location_id = excluded.location_id,
      closed_at = excluded.closed_at,
      gross_sales_cents = excluded.gross_sales_cents,
      net_sales_cents = excluded.net_sales_cents,
      processing_fee_cents = excluded.processing_fee_cents,
      processing_fee_status = excluded.processing_fee_status,
      processing_fee_provider = excluded.processing_fee_provider
    returning id into v_order_id;

    delete from order_lines where order_id = v_order_id;
    insert into order_lines (order_id, menu_item_id, name, quantity, net_sales_cents, modifiers, voided)
    values (v_order_id, g.menu_item_id, g.item_name, g.quantity, g.net_sales_cents, '[]'::jsonb, false);

    update csv_sales_import_groups set promoted = true where id = g.id;
    v_imported := v_imported + 1;
  end loop;

  return query select v_imported, v_skipped;
end;
$$;
grant execute on function csv_finalize_sales_job(uuid) to authenticated;

-- Promotes every not-yet-promoted staged labor row with a known wage into canonical timecards, in
-- one transaction. Rows with hourly_wage_cents still null are left staged (never inserted with a
-- placeholder) and counted as pending_wage_review; calling this again after the owner supplies a
-- wage (lib/actions/csvImport.ts's resolveLaborImportWage) promotes just that row.
create or replace function csv_finalize_labor_job(p_job_id uuid)
returns table (imported int, pending_wage_review int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_imported int := 0;
  v_pending int := 0;
  r record;
begin
  for r in select * from csv_labor_import_rows where job_id = p_job_id and not promoted loop
    if r.hourly_wage_cents is null then
      v_pending := v_pending + 1;
      continue;
    end if;

    insert into timecards (business_id, employee_id, pos_timecard_id, clock_in, clock_out, hourly_wage_cents, source_type, source_provider)
    values (r.business_id, r.employee_id, r.pos_timecard_id, r.clock_in, r.clock_out, r.hourly_wage_cents, 'imported', 'CSV')
    on conflict (business_id, pos_timecard_id) do update set
      clock_out = excluded.clock_out,
      hourly_wage_cents = excluded.hourly_wage_cents;

    update csv_labor_import_rows set promoted = true where id = r.id;
    v_imported := v_imported + 1;
  end loop;

  return query select v_imported, v_pending;
end;
$$;
grant execute on function csv_finalize_labor_job(uuid) to authenticated;
