-- Additive Toast labor staging, separate from payrolled actual timecards.
-- Missing wages are nullable here; NEVER store fabricated zero compensation as verified.
CREATE TABLE IF NOT EXISTS toast_labor_entries (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 location_id uuid NOT NULL,
 external_time_entry_id uuid NOT NULL,
 external_employee_id uuid NOT NULL,
 clock_in timestamptz NOT NULL,
 clock_out timestamptz,
 hourly_wage_cents bigint,
 wage_status text NOT NULL CHECK(wage_status IN ('verified','missing')),
 breaks jsonb NOT NULL DEFAULT '[]'::jsonb,
 deleted boolean NOT NULL DEFAULT false,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,external_time_entry_id),
 FOREIGN KEY (business_id,restaurant_guid)
   REFERENCES toast_location_mappings(business_id,restaurant_guid),
 FOREIGN KEY (business_id,location_id) REFERENCES locations(business_id,id),
 CHECK (clock_out IS NULL OR clock_out>=clock_in),
 CHECK ((wage_status='missing' AND hourly_wage_cents IS NULL)
   OR (wage_status='verified' AND hourly_wage_cents IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS toast_labor_entries_clock_idx
  ON toast_labor_entries(business_id,restaurant_guid,clock_in);
ALTER TABLE toast_labor_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_labor_entries FROM PUBLIC,anon,authenticated;
