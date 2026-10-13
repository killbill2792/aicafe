-- Additional defense against rapid repeated Toast authentication attempts.
-- Migration 41 is required before this additive migration.
ALTER TABLE toast_api_credentials
  ADD COLUMN IF NOT EXISTS last_auth_attempt_at timestamptz;
-- A refresh lease claim is denied while Toast has asked the app to wait or while
-- an earlier login is still pending. Existing bearer reuse still happens first.
CREATE OR REPLACE FUNCTION toast_claim_auth_lease(p_business_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE claimed uuid;
BEGIN
 UPDATE toast_api_credentials
 SET auth_lease_until=now()+interval '30 seconds',
     auth_lease_nonce=gen_random_uuid(),last_auth_attempt_at=now()
 WHERE business_id=p_business_id
   AND (retry_after IS NULL OR retry_after<=now())
   AND (auth_lease_until IS NULL OR auth_lease_until<now())
 RETURNING auth_lease_nonce INTO claimed;
 RETURN claimed;
END $$;
REVOKE ALL ON FUNCTION toast_claim_auth_lease(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_claim_auth_lease(uuid) TO service_role;
