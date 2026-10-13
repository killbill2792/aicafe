-- Disabled pilot staging. No existing canonical sales, payroll, or schedules modified.
-- Apply only in staging after migrations 40–43 and after migration-history review.
CREATE TABLE IF NOT EXISTS toast_pilot_days (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 location_id uuid NOT NULL,
 business_date date NOT NULL,
 orders_snapshot jsonb NOT NULL,
 order_count integer NOT NULL CHECK(order_count>=0),
 gross_sales_cents bigint NOT NULL,
 net_sales_cents bigint NOT NULL,
 discounts_cents bigint NOT NULL,
 refunds_cents bigint NOT NULL,
 tax_cents bigint NOT NULL,
 tip_cents bigint NOT NULL,
 product_quantities jsonb NOT NULL,
 snapshot_sha256 text NOT NULL,
 state text NOT NULL DEFAULT 'awaiting_report'
   CHECK(state IN ('awaiting_report','matched_owner_report','needs_review')),
 report_checked_at timestamptz,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 last_error_category text,
 PRIMARY KEY (business_id,restaurant_guid,business_date),
 FOREIGN KEY (business_id,restaurant_guid)
   REFERENCES toast_location_mappings(business_id,restaurant_guid),
 FOREIGN KEY (business_id,location_id) REFERENCES locations(business_id,id),
 CHECK(jsonb_typeof(orders_snapshot)='array'),
 CHECK(jsonb_typeof(product_quantities)='object')
);
CREATE INDEX IF NOT EXISTS toast_pilot_days_state_idx
 ON toast_pilot_days(business_id,state,business_date);
CREATE TABLE IF NOT EXISTS toast_sync_health (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 last_attempt_at timestamptz,
 last_order_fetch_at timestamptz,
 last_employee_fetch_at timestamptz,
 last_time_entry_fetch_at timestamptz,
 last_schedule_fetch_at timestamptz,
 last_menu_fetch_at timestamptz,
 last_failure_category text,
 retry_after timestamptz,
 PRIMARY KEY (business_id,restaurant_guid),
 FOREIGN KEY (business_id,restaurant_guid)
   REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
ALTER TABLE toast_pilot_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE toast_sync_health ENABLE ROW LEVEL SECURITY;
-- Staging contains commercial facts; only server-owned authenticated pilot writes allowed.
REVOKE ALL ON toast_pilot_days,toast_sync_health FROM PUBLIC,anon,authenticated;
