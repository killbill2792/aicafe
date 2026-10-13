-- Mark existing canonical Toast orders stale when newer provider data arrives.
-- Do NOT silently overwrite, delete or refund canonical revenue.
CREATE TABLE toast_canonical_corrections (
 business_id uuid NOT NULL,
 restaurant_guid uuid NOT NULL,
 order_guid uuid NOT NULL,
 canonical_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 business_date date NOT NULL,
 latest_provider_modified_at timestamptz NOT NULL,
 latest_provider_state text NOT NULL CHECK(latest_provider_state IN (
   'completed','open','reopened','voided','deleted','refunded','ambiguous')),
 status text NOT NULL DEFAULT 'review_required' CHECK(status='review_required'),
 first_detected_at timestamptz NOT NULL DEFAULT now(),
 last_detected_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (business_id,restaurant_guid,order_guid),
 FOREIGN KEY (business_id,restaurant_guid)
  REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
CREATE INDEX toast_canonical_corrections_day_idx
 ON toast_canonical_corrections(business_id,restaurant_guid,business_date);
ALTER TABLE toast_canonical_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_canonical_corrections FROM PUBLIC,anon,authenticated;

-- Retain the original protected, monotonic compare-and-set. Only this new
-- wrapper is accessible to the service role; the older function cannot bypass
-- the stale-canonical reconciliation warning.
ALTER FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 RENAME TO toast_store_order_fact_pre_correction;
REVOKE ALL ON FUNCTION toast_store_order_fact_pre_correction(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION toast_store_order_fact(
 p_business_id uuid,p_restaurant_guid uuid,p_order_guid uuid,
 p_modified_at timestamptz,p_state text,p_normalized_order jsonb,
 p_event_guid uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed boolean; canonical_id uuid; affected_day date;
BEGIN
 SELECT toast_store_order_fact_pre_correction(
  p_business_id,p_restaurant_guid,p_order_guid,p_modified_at,p_state,
  p_normalized_order,p_event_guid) INTO changed;
 IF NOT changed THEN RETURN false; END IF;
 SELECT id,business_date INTO canonical_id,affected_day
 FROM orders WHERE business_id=p_business_id
  AND pos_order_id='toast:'||p_restaurant_guid::text||':'||p_order_guid::text
 FOR UPDATE;
 IF NOT FOUND THEN RETURN true; END IF;
 INSERT INTO toast_canonical_corrections(
  business_id,restaurant_guid,order_guid,canonical_order_id,business_date,
  latest_provider_modified_at,latest_provider_state)
 VALUES(p_business_id,p_restaurant_guid,p_order_guid,canonical_id,affected_day,
  p_modified_at,p_state)
 ON CONFLICT(business_id,restaurant_guid,order_guid) DO UPDATE SET
  latest_provider_modified_at=EXCLUDED.latest_provider_modified_at,
  latest_provider_state=EXCLUDED.latest_provider_state,
  last_detected_at=now()
 WHERE toast_canonical_corrections.latest_provider_modified_at<=EXCLUDED.latest_provider_modified_at;
 -- A historically promoted day cannot remain 'verified' after an order changes.
 -- Canonical orders/lines and existing rollups remain untouched pending review.
 UPDATE toast_pilot_days SET state='needs_review',last_error_category='provider_correction'
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
  AND business_date=affected_day AND state='promoted';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 TO service_role;

-- No new canonical promotion while a known provider correction remains
-- unresolved for the same business date. Preserve prior independent evidence,
-- CSV overlap, refund-date, and single-location gates unchanged.
ALTER FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 RENAME TO toast_promote_reconciled_day_pre_correction;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day_pre_correction(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_business_date date,p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM toast_canonical_corrections
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND business_date=p_business_date AND status='review_required')
 THEN RAISE EXCEPTION 'Provider corrections require independent review'; END IF;
 RETURN toast_promote_reconciled_day_pre_correction(
  p_business_id,p_restaurant_guid,p_location_id,p_business_date,p_expected_sha256);
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 TO service_role;
