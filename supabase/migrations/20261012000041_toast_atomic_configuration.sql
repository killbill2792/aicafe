-- Unmerged Toast foundation follow-up. Apply after 20261012000040 only in staging.
-- Never execute automatically against production.
ALTER TABLE toast_api_credentials ADD COLUMN IF NOT EXISTS retry_after timestamptz;
ALTER TABLE toast_api_credentials ADD COLUMN IF NOT EXISTS configuration_version bigint NOT NULL DEFAULT 1;

-- Single transaction for encrypted credentials + all location mappings.
-- Caller must be a service-role server route that has already verified owner membership.
CREATE OR REPLACE FUNCTION toast_save_configuration(
 p_business_id uuid, p_origin text, p_client_id text, p_secret_enc text, p_mappings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_origin IS NULL OR p_client_id IS NULL OR p_secret_enc IS NULL OR
    jsonb_typeof(p_mappings)<>'array' OR jsonb_array_length(p_mappings)<1 OR
    jsonb_array_length(p_mappings)>50
 THEN RAISE EXCEPTION 'invalid configuration'; END IF;
 SELECT count(*) INTO n FROM jsonb_to_recordset(p_mappings)
 AS r(location_id uuid,restaurant_guid uuid);
 IF n<> (SELECT count(DISTINCT location_id) FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid))
 OR n<> (SELECT count(DISTINCT restaurant_guid) FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid))
 OR n<> (SELECT count(*) FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid)
    JOIN locations l ON l.id=r.location_id AND l.business_id=p_business_id)
 OR NOT EXISTS(SELECT 1 FROM businesses WHERE id=p_business_id AND NOT is_demo)
 THEN RAISE EXCEPTION 'invalid mappings or business'; END IF;
 INSERT INTO toast_api_credentials (
  business_id,api_origin,client_id,client_secret_enc, bearer_token_enc,bearer_expires_at,
  auth_lease_until,auth_lease_nonce, state,last_verified_at,last_error_category,
  retry_after,updated_at,configuration_version)
 VALUES(p_business_id,p_origin,p_client_id,p_secret_enc,NULL,NULL,NULL,NULL,
  'configured',NULL,NULL,NULL,now(),1)
 ON CONFLICT (business_id) DO UPDATE SET
 api_origin=excluded.api_origin,client_id=excluded.client_id,client_secret_enc=excluded.client_secret_enc,
 bearer_token_enc=NULL,bearer_expires_at=NULL,
 auth_lease_until=NULL,auth_lease_nonce=NULL,state='configured',
 last_verified_at=NULL,last_error_category=NULL,retry_after=NULL,updated_at=now(),
 configuration_version=toast_api_credentials.configuration_version+1;
 -- All mapping changes commit or roll back with credentials.
 DELETE FROM toast_location_mappings WHERE business_id=p_business_id;
 INSERT INTO toast_location_mappings (business_id,location_id,restaurant_guid,verified_at)
 SELECT p_business_id,r.location_id,r.restaurant_guid,NULL
 FROM jsonb_to_recordset(p_mappings) AS r(location_id uuid,restaurant_guid uuid);
END $$;

-- Avoid clearing a bearer token refreshed by another request/instance.
-- A successful lease claim after invalidation is still required before logging in.
CREATE OR REPLACE FUNCTION toast_invalidate_token_if_match(
 p_business_id uuid,p_expected_ciphertext text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE toast_api_credentials
 SET bearer_token_enc=NULL,bearer_expires_at=NULL
 WHERE business_id=p_business_id AND bearer_token_enc=p_expected_ciphertext;
 RETURN FOUND;
END $$;

-- Tokens cannot overwrite rotated credentials: rotation clears the nonce.
-- Recheck ownership AND unexpired lease before allowing any write.
CREATE OR REPLACE FUNCTION toast_commit_auth_token(
 p_business_id uuid,p_lease_nonce uuid,p_ciphertext text,p_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE toast_api_credentials SET bearer_token_enc=p_ciphertext,
 bearer_expires_at=p_expires_at,auth_lease_until=NULL,auth_lease_nonce=NULL
 WHERE business_id=p_business_id AND auth_lease_nonce=p_lease_nonce
 AND auth_lease_until>now() AND state<>'disconnected';
 RETURN FOUND;
END $$;

-- Only service role may execute any provider-credential RPC.
REVOKE ALL ON FUNCTION toast_save_configuration(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_invalidate_token_if_match(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_commit_auth_token(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_save_configuration(uuid,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION toast_invalidate_token_if_match(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION toast_commit_auth_token(uuid,uuid,text,timestamptz) TO service_role;
REVOKE ALL ON toast_api_credentials,toast_location_mappings FROM PUBLIC,anon,authenticated;
