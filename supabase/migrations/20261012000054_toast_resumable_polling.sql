-- Toast additive recovery journal and one-page-per-lease order worker.
-- Pure staging; no live schedule, no canonical revenue or payroll mutation.
CREATE TABLE toast_poll_recovery (
 business_id uuid NOT NULL,
 restaurant_guid uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('orders','attendance')),
 state text NOT NULL CHECK(state IN ('requires_historical_backfill','backfilling','failed','complete')),
 missing_since timestamptz NOT NULL,
 missing_until timestamptz NOT NULL,
 next_since timestamptz NOT NULL,
 last_failure_category text,
 started_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 PRIMARY KEY(business_id,restaurant_guid,kind),
 FOREIGN KEY(business_id,restaurant_guid)
  REFERENCES toast_location_mappings(business_id,restaurant_guid),
 CHECK(missing_since<missing_until AND next_since>=missing_since AND next_since<=missing_until)
);
ALTER TABLE toast_poll_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_poll_recovery FROM PUBLIC,anon,authenticated;

CREATE TABLE toast_order_poll_progress (
 business_id uuid NOT NULL,
 restaurant_guid uuid NOT NULL,
 window_since timestamptz NOT NULL,
 window_until timestamptz NOT NULL,
 next_page integer NOT NULL DEFAULT 1 CHECK(next_page BETWEEN 1 AND 1000),
 is_recovery boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid),
 FOREIGN KEY(business_id,restaurant_guid)
  REFERENCES toast_location_mappings(business_id,restaurant_guid),
 CHECK(window_since<window_until AND window_until<=window_since+interval '30 days')
);
ALTER TABLE toast_order_poll_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_order_poll_progress FROM PUBLIC,anon,authenticated;

-- Called only with an owned, unexpired poll lease. Recover from the EXACT prior
-- cursor; never skip old history by clamping to the most recent 30 days.
CREATE FUNCTION toast_begin_poll_recovery(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,p_nonce uuid,p_until timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE prior_cursor timestamptz;
BEGIN
 IF p_kind NOT IN ('orders','attendance') OR p_until>now()
 OR NOT EXISTS(SELECT 1 FROM toast_poll_leases
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
    AND kind=p_kind AND lease_nonce=p_nonce AND lease_until>now())
 THEN RAISE EXCEPTION 'Toast recovery requires owned active lease'; END IF;
 SELECT CASE WHEN p_kind='orders' THEN last_order_poll_at ELSE last_time_entry_poll_at END
 INTO prior_cursor FROM toast_sync_health
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid FOR UPDATE;
 IF prior_cursor IS NULL OR p_until-prior_cursor<=interval '30 days'
 THEN RETURN false; END IF;
 IF prior_cursor<'2015-12-01'::timestamptz THEN
   RAISE EXCEPTION 'Toast backfill before supported provider history';
 END IF;
 INSERT INTO toast_poll_recovery
 (business_id,restaurant_guid,kind,state,missing_since,missing_until,next_since)
 VALUES(p_business_id,p_restaurant_guid,p_kind,'requires_historical_backfill',
  prior_cursor,p_until,prior_cursor)
 ON CONFLICT(business_id,restaurant_guid,kind) DO UPDATE SET
  state=EXCLUDED.state,missing_since=EXCLUDED.missing_since,
  missing_until=EXCLUDED.missing_until,next_since=EXCLUDED.next_since,
  started_at=now(),updated_at=now(),completed_at=NULL,last_failure_category=NULL
 WHERE toast_poll_recovery.state='complete';
 RETURN true;
END $$;

-- Atomically stage exactly one OrdersBulk page and checkpoint its index.
-- Lease verification, versioned upserts, recovery and cursor are ONE transaction.
CREATE FUNCTION toast_stage_order_poll_page(
 p_business_id uuid,p_restaurant_guid uuid,p_nonce uuid,
 p_since timestamptz,p_until timestamptz,p_page integer,
 p_facts jsonb,p_has_more boolean,p_is_recovery boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE progress toast_order_poll_progress%ROWTYPE;
 rec jsonb; recovery toast_poll_recovery%ROWTYPE; rowcount integer; finished boolean;
BEGIN
 IF p_since>=p_until OR p_until>now() OR p_until-p_since>interval '30 days'
 OR p_page<1 OR p_page>1000 OR jsonb_typeof(p_facts)<>'array'
 OR jsonb_array_length(p_facts)>100
 OR (p_has_more AND (jsonb_array_length(p_facts)<>100 OR p_page>=1000))
 OR NOT EXISTS(SELECT 1 FROM toast_poll_leases
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND kind='orders' AND lease_nonce=p_nonce AND lease_until>now())
 THEN RAISE EXCEPTION 'invalid or expired Toast order page'; END IF;

 SELECT * INTO progress FROM toast_order_poll_progress
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid FOR UPDATE;
 IF FOUND THEN
   IF progress.window_since<>p_since OR progress.window_until<>p_until
   OR progress.next_page<>p_page OR progress.is_recovery<>p_is_recovery
   THEN RAISE EXCEPTION 'order page checkpoint mismatch'; END IF;
 ELSE
   IF p_page<>1 THEN RAISE EXCEPTION 'first page required'; END IF;
   INSERT INTO toast_order_poll_progress(
     business_id,restaurant_guid,window_since,window_until,next_page,is_recovery)
   VALUES(p_business_id,p_restaurant_guid,p_since,p_until,1,p_is_recovery);
 END IF;

 IF p_is_recovery THEN
   SELECT * INTO recovery FROM toast_poll_recovery
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
     AND kind='orders' FOR UPDATE;
   IF NOT FOUND OR recovery.state='complete' OR
      recovery.next_since<>p_since OR p_until>recovery.missing_until
   THEN RAISE EXCEPTION 'order recovery window mismatch'; END IF;
 END IF;
 FOR rec IN SELECT value FROM jsonb_array_elements(p_facts) LOOP
   IF (rec->>'modifiedAt')::timestamptz<p_since OR
     (rec->>'modifiedAt')::timestamptz>=p_until THEN
      RAISE EXCEPTION 'out-of-window order response'; END IF;
   PERFORM toast_store_order_fact(
    p_business_id,p_restaurant_guid,(rec->>'orderGuid')::uuid,
    (rec->>'modifiedAt')::timestamptz,rec->>'state',rec->'normalizedOrder',NULL);
 END LOOP;
 IF p_has_more THEN
   UPDATE toast_order_poll_progress SET next_page=p_page+1,updated_at=now()
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid;
 ELSE
   DELETE FROM toast_order_poll_progress
   WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid;
   IF p_is_recovery THEN
     UPDATE toast_poll_recovery SET next_since=p_until,
       state=CASE WHEN p_until>=missing_until THEN 'complete' ELSE 'backfilling' END,
       completed_at=CASE WHEN p_until>=missing_until THEN now() ELSE NULL END,
       last_failure_category=NULL,updated_at=now()
     WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid AND kind='orders';
   END IF;
 END IF;
 SELECT toast_finish_poll(p_business_id,p_restaurant_guid,'orders',p_nonce,
     CASE WHEN p_has_more THEN NULL ELSE p_until END,true,NULL,NULL)
 INTO finished;
 IF NOT finished THEN RAISE EXCEPTION 'order page lease expired'; END IF;
 RETURN jsonb_build_object('complete',NOT p_has_more,
   'nextPage',CASE WHEN p_has_more THEN p_page+1 ELSE NULL END,
   'staged',jsonb_array_length(p_facts));
END $$;

-- Attendance staging has already completed; fence completion + cursor + recovery
-- in one Postgres transaction. Never use the future end of a partial response.
CREATE FUNCTION toast_complete_attendance_recovery(
 p_business_id uuid,p_restaurant_guid uuid,p_nonce uuid,
 p_since timestamptz,p_until timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r toast_poll_recovery%ROWTYPE; done boolean;
BEGIN
 IF p_since>=p_until OR p_until-p_since>interval '30 days' THEN
  RAISE EXCEPTION 'invalid attendance window'; END IF;
 SELECT * INTO r FROM toast_poll_recovery
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
  AND kind='attendance' FOR UPDATE;
 IF NOT FOUND OR r.state='complete' OR r.next_since<>p_since OR p_until>r.missing_until
 THEN RAISE EXCEPTION 'attendance backfill checkpoint mismatch'; END IF;
 UPDATE toast_poll_recovery SET next_since=p_until,
  state=CASE WHEN p_until>=missing_until THEN 'complete' ELSE 'backfilling' END,
  completed_at=CASE WHEN p_until>=missing_until THEN now() ELSE NULL END,
  last_failure_category=NULL,updated_at=now()
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid AND kind='attendance';
 SELECT toast_finish_poll(p_business_id,p_restaurant_guid,'attendance',
   p_nonce,p_until,true,NULL,NULL) INTO done;
 IF NOT done THEN RAISE EXCEPTION 'attendance backfill lease expired'; END IF;
 RETURN true;
END $$;

CREATE FUNCTION toast_mark_poll_recovery_failure(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,p_nonce uuid,p_failure text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM toast_poll_leases WHERE business_id=p_business_id
  AND restaurant_guid=p_restaurant_guid AND kind=p_kind
  AND lease_nonce=p_nonce AND lease_until>now())
 THEN RAISE EXCEPTION 'backfill failure requires active lease'; END IF;
 UPDATE toast_poll_recovery SET state='failed',last_failure_category=left(p_failure,64),
  updated_at=now() WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
   AND kind=p_kind AND state<>'complete';
END $$;

REVOKE ALL ON FUNCTION toast_begin_poll_recovery(uuid,uuid,text,uuid,timestamptz)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_stage_order_poll_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,boolean)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_complete_attendance_recovery(uuid,uuid,uuid,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_mark_poll_recovery_failure(uuid,uuid,text,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_begin_poll_recovery(uuid,uuid,text,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION toast_stage_order_poll_page(uuid,uuid,uuid,timestamptz,timestamptz,integer,jsonb,boolean,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION toast_complete_attendance_recovery(uuid,uuid,uuid,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION toast_mark_poll_recovery_failure(uuid,uuid,text,uuid,text) TO service_role;
