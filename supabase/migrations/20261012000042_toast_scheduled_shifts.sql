-- Read-only provider schedule facts (never actual timecards or owner recurring schedules).
CREATE TABLE IF NOT EXISTS pos_scheduled_shifts (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='toast'),
 external_shift_id text NOT NULL,
 external_employee_id text NOT NULL,
 external_job_id text,
 scheduled_start timestamptz NOT NULL,
 scheduled_end timestamptz NOT NULL,
 deleted boolean NOT NULL DEFAULT false,
 last_synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,provider,external_shift_id),
 CHECK(scheduled_end>scheduled_start),
 FOREIGN KEY(business_id,location_id) REFERENCES locations(business_id,id)
);
ALTER TABLE pos_scheduled_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read Toast schedules" ON pos_scheduled_shifts FOR SELECT TO authenticated
 USING(is_member(business_id));
REVOKE ALL ON pos_scheduled_shifts FROM anon;
GRANT SELECT ON pos_scheduled_shifts TO authenticated;
