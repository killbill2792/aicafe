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

-- Composite-FK anchor so a staged row's job_id/location_id/menu_item_id/employee_id can be
-- constrained to belong to the SAME business_id the row claims (see the composite FKs below) —
-- the same idiom as Olivia's employee/location composite FKs (20261014000060). Each of these is
-- always-satisfiable (id is already a unique primary key) and purely additive.
alter table csv_import_jobs add constraint csv_import_jobs_id_business_unique unique (id, business_id);
alter table locations add constraint locations_id_business_unique unique (id, business_id);
alter table menu_items add constraint menu_items_id_business_unique unique (id, business_id);
alter table employees add constraint employees_id_business_unique unique (id, business_id);

-- Staged, aggregated sales groups for one job. menu_item_id is resolved once per distinct item
-- (lib/pos/catalogMatching.ts) before staging, not re-resolved per promotion call.
create table csv_sales_import_groups (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  business_id uuid not null references businesses on delete cascade,
  location_id uuid,
  business_date date not null,
  item_name text not null,
  category text,
  menu_item_id uuid,
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
  promoted boolean not null default false,
  -- Composite FKs: job_id/location_id/menu_item_id must belong to the SAME business_id as this
  -- row, not merely exist somewhere. Without this, a member of two cafés could stage a row with
  -- this business's id but another business's job/location/menu item, and the security-invoker
  -- finalizer would write a canonical order referencing the wrong tenant's catalog. No ON DELETE
  -- SET NULL on the location/menu_item FKs: for a composite key, SET NULL would null out
  -- business_id too (it's part of the key), which can't happen — business_id is NOT NULL here —
  -- so these stay the default NO ACTION, which only matters for a location/menu item deleted while
  -- a staging row still references it (staging rows are short-lived and normally promoted or
  -- discarded well before that).
  constraint csv_sales_import_groups_job_fk foreign key (job_id, business_id) references csv_import_jobs (id, business_id) on delete cascade,
  constraint csv_sales_import_groups_location_fk foreign key (location_id, business_id) references locations (id, business_id),
  constraint csv_sales_import_groups_menu_item_fk foreign key (menu_item_id, business_id) references menu_items (id, business_id)
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
  job_id uuid not null,
  business_id uuid not null references businesses on delete cascade,
  employee_id uuid not null,
  pos_timecard_id text not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  hourly_wage_cents bigint,
  promoted boolean not null default false,
  constraint csv_labor_import_rows_job_fk foreign key (job_id, business_id) references csv_import_jobs (id, business_id) on delete cascade,
  constraint csv_labor_import_rows_employee_fk foreign key (employee_id, business_id) references employees (id, business_id) on delete cascade
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
    -- Serializes against OTHER CSV finalize calls for the same business+date (a second job or a
    -- concurrent retry of this one) before the conflict check below, so two CSV callers can never
    -- both pass it and both write. Toast's own toast_promote_reconciled_day (20261012000046) does
    -- not take this same lock — it is Toast-specific code this PR must not modify — so this closes
    -- the CSV-vs-CSV race completely but only narrows, rather than eliminates, a true concurrent
    -- CSV-vs-Toast promotion of the identical business+date; that residual gap is a documented
    -- follow-up for whoever owns the Toast promotion path.
    perform pg_advisory_xact_lock(hashtextextended(g.business_id::text || ':' || g.business_date::text, 0));

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

    -- Category is part of the id when present so two groups that share a date+item but differ
    -- only by category (aggregateSalesRows deliberately keeps them separate) land as two distinct
    -- canonical orders instead of the second upsert silently overwriting the first's order_lines.
    v_pos_order_id := left('csv-' || g.business_date::text || '-' || g.item_name || coalesce('|' || g.category, ''), 120);

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
