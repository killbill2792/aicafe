-- Durable bounded Toast order-event processing. No canonical order/timecard writes.
-- Apply after migrations 40-48 in an isolated staging database; production requires approval.
ALTER TABLE toast_order_events ADD COLUMN IF NOT EXISTS order_guid uuid;
ALTER TABLE toast_order_events ADD COLUMN IF NOT EXISTS lease_nonce uuid;
CREATE INDEX IF NOT EXISTS toast_order_events_retry_idx
 ON toast_order_events(state,next_attempt_at,received_at);
CREATE TABLE IF NOT EXISTS toast_modified_orders_staging (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 order_guid uuid NOT NULL,
 source_event_guid uuid,
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL CHECK (state IN ('completed','review_required')),
 normalized_order jsonb,
 PRIMARY KEY(business_id,restaurant_guid,order_guid),
 FOREIGN KEY (business_id,restaurant_guid)
   REFERENCES toast_location_mappings(business_id,restaurant_guid),
 CHECK ((state='completed' AND normalized_order IS NOT NULL)
     OR (state='review_required' AND normalized_order IS NULL))
);

ALTER TABLE toast_modified_orders_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_modified_orders_staging FROM PUBLIC,anon,authenticated;

-- Leased work is released automatically for retry after next_attempt_at.
-- SKIP LOCKED avoids concurrent Vercel invocations claiming the same event.
CREATE OR REPLACE FUNCTION toast_claim_order_events(p_limit integer)
RETURNS TABLE(business_id uuid,event_guid uuid,restaurant_guid uuid,
 order_guid uuid,attempts integer,lease_nonce uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH chosen AS (
   SELECT e.business_id,e.event_guid
   FROM toast_order_events e
   WHERE e.order_guid IS NOT NULL
    AND e.next_attempt_at<=now()
    AND e.state IN ('pending','processing','failed')
   ORDER BY e.received_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT LEAST(GREATEST(p_limit,1),3)
 )
 UPDATE toast_order_events e SET
  state='processing',attempts=e.attempts+1,
  lease_nonce=gen_random_uuid(),
  next_attempt_at=now()+interval '3 minutes'
 FROM chosen c
 WHERE e.business_id=c.business_id AND e.event_guid=c.event_guid
 RETURNING e.business_id,e.event_guid,e.restaurant_guid,e.order_guid,
  e.attempts,e.lease_nonce
$$;
CREATE OR REPLACE FUNCTION toast_finish_order_event(
 p_business_id uuid,p_event_guid uuid,p_lease_nonce uuid,
 p_success boolean,p_retry_after timestamptz,p_failure_category text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE toast_order_events SET
   state=CASE WHEN p_success THEN 'complete' ELSE 'failed' END,
   lease_nonce=NULL,
   next_attempt_at=COALESCE(p_retry_after,now()+interval '1 minute'),
   last_failure_category=CASE WHEN p_success THEN NULL ELSE p_failure_category END
 WHERE business_id=p_business_id AND event_guid=p_event_guid
  AND lease_nonce=p_lease_nonce AND state='processing';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION toast_claim_order_events(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_finish_order_event(uuid,uuid,uuid,boolean,timestamptz,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_claim_order_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION toast_finish_order_event(uuid,uuid,uuid,boolean,timestamptz,text)
 TO service_role;
