-- Toast independent reporting evidence gate; original safeguards from 46/48 stay.
CREATE TABLE toast_verified_report_evidence (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 restaurant_guid uuid NOT NULL,
 business_date date NOT NULL,
 staged_sha256 text NOT NULL,
 verification_source text NOT NULL CHECK(verification_source='independently_checked_toast_report'),
 evidence_reference text NOT NULL CHECK(length(evidence_reference)>8),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,business_date,staged_sha256),
 FOREIGN KEY(business_id,restaurant_guid,business_date)
 REFERENCES toast_pilot_days(business_id,restaurant_guid,business_date)
);
ALTER TABLE toast_verified_report_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_verified_report_evidence FROM PUBLIC,anon,authenticated;
ALTER FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 RENAME TO toast_promote_reconciled_day_pre_independent_verification;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day_pre_independent_verification(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
CREATE FUNCTION toast_promote_reconciled_day(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_business_date date,p_expected_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM toast_verified_report_evidence e
  WHERE e.business_id=p_business_id AND e.restaurant_guid=p_restaurant_guid
   AND e.business_date=p_business_date AND e.staged_sha256=p_expected_sha256
   AND e.verification_source='independently_checked_toast_report'
   AND e.checked_at>now()-interval '24 hours')
 THEN RAISE EXCEPTION 'independent Toast report evidence required'; END IF;
 RETURN toast_promote_reconciled_day_pre_independent_verification(
  p_business_id,p_restaurant_guid,p_location_id,p_business_date,p_expected_sha256);
END $$;
REVOKE ALL ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_promote_reconciled_day(uuid,uuid,uuid,date,text) TO service_role;
