-- Toast legacy-RPC lockdown after adding the independent report gate.
-- No existing migration is rewritten; apply after 52 only.
-- SECURITY DEFINER wrappers remain able to call the functions they own,
-- but service-role client connections must not bypass the latest safety gates.
REVOKE EXECUTE ON FUNCTION toast_promote_reconciled_day_legacy(uuid,uuid,uuid,date,text)
 FROM service_role;
REVOKE EXECUTE ON FUNCTION toast_promote_reconciled_day_pre_independent_verification(uuid,uuid,uuid,date,text)
 FROM service_role;
REVOKE EXECUTE ON FUNCTION toast_replace_location_mappings(uuid,jsonb)
 FROM service_role;
-- A privileged, explicitly authorized operator must be able to attach reviewed
-- evidence; neither anon nor authenticated ever receives this permission.
GRANT SELECT,INSERT ON toast_verified_report_evidence TO service_role;
REVOKE ALL ON toast_verified_report_evidence FROM PUBLIC,anon,authenticated;
