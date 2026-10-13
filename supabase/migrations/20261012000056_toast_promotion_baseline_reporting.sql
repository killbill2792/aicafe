-- PR 63 final follow-up: freeze the canonical order projection at actual promotion.
-- Append-only migration: do NOT rewrite applied migrations 40-55.
-- No canonical revenue/rollup edits, no activation or schedule changes.
CREATE TABLE toast_promotion_order_baselines (
 business_id uuid NOT NULL,
 restaurant_guid uuid NOT NULL,
 order_guid uuid NOT NULL,
 canonical_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 business_date date NOT NULL,
 promoted_snapshot_sha256 text NOT NULL,
 normalized_order jsonb NOT NULL CHECK(jsonb_typeof(normalized_order)='object'),
 captured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,order_guid),
 FOREIGN KEY (business_id,restaurant_guid,business_date)
   REFERENCES toast_pilot_days(business_id,restaurant_guid,business_date)
);
ALTER TABLE toast_promotion_order_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_promotion_order_baselines FROM PUBLIC,anon,authenticated,service_role;

-- Compare the business-relevant normalized provider facts, not a fetch timestamp.
-- Stable sorting avoids false positives when the API changes only line/modifier order.
-- Neither request metadata nor the provider modification timestamp is a sales change.
CREATE FUNCTION toast_substantive_order_projection(p_order jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN jsonb_typeof(p_order)<>'object' THEN NULL ELSE
  jsonb_build_object(
   'posOrderId',p_order->'posOrderId',
   'posLocationId',p_order->'posLocationId',
   'closedAt',p_order->'closedAt',
   'grossSalesCents',p_order->'grossSalesCents',
   'discountsCents',p_order->'discountsCents',
   'refundsCents',p_order->'refundsCents',
   'taxCents',p_order->'taxCents',
   'tipCents',p_order->'tipCents',
   'netSalesCents',p_order->'netSalesCents',
   'processingFeeStatus',p_order->'processingFeeStatus',
   'processingFeeCents',p_order->'processingFeeCents',
   'lines',CASE WHEN jsonb_typeof(p_order->'lines')='array' THEN
      (SELECT coalesce(jsonb_agg(x.projection ORDER BY x.projection::text),'[]'::jsonb)
       FROM (
        SELECT jsonb_build_object(
         'posItemId',l->'posItemId',
         'name',l->'name',
         'quantity',l->'quantity',
         'netSalesCents',l->'netSalesCents',
         'voided',l->'voided',
         'voidedBy',l->'voidedBy',
         'modifiers',CASE WHEN jsonb_typeof(l->'modifiers')='array' THEN
          (SELECT coalesce(jsonb_agg(m ORDER BY m::text),'[]'::jsonb)
           FROM jsonb_array_elements(l->'modifiers') m)
          ELSE l->'modifiers' END
        ) AS projection
        FROM jsonb_array_elements(p_order->'lines') l
       ) x)
     ELSE p_order->'lines' END
  ) END
$$;
REVOKE ALL ON FUNCTION toast_substantive_order_projection(jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Replace the latest guarded entrypoint by wrapping it; the old independent
-- evidence, refund-day and CSV-overlap checks remain in force.
ALTER FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 RENAME TO toast_promote_reconciled_day_pre_baseline;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day_pre_baseline(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_business_date date,p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE promoted_count integer; baseline_count integer;
BEGIN
 SELECT toast_promote_reconciled_day_pre_baseline(
  p_business_id,p_restaurant_guid,p_location_id,p_business_date,p_expected_sha256)
 INTO promoted_count;
 -- Freeze a trustworthy baseline in this SAME transaction as canonical promotion.
 -- Abort the whole promotion if any canonical order is absent or a frozen
 -- baseline already conflicts with the exact report-matched snapshot.
 IF EXISTS (
  SELECT 1 FROM toast_pilot_days p
  CROSS JOIN LATERAL jsonb_array_elements(p.orders_snapshot) rec
  LEFT JOIN orders o ON o.business_id=p_business_id
    AND o.location_id=p_location_id AND o.business_date=p_business_date
    AND o.pos_order_id=rec->>'posOrderId'
  LEFT JOIN toast_promotion_order_baselines b ON
    b.business_id=p_business_id AND b.restaurant_guid=p_restaurant_guid
    AND b.order_guid=split_part(rec->>'posOrderId',':',3)::uuid
  WHERE p.business_id=p_business_id AND p.restaurant_guid=p_restaurant_guid
    AND p.business_date=p_business_date
    AND (o.id IS NULL OR (b.canonical_order_id IS NOT NULL AND
      (b.canonical_order_id<>o.id OR b.promoted_snapshot_sha256<>p_expected_sha256
       OR toast_substantive_order_projection(b.normalized_order)
         IS DISTINCT FROM toast_substantive_order_projection(rec))))
 ) THEN RAISE EXCEPTION 'Frozen Toast promotion baseline conflicts with canonical orders'; END IF;
 INSERT INTO toast_promotion_order_baselines (
   business_id,restaurant_guid,order_guid,canonical_order_id,business_date,
   promoted_snapshot_sha256,normalized_order)
 SELECT p_business_id,p_restaurant_guid,
   split_part(rec->>'posOrderId',':',3)::uuid,o.id,p_business_date,
   p_expected_sha256,rec
 FROM toast_pilot_days p
 CROSS JOIN LATERAL jsonb_array_elements(p.orders_snapshot) rec
 JOIN orders o ON o.business_id=p_business_id AND o.location_id=p_location_id
   AND o.business_date=p_business_date AND o.pos_order_id=rec->>'posOrderId'
 WHERE p.business_id=p_business_id AND p.restaurant_guid=p_restaurant_guid
  AND p.business_date=p_business_date
 ON CONFLICT(business_id,restaurant_guid,order_guid) DO NOTHING;
 SELECT count(*) INTO baseline_count FROM toast_promotion_order_baselines
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND business_date=p_business_date AND promoted_snapshot_sha256=p_expected_sha256;
 IF baseline_count<>promoted_count THEN
  RAISE EXCEPTION 'Promotion baseline incomplete: fail closed'; END IF;
 RETURN promoted_count;
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 TO service_role;

-- Replace migration 55's unconditional-correction wrapper. The earlier atomic
-- provider-modification-time compare-and-set remains the ONLY staging mutation.
-- An identical completed reread is not a correction, even when its version moved.
CREATE OR REPLACE FUNCTION toast_store_order_fact(
 p_business_id uuid,p_restaurant_guid uuid,p_order_guid uuid,
 p_modified_at timestamptz,p_state text,p_normalized_order jsonb,
 p_event_guid uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed boolean; canonical_id uuid; affected_day date;
 baseline_fact jsonb; is_substantive boolean;
BEGIN
 SELECT toast_store_order_fact_pre_correction(
  p_business_id,p_restaurant_guid,p_order_guid,p_modified_at,p_state,
  p_normalized_order,p_event_guid) INTO changed;
 IF NOT changed THEN RETURN false; END IF;
 SELECT o.id,o.business_date INTO canonical_id,affected_day
 FROM orders o WHERE o.business_id=p_business_id
  AND o.pos_order_id='toast:'||p_restaurant_guid::text||':'||p_order_guid::text
 FOR UPDATE;
 IF NOT FOUND THEN RETURN true; END IF;
 SELECT b.normalized_order INTO baseline_fact
 FROM toast_promotion_order_baselines b
 WHERE b.business_id=p_business_id AND b.restaurant_guid=p_restaurant_guid
  AND b.order_guid=p_order_guid AND b.canonical_order_id=canonical_id
  AND b.business_date=affected_day;

 -- Missing/untrusted historical baseline fails closed: it is NOT proof of equality.
 is_substantive := p_state<>'completed' OR baseline_fact IS NULL
  OR p_normalized_order IS NULL
  OR toast_substantive_order_projection(baseline_fact)
     IS DISTINCT FROM toast_substantive_order_projection(p_normalized_order);
 IF NOT is_substantive THEN RETURN true; END IF;

 INSERT INTO toast_canonical_corrections(
  business_id,restaurant_guid,order_guid,canonical_order_id,business_date,
  latest_provider_modified_at,latest_provider_state)
 VALUES(p_business_id,p_restaurant_guid,p_order_guid,canonical_id,affected_day,
  p_modified_at,p_state)
 ON CONFLICT(business_id,restaurant_guid,order_guid) DO UPDATE SET
  latest_provider_modified_at=EXCLUDED.latest_provider_modified_at,
  latest_provider_state=EXCLUDED.latest_provider_state,last_detected_at=now()
 WHERE toast_canonical_corrections.latest_provider_modified_at
   <=EXCLUDED.latest_provider_modified_at;

 UPDATE toast_pilot_days SET state='needs_review',last_error_category=
  CASE WHEN baseline_fact IS NULL THEN 'promotion_baseline_missing'
       ELSE 'provider_correction' END
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
  AND business_date=affected_day AND promoted_at IS NOT NULL AND state='promoted';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 TO service_role;

-- Trusted reporting boundary: service-role read only; tenant-scoped data.
-- Consumers MUST join this provenance/status to Toast-origin canonical days
-- before ever claiming they are fully reconciled. No finance formulas touched.
CREATE VIEW toast_financial_reporting_status AS
SELECT p.business_id,p.restaurant_guid,p.location_id,p.business_date,
 p.promoted_at,p.state AS pilot_state,p.snapshot_sha256 AS latest_pilot_sha256,
 h.last_order_poll_at AS last_modified_order_poll_at,
 (SELECT count(*) FROM toast_canonical_corrections c
  WHERE c.business_id=p.business_id AND c.restaurant_guid=p.restaurant_guid
   AND c.business_date=p.business_date AND c.status='review_required') AS pending_corrections,
 CASE WHEN p.promoted_at IS NOT NULL AND
      (p.state<>'promoted' OR EXISTS(
       SELECT 1 FROM toast_canonical_corrections c
       WHERE c.business_id=p.business_id AND c.restaurant_guid=p.restaurant_guid
        AND c.business_date=p.business_date AND c.status='review_required'))
  THEN 'review_required'
  WHEN p.promoted_at IS NOT NULL THEN 'promoted_pending_live_reconciliation'
  ELSE 'not_promoted'
 END AS verification_status,
 FALSE AS fully_verified_for_owner_reporting
FROM toast_pilot_days p
LEFT JOIN toast_sync_health h
 ON h.business_id=p.business_id AND h.restaurant_guid=p.restaurant_guid;
REVOKE ALL ON toast_financial_reporting_status FROM PUBLIC,anon,authenticated;
GRANT SELECT ON toast_financial_reporting_status TO service_role;
