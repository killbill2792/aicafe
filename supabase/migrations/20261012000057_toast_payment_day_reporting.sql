-- Toast closed-date provenance, payment-date exceptions and Supervisor coverage guard.
-- Additive, disabled by default; no existing rollups/order cents are changed.
CREATE TABLE toast_payment_day_events(
 business_id uuid NOT NULL,restaurant_guid uuid NOT NULL,
 payment_guid uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('refunded','voided')),
 event_business_date date NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,payment_guid,kind,event_business_date),
 FOREIGN KEY(business_id,restaurant_guid)
  REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
CREATE INDEX toast_payment_day_events_date_idx ON
 toast_payment_day_events(business_id,restaurant_guid,event_business_date);
ALTER TABLE toast_payment_day_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_payment_day_events FROM PUBLIC,anon,authenticated;
CREATE FUNCTION toast_stage_payment_day_events(
 p_business_id uuid,p_restaurant_guid uuid,p_date date,p_kind text,p_guids jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_date IS NULL OR p_date>current_date OR p_kind NOT IN ('refunded','voided')
 OR jsonb_typeof(p_guids)<>'array' OR jsonb_array_length(p_guids)>2000
 OR NOT EXISTS(SELECT 1 FROM toast_location_mappings
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND verified_at IS NOT NULL) THEN
   RAISE EXCEPTION 'invalid Toast payment-date evidence'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_guids) guid
  WHERE guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 THEN RAISE EXCEPTION 'invalid payment GUID'; END IF;
 INSERT INTO toast_payment_day_events(business_id,restaurant_guid,payment_guid,kind,event_business_date)
 SELECT p_business_id,p_restaurant_guid,guid::uuid,p_kind,p_date
 FROM jsonb_array_elements_text(p_guids) guid
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 -- Explicit payment-date activity invalidates any positive report-match or promotion
 -- status for THAT date; never guess which old original order/payment was affected.
 UPDATE toast_pilot_days SET state='needs_review',last_error_category='payment_date_correction'
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND business_date=p_date AND state IN ('matched_owner_report','promoted')
 AND jsonb_array_length(p_guids)>0;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION toast_stage_payment_day_events(uuid,uuid,date,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_stage_payment_day_events(uuid,uuid,date,text,jsonb)
 TO service_role;

-- The strongest existing independent report gate is retained; this wrapper can
-- only add exclusions. Empty provider scans are NEVER verified-zero evidence.
ALTER FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 RENAME TO toast_promote_reconciled_day_pre_payment_dates;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day_pre_payment_dates(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_business_date date,p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM toast_payment_day_events
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
    AND event_business_date=p_business_date)
 THEN RAISE EXCEPTION 'Refund/void payment business date requires independent reconciliation'; END IF;
 RETURN toast_promote_reconciled_day_pre_payment_dates(
   p_business_id,p_restaurant_guid,p_location_id,p_business_date,p_expected_sha256);
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 TO service_role;

-- Existing member/tenant boundaries. This RETURNS ONLY BLOCKED DATES, not secret
-- POS payloads. Entire Toast-source dates are excluded from confirmed totals
-- until an authorized live reporting coverage contract is explicitly implemented.
CREATE FUNCTION toast_unverified_sales_dates(
 p_business_id uuid,p_from date,p_to date)
RETURNS TABLE(business_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT is_member(p_business_id)
 OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to>p_from+interval '370 days'
 THEN RAISE EXCEPTION 'not authorized for Toast reporting coverage'; END IF;
 RETURN QUERY
 SELECT DISTINCT d.date FROM (
  SELECT o.business_date AS date FROM orders o
   WHERE o.business_id=p_business_id AND o.pos_order_id LIKE 'toast:%'
     AND o.business_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT e.event_business_date FROM toast_payment_day_events e
   WHERE e.business_id=p_business_id AND e.event_business_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT p.business_date FROM toast_pilot_days p
   WHERE p.business_id=p_business_id AND p.business_date BETWEEN p_from AND p_to
    AND p.promoted_at IS NOT NULL
 ) d ORDER BY d.date;
END $$;
REVOKE ALL ON FUNCTION toast_unverified_sales_dates(uuid,date,date)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION toast_unverified_sales_dates(uuid,date,date) TO authenticated;
