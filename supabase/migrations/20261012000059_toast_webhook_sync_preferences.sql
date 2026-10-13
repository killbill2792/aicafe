-- Owner-controlled webhook secret registration and externally invoked sync dispatcher.
-- All preferences and subscriptions remain disabled until explicit approval.
ALTER TABLE toast_webhook_subscriptions
 ALTER COLUMN signing_secret_enc DROP NOT NULL;
ALTER TABLE toast_webhook_subscriptions
 ADD CONSTRAINT toast_enabled_webhook_has_secret CHECK(enabled=false OR signing_secret_enc IS NOT NULL);

CREATE TABLE toast_sync_preferences(
 business_id uuid NOT NULL,restaurant_guid uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('orders','attendance','schedules','catalog','roster')),
 enabled boolean NOT NULL DEFAULT false,
 interval_minutes integer NOT NULL DEFAULT 60
   CHECK(interval_minutes BETWEEN 15 AND 1440),
 next_run_at timestamptz NOT NULL DEFAULT now(),
 last_success_at timestamptz,
 last_failure_category text,
 lease_nonce uuid,
 lease_until timestamptz,
 PRIMARY KEY(business_id,restaurant_guid,kind),
 FOREIGN KEY(business_id,restaurant_guid)
 REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
ALTER TABLE toast_sync_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_sync_preferences FROM PUBLIC,anon,authenticated;
CREATE INDEX toast_sync_preferences_due_idx
 ON toast_sync_preferences(enabled,next_run_at) WHERE enabled=true;

CREATE FUNCTION toast_set_sync_preference(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,
 p_enabled boolean,p_interval integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_kind NOT IN ('orders','attendance','schedules','catalog','roster')
 OR p_interval NOT BETWEEN 15 AND 1440
 OR NOT EXISTS(SELECT 1 FROM toast_location_mappings
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'verified Toast location required'; END IF;
 INSERT INTO toast_sync_preferences(
 business_id,restaurant_guid,kind,enabled,interval_minutes,next_run_at)
 VALUES(p_business_id,p_restaurant_guid,p_kind,p_enabled,p_interval,now())
 ON CONFLICT(business_id,restaurant_guid,kind) DO UPDATE SET
  enabled=p_enabled,interval_minutes=p_interval,next_run_at=now(),
  lease_nonce=NULL,lease_until=NULL;
 RETURN true;
END $$;

-- Lease + nonce prevents double running by concurrent external scheduler calls.
-- Single bounded location/capability per invocation. No new Vercel crons.
CREATE FUNCTION toast_claim_due_sync()
RETURNS TABLE(business_id uuid,restaurant_guid uuid,location_id uuid,
 kind text,lease_nonce uuid,interval_minutes integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 RETURN QUERY WITH candidate AS (
  SELECT s.business_id,s.restaurant_guid,s.kind FROM toast_sync_preferences s
  JOIN toast_location_mappings m ON m.business_id=s.business_id
    AND m.restaurant_guid=s.restaurant_guid AND m.verified_at IS NOT NULL
  WHERE s.enabled AND s.next_run_at<=now()
   AND (s.lease_until IS NULL OR s.lease_until<=now())
  ORDER BY s.next_run_at,s.business_id,s.restaurant_guid,s.kind
  FOR UPDATE OF s SKIP LOCKED LIMIT 1
 ), claimed AS (
  UPDATE toast_sync_preferences s SET lease_nonce=gen_random_uuid(),
   lease_until=now()+interval '75 seconds'
  FROM candidate c WHERE s.business_id=c.business_id
   AND s.restaurant_guid=c.restaurant_guid AND s.kind=c.kind
  RETURNING s.business_id,s.restaurant_guid,s.kind,s.lease_nonce,s.interval_minutes
 )
 SELECT c.business_id,c.restaurant_guid,m.location_id,c.kind,c.lease_nonce,c.interval_minutes
 FROM claimed c JOIN toast_location_mappings m ON m.business_id=c.business_id
  AND m.restaurant_guid=c.restaurant_guid;
END $$;
CREATE FUNCTION toast_finish_due_sync(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,p_nonce uuid,
 p_success boolean,p_failure text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE toast_sync_preferences SET lease_nonce=NULL,lease_until=NULL,
  last_success_at=CASE WHEN p_success THEN now() ELSE last_success_at END,
  last_failure_category=CASE WHEN p_success THEN NULL ELSE left(coalesce(p_failure,'unavailable'),64) END,
  next_run_at=now()+make_interval(mins=>CASE
   WHEN p_success THEN interval_minutes ELSE LEAST(interval_minutes,15) END)
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND kind=p_kind AND lease_nonce=p_nonce AND lease_until>now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION toast_set_sync_preference(uuid,uuid,text,boolean,integer)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_claim_due_sync() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_finish_due_sync(uuid,uuid,text,uuid,boolean,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_set_sync_preference(uuid,uuid,text,boolean,integer)
 TO service_role;
GRANT EXECUTE ON FUNCTION toast_claim_due_sync() TO service_role;
GRANT EXECUTE ON FUNCTION toast_finish_due_sync(uuid,uuid,text,uuid,boolean,text)
 TO service_role;
