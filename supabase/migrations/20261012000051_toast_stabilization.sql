-- Toast stabilization. Strictly additive override after original 40-50 migrations.
-- No production application. Never weaken existing foreign keys or grants.
ALTER TABLE toast_modified_orders_staging ADD COLUMN IF NOT EXISTS provider_modified_at timestamptz;
ALTER TABLE toast_labor_entries ADD COLUMN IF NOT EXISTS provider_modified_at timestamptz;

ALTER TABLE toast_modified_orders_staging DROP CONSTRAINT IF EXISTS toast_modified_orders_staging_state_check;
ALTER TABLE toast_modified_orders_staging ADD CONSTRAINT toast_modified_orders_staging_state_check
 CHECK(state IN ('completed','open','reopened','voided','deleted','refunded','ambiguous','review_required'));
ALTER TABLE toast_modified_orders_staging DROP CONSTRAINT IF EXISTS toast_modified_orders_staging_check;
ALTER TABLE toast_modified_orders_staging ADD CONSTRAINT toast_modified_orders_staging_check
 CHECK ((state='completed' AND normalized_order IS NOT NULL)
 OR (state<>'completed' AND normalized_order IS NULL));

CREATE OR REPLACE FUNCTION toast_store_order_fact(
 p_business_id uuid,p_restaurant_guid uuid,p_order_guid uuid,
 p_modified_at timestamptz,p_state text,p_normalized_order jsonb,p_event_guid uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed boolean;
BEGIN
 IF p_modified_at IS NULL OR p_state NOT IN
 ('completed','open','reopened','voided','deleted','refunded','ambiguous')
 OR (p_state='completed') IS DISTINCT FROM (p_normalized_order IS NOT NULL)
 OR NOT EXISTS (SELECT 1 FROM toast_location_mappings
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid)
 THEN RAISE EXCEPTION 'invalid Toast order fact'; END IF;
 INSERT INTO toast_modified_orders_staging (
  business_id,restaurant_guid,order_guid,provider_modified_at,
  source_event_guid,state,normalized_order,last_checked_at)
 VALUES(p_business_id,p_restaurant_guid,p_order_guid,p_modified_at,
  p_event_guid,p_state,p_normalized_order,now())
 ON CONFLICT (business_id,restaurant_guid,order_guid)
 DO UPDATE SET provider_modified_at=EXCLUDED.provider_modified_at,
   state=EXCLUDED.state,normalized_order=EXCLUDED.normalized_order,
   source_event_guid=EXCLUDED.source_event_guid,last_checked_at=now()
 WHERE toast_modified_orders_staging.provider_modified_at IS NULL
 OR toast_modified_orders_staging.provider_modified_at<EXCLUDED.provider_modified_at
 OR (toast_modified_orders_staging.provider_modified_at=EXCLUDED.provider_modified_at
    AND toast_modified_orders_staging.state='completed' AND EXCLUDED.state<>'completed');
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_store_order_fact(uuid,uuid,uuid,timestamptz,text,jsonb,uuid) TO service_role;

-- Clock-in-time history cannot erase a newer modified-time correction.
CREATE OR REPLACE FUNCTION toast_stage_labor_entries(p_business_id uuid,p_restaurant_guid uuid,
 p_location_id uuid,p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100
 OR NOT EXISTS (SELECT 1 FROM toast_location_mappings WHERE business_id=p_business_id
  AND restaurant_guid=p_restaurant_guid AND location_id=p_location_id AND verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid labor batch'; END IF;
 INSERT INTO toast_labor_entries(
  business_id,restaurant_guid,location_id,external_time_entry_id,external_employee_id,
  clock_in,clock_out,hourly_wage_cents,wage_status,breaks,deleted,provider_modified_at,fetched_at)
 SELECT p_business_id,p_restaurant_guid,p_location_id,t.external_time_entry_id,t.external_employee_id,
  t.clock_in,t.clock_out,t.hourly_wage_cents,t.wage_status,t.breaks,t.deleted,
  t.provider_modified_at,now()
 FROM jsonb_to_recordset(p_rows) AS t (
  external_time_entry_id uuid,external_employee_id uuid,clock_in timestamptz,clock_out timestamptz,
  hourly_wage_cents bigint,wage_status text,breaks jsonb,deleted boolean,provider_modified_at timestamptz)
 ON CONFLICT (business_id,restaurant_guid,external_time_entry_id) DO UPDATE SET
  external_employee_id=EXCLUDED.external_employee_id,clock_in=EXCLUDED.clock_in,
  clock_out=EXCLUDED.clock_out,hourly_wage_cents=EXCLUDED.hourly_wage_cents,
  wage_status=EXCLUDED.wage_status,breaks=EXCLUDED.breaks,deleted=EXCLUDED.deleted,
  provider_modified_at=EXCLUDED.provider_modified_at,fetched_at=now()
 WHERE (EXCLUDED.provider_modified_at IS NOT NULL AND
      (toast_labor_entries.provider_modified_at IS NULL OR
       EXCLUDED.provider_modified_at>=toast_labor_entries.provider_modified_at))
 OR (EXCLUDED.provider_modified_at IS NULL AND toast_labor_entries.provider_modified_at IS NULL);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION toast_stage_labor_entries(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_stage_labor_entries(uuid,uuid,uuid,jsonb) TO service_role;

-- One transaction for the WHOLE completed schedule window. Toast selects shifts
-- only when BOTH scheduled start and end fall inside the requested dates.
CREATE OR REPLACE FUNCTION toast_apply_schedule_window(
 p_business_id uuid,p_restaurant_guid uuid,p_location_id uuid,
 p_since timestamptz,p_until timestamptz,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_until<=p_since OR p_until>p_since+interval '30 days'
 OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>5000
 OR NOT EXISTS (SELECT 1 FROM toast_location_mappings
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND location_id=p_location_id AND verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid schedule window'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows)
    AS r(external_shift_id text,scheduled_start timestamptz,scheduled_end timestamptz)
    WHERE scheduled_start<p_since OR scheduled_end>=p_until OR scheduled_end<=scheduled_start)
 THEN RAISE EXCEPTION 'incomplete schedule window'; END IF;
 -- Rechecking a complete window can mark previously-present provider rows absent.
 -- Never touch owner/manual schedules or dates outside the strict full-window predicate.
 UPDATE pos_scheduled_shifts SET deleted=true,last_synced_at=now()
 WHERE business_id=p_business_id AND location_id=p_location_id AND provider='toast'
 AND scheduled_start>=p_since AND scheduled_end<p_until
 AND NOT EXISTS (
   SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(external_shift_id text)
   WHERE r.external_shift_id=pos_scheduled_shifts.external_shift_id);
 INSERT INTO pos_scheduled_shifts(
 business_id,location_id,provider,external_shift_id,external_employee_id,external_job_id,
 scheduled_start,scheduled_end,deleted,last_synced_at)
 SELECT p_business_id,p_location_id,'toast',r.external_shift_id,r.external_employee_id,
 r.external_job_id,r.scheduled_start,r.scheduled_end,r.deleted,now()
 FROM jsonb_to_recordset(p_rows) AS r(
  external_shift_id text,external_employee_id text,external_job_id text,
  scheduled_start timestamptz,scheduled_end timestamptz,deleted boolean)
 ON CONFLICT (business_id,provider,external_shift_id) DO UPDATE SET
  location_id=EXCLUDED.location_id,external_employee_id=EXCLUDED.external_employee_id,
  external_job_id=EXCLUDED.external_job_id,scheduled_start=EXCLUDED.scheduled_start,
  scheduled_end=EXCLUDED.scheduled_end,deleted=EXCLUDED.deleted,last_synced_at=now();
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION toast_apply_schedule_window(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_apply_schedule_window(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)
 TO service_role;

-- Replaces the unsafe DELETE+INSERT configuration RPC with a diff-based transaction.
-- Existing FK-referenced mappings cannot be removed; fail and roll back credential rotation.
CREATE OR REPLACE FUNCTION toast_save_configuration(
 p_business_id uuid,p_origin text,p_client_id text,p_secret_enc text,p_mappings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF p_origin IS NULL OR length(p_origin)<8 OR p_client_id IS NULL OR p_secret_enc IS NULL
 OR jsonb_typeof(p_mappings)<>'array' OR jsonb_array_length(p_mappings) NOT BETWEEN 1 AND 50
 OR NOT EXISTS(SELECT 1 FROM businesses WHERE id=p_business_id AND is_demo=false)
 THEN RAISE EXCEPTION 'invalid Toast configuration'; END IF;
 SELECT count(*) INTO n FROM jsonb_to_recordset(p_mappings)
 AS r(location_id uuid,restaurant_guid uuid);
 IF n<>(SELECT count(DISTINCT location_id) FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid))
 OR n<>(SELECT count(DISTINCT restaurant_guid) FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid))
 OR n<>(SELECT count(*) FROM jsonb_to_recordset(p_mappings) AS r(location_id uuid,restaurant_guid uuid)
 JOIN locations l ON l.id=r.location_id AND l.business_id=p_business_id)
 THEN RAISE EXCEPTION 'cross-tenant or duplicate mappings'; END IF;
 -- Deliberate explicit check gives a stable failure, and keeps old creds intact on rollback.
 IF EXISTS (SELECT 1 FROM toast_location_mappings m
 WHERE m.business_id=p_business_id
 AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(p_mappings)
    AS r(location_id uuid,restaurant_guid uuid)
    WHERE r.location_id=m.location_id AND r.restaurant_guid=m.restaurant_guid)
 AND (EXISTS(SELECT 1 FROM toast_pilot_days x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)
   OR EXISTS(SELECT 1 FROM toast_labor_entries x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)
   OR EXISTS(SELECT 1 FROM toast_order_events x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)
   OR EXISTS(SELECT 1 FROM toast_modified_orders_staging x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)
   OR EXISTS(SELECT 1 FROM toast_sync_health x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)
   OR EXISTS(SELECT 1 FROM toast_poll_leases x WHERE x.business_id=m.business_id
             AND x.restaurant_guid=m.restaurant_guid)))
 THEN RAISE EXCEPTION 'location has dependent Toast facts: archive with explicit review'; END IF;
 INSERT INTO toast_api_credentials(business_id,api_origin,client_id,client_secret_enc,state)
 VALUES(p_business_id,p_origin,p_client_id,p_secret_enc,'configured')
 ON CONFLICT(business_id) DO UPDATE SET api_origin=EXCLUDED.api_origin,
 client_id=EXCLUDED.client_id,client_secret_enc=EXCLUDED.client_secret_enc,
 bearer_token_enc=NULL,bearer_expires_at=NULL,auth_lease_until=NULL,auth_lease_nonce=NULL,
 retry_after=NULL,state='configured',last_verified_at=NULL,last_error_category=NULL,
 configuration_version=toast_api_credentials.configuration_version+1,updated_at=now();
 DELETE FROM toast_location_mappings m WHERE business_id=p_business_id
 AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_mappings)
 AS r(location_id uuid,restaurant_guid uuid)
 WHERE r.location_id=m.location_id AND r.restaurant_guid=m.restaurant_guid);
 INSERT INTO toast_location_mappings(business_id,location_id,restaurant_guid,verified_at)
 SELECT p_business_id,r.location_id,r.restaurant_guid,NULL
 FROM jsonb_to_recordset(p_mappings) AS r(location_id uuid,restaurant_guid uuid)
 ON CONFLICT(business_id,restaurant_guid) DO UPDATE
 SET verified_at=NULL
 WHERE toast_location_mappings.location_id=EXCLUDED.location_id;
 IF (SELECT count(*) FROM toast_location_mappings WHERE business_id=p_business_id)<>n
 THEN RAISE EXCEPTION 'mapping conflict requires manual review'; END IF;
 UPDATE toast_location_mappings SET verified_at=NULL WHERE business_id=p_business_id;
END $$;
REVOKE ALL ON FUNCTION toast_save_configuration(uuid,text,text,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_save_configuration(uuid,text,text,text,jsonb) TO service_role;
