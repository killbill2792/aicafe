-- Migration 48: do not rewrite migration 46 after its creation.
-- Keep legacy transactional promotion but disallow partial-business, refund-day,
-- potentially still-open, or unchecked zero days. Production activation remains OFF.
ALTER FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 RENAME TO toast_promote_reconciled_day_legacy;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day_legacy(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
CREATE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_business_date date,p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE staged toast_pilot_days%ROWTYPE;
BEGIN
 SELECT * INTO staged FROM toast_pilot_days
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND location_id=p_location_id AND business_date=p_business_date
 FOR UPDATE;
 IF NOT FOUND OR staged.snapshot_sha256<>p_expected_sha256
   OR staged.state NOT IN ('matched_owner_report','promoted')
   OR staged.report_checked_at IS NULL
   OR staged.fetched_at<now()-interval '24 hours'
 THEN RAISE EXCEPTION 'Report-matched Toast day requires fresh manual review'; END IF;
 -- OrdersBulk businessDate selects orders created that day, NOT refunds issued that day
 -- on older orders. Do not misattribute refund-day sales to the original close date.
 IF staged.refunds_cents<>0 THEN
   RAISE EXCEPTION 'Refund-affected periods require date-specific reconciliation';
 END IF;
 -- A single restaurant does not prove whole-business sales coverage.
 IF (SELECT count(*) FROM locations WHERE business_id=p_business_id)<>1 THEN
   RAISE EXCEPTION 'Multi-location totals require complete-location reconciliation';
 END IF;
 -- Do not promote zero-days or still-changing/closeout-pending dates.
 IF staged.order_count=0 OR p_business_date>=current_date-2 THEN
   RAISE EXCEPTION 'Historical complete positive-sale day required';
 END IF;
 RETURN toast_promote_reconciled_day_legacy(
    p_business_id,p_restaurant_guid,p_location_id,p_business_date,p_expected_sha256);
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text) TO service_role;
