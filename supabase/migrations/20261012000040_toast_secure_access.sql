-- Toast Standard API read-only credential foundation. NOT automatically applied.
-- Existing Square, orders, schedules and POS connection records are not modified.
CREATE TABLE IF NOT EXISTS toast_api_credentials (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  api_origin text NOT NULL,
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,
  bearer_token_enc text,
  bearer_expires_at timestamptz,
  auth_lease_until timestamptz,
  state text NOT NULL DEFAULT 'configured'
    CHECK (state IN ('configured','verified','missing_permissions','needs_reconnect','sync_failed','stale','disconnected')),
  last_verified_at timestamptz,
  last_error_category text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toast_location_mappings (
  business_id uuid NOT NULL REFERENCES toast_api_credentials(business_id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (business_id,restaurant_guid),
  UNIQUE (business_id,location_id)
);
-- A composite foreign key stops cross-business locations even when server code makes a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS locations_business_id_id_toast_key ON locations(business_id,id);
ALTER TABLE toast_location_mappings
  ADD CONSTRAINT toast_mapping_same_business FOREIGN KEY (business_id,location_id)
  REFERENCES locations(business_id,id);
ALTER TABLE toast_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE toast_location_mappings ENABLE ROW LEVEL SECURITY;
-- Intentionally no authenticated/anon RLS policies for encrypted credential records.
-- Only service-role server code may read these tables; owner authorization is checked in routes.
REVOKE ALL ON toast_api_credentials FROM anon, authenticated;
REVOKE ALL ON toast_location_mappings FROM anon, authenticated;

-- Atomic distributed lease across independent Vercel workers prevents login storms.
CREATE OR REPLACE FUNCTION toast_claim_auth_lease(p_business_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 UPDATE toast_api_credentials
 SET auth_lease_until = now() + interval '15 seconds'
 WHERE business_id=p_business_id
   AND (auth_lease_until IS NULL OR auth_lease_until < now());
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION toast_claim_auth_lease(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION toast_claim_auth_lease(uuid) TO service_role;

-- One atomic replacement of explicitly selected mappings, rejecting invalid or cross-tenant IDs.
CREATE OR REPLACE FUNCTION toast_replace_location_mappings(p_business_id uuid,p_mappings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_mappings) <> 'array' OR jsonb_array_length(p_mappings) < 1
 THEN RAISE EXCEPTION 'at least one location mapping required'; END IF;
 SELECT count(*) INTO n FROM jsonb_to_recordset(p_mappings)
   AS r(location_id uuid,restaurant_guid uuid);
 IF n <> (SELECT count(DISTINCT location_id) FROM jsonb_to_recordset(p_mappings)
             AS r(location_id uuid,restaurant_guid uuid))
    OR n <> (SELECT count(DISTINCT restaurant_guid) FROM jsonb_to_recordset(p_mappings)
             AS r(location_id uuid,restaurant_guid uuid))
    OR n <> (SELECT count(*) FROM jsonb_to_recordset(p_mappings)
              AS r(location_id uuid,restaurant_guid uuid)
              JOIN locations l ON l.id=r.location_id AND l.business_id=p_business_id)
 THEN RAISE EXCEPTION 'invalid or duplicate location mappings'; END IF;
 DELETE FROM toast_location_mappings WHERE business_id=p_business_id;
 INSERT INTO toast_location_mappings(business_id,location_id,restaurant_guid)
 SELECT p_business_id,r.location_id,r.restaurant_guid
 FROM jsonb_to_recordset(p_mappings) AS r(location_id uuid,restaurant_guid uuid);
END $$;
REVOKE ALL ON FUNCTION toast_replace_location_mappings(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION toast_replace_location_mappings(uuid,jsonb) TO service_role;
