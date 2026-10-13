-- Disabled scheduler-callable Toast polling; no existing Vercel cron changes.
-- Apply after 49 in staging; never execute production migration without approval.
ALTER TABLE toast_sync_health
 ADD COLUMN IF NOT EXISTS last_order_poll_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_time_entry_poll_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_schedule_poll_at timestamptz;
CREATE TABLE IF NOT EXISTS toast_poll_leases (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('orders','attendance','schedules')),
 lease_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
 lease_until timestamptz NOT NULL,
 retry_after timestamptz,
 PRIMARY KEY(business_id,restaurant_guid,kind),
 FOREIGN KEY(business_id,restaurant_guid)
 REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
ALTER TABLE toast_poll_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_poll_leases FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION toast_claim_poll(p_business_id uuid,p_restaurant_guid uuid,p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result uuid;
BEGIN
 IF p_kind NOT IN ('orders','attendance','schedules') THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM toast_location_mappings
    WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
    AND verified_at IS NOT NULL) THEN RETURN NULL; END IF;
 INSERT INTO toast_poll_leases(business_id,restaurant_guid,kind,lease_nonce,lease_until)
 VALUES(p_business_id,p_restaurant_guid,p_kind,gen_random_uuid(),now()+interval '90 seconds')
 ON CONFLICT (business_id,restaurant_guid,kind) DO UPDATE
 SET lease_nonce=gen_random_uuid(),lease_until=now()+interval '90 seconds'
 WHERE toast_poll_leases.lease_until<=now()
  AND (toast_poll_leases.retry_after IS NULL OR toast_poll_leases.retry_after<=now())
 RETURNING lease_nonce INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION toast_finish_poll(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,p_nonce uuid,
 p_cursor_at timestamptz,p_success boolean,p_retry_after timestamptz,p_failure text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE applied boolean;
BEGIN
 UPDATE toast_poll_leases
 SET lease_until=now(),lease_nonce=gen_random_uuid(),
     retry_after=CASE WHEN p_success THEN NULL ELSE COALESCE(p_retry_after,now()+interval '2 minutes') END
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid AND kind=p_kind
  AND lease_nonce=p_nonce AND lease_until>now();
 applied:=FOUND;
 IF NOT applied THEN RETURN false; END IF;
 INSERT INTO toast_sync_health (
   business_id,restaurant_guid,last_attempt_at,last_order_poll_at,
   last_time_entry_poll_at,last_schedule_poll_at,last_failure_category,retry_after)
 VALUES (p_business_id,p_restaurant_guid,now(),
  CASE WHEN p_success AND p_kind='orders' THEN p_cursor_at END,
  CASE WHEN p_success AND p_kind='attendance' THEN p_cursor_at END,
  CASE WHEN p_success AND p_kind='schedules' THEN p_cursor_at END,
  CASE WHEN p_success THEN NULL ELSE p_failure END,
  CASE WHEN p_success THEN NULL ELSE p_retry_after END)
 ON CONFLICT (business_id,restaurant_guid) DO UPDATE SET
  last_attempt_at=excluded.last_attempt_at,
  last_order_poll_at=COALESCE(excluded.last_order_poll_at,toast_sync_health.last_order_poll_at),
  last_time_entry_poll_at=COALESCE(excluded.last_time_entry_poll_at,toast_sync_health.last_time_entry_poll_at),
  last_schedule_poll_at=COALESCE(excluded.last_schedule_poll_at,toast_sync_health.last_schedule_poll_at),
  last_failure_category=excluded.last_failure_category,retry_after=excluded.retry_after;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION toast_claim_poll(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_finish_poll(uuid,uuid,text,uuid,timestamptz,boolean,timestamptz,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_claim_poll(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION toast_finish_poll(uuid,uuid,text,uuid,timestamptz,boolean,timestamptz,text)
 TO service_role;
