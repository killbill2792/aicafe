-- Toast roster/catalog staging and explicit human-reviewed canonical identity links.
-- No menu, recipe, ingredient or existing payroll rows are modified by staging.
CREATE TABLE toast_employee_directory(
 business_id uuid NOT NULL,restaurant_guid uuid NOT NULL,employee_guid uuid NOT NULL,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
 deleted boolean NOT NULL DEFAULT false,
 linked_employee_id uuid REFERENCES employees(id) ON DELETE RESTRICT,
 linked_at timestamptz,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,employee_guid),
 FOREIGN KEY(business_id,restaurant_guid)
 REFERENCES toast_location_mappings(business_id,restaurant_guid),
 CHECK((linked_employee_id IS NULL)=(linked_at IS NULL))
);
ALTER TABLE toast_employee_directory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_employee_directory FROM PUBLIC,anon,authenticated;
CREATE FUNCTION toast_stage_employee_roster(
 p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>500
 OR NOT EXISTS(SELECT 1 FROM toast_location_mappings
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND verified_at IS NOT NULL) THEN RAISE EXCEPTION 'invalid Toast roster'; END IF;
 INSERT INTO toast_employee_directory(business_id,restaurant_guid,employee_guid,
 display_name,deleted,fetched_at)
 SELECT p_business_id,p_restaurant_guid,x.employee_guid,x.display_name,x.deleted,now()
 FROM jsonb_to_recordset(p_rows) x(employee_guid uuid,display_name text,deleted boolean)
 ON CONFLICT(business_id,restaurant_guid,employee_guid) DO UPDATE SET
 display_name=EXCLUDED.display_name,deleted=EXCLUDED.deleted,fetched_at=now();
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
CREATE FUNCTION toast_link_employee(
 p_business_id uuid,p_restaurant_guid uuid,p_employee_guid uuid,p_canonical_employee_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM employees WHERE business_id=p_business_id
 AND id=p_canonical_employee_id) THEN RAISE EXCEPTION 'cross-tenant employee mapping'; END IF;
 UPDATE toast_employee_directory SET linked_employee_id=p_canonical_employee_id,
 linked_at=now()
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND employee_guid=p_employee_guid AND deleted=false
 AND (linked_employee_id IS NULL OR linked_employee_id=p_canonical_employee_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'employee requires mapping review'; END IF;
 RETURN true;
END $$;

CREATE TABLE toast_catalog_facts (
 business_id uuid NOT NULL,restaurant_guid uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('item','modifier')),
 provider_guid uuid NOT NULL,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 category text,price_cents bigint,pricing_strategy text,
 modifier_group_guids jsonb NOT NULL DEFAULT '[]'::jsonb,
 linked_menu_item_id uuid REFERENCES menu_items(id) ON DELETE RESTRICT,
 linked_modifier_recipe_id uuid REFERENCES modifier_recipes(id) ON DELETE RESTRICT,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,kind,provider_guid),
 FOREIGN KEY(business_id,restaurant_guid) REFERENCES toast_location_mappings(business_id,restaurant_guid),
 CHECK(jsonb_typeof(modifier_group_guids)='array'),
 CHECK ((kind='item' AND linked_modifier_recipe_id IS NULL)
 OR (kind='modifier' AND linked_menu_item_id IS NULL))
);
CREATE TABLE toast_catalog_price_versions(
 business_id uuid NOT NULL,restaurant_guid uuid NOT NULL,kind text NOT NULL,
 provider_guid uuid NOT NULL,price_fingerprint text NOT NULL,
 price_cents bigint,name text NOT NULL,category text,
 observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,restaurant_guid,kind,provider_guid,price_fingerprint),
 FOREIGN KEY(business_id,restaurant_guid,kind,provider_guid)
 REFERENCES toast_catalog_facts(business_id,restaurant_guid,kind,provider_guid)
);
ALTER TABLE toast_catalog_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE toast_catalog_price_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON toast_catalog_facts,toast_catalog_price_versions
 FROM PUBLIC,anon,authenticated;
CREATE FUNCTION toast_stage_catalog(
 p_business_id uuid,p_restaurant_guid uuid,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>500
 OR NOT EXISTS(SELECT 1 FROM toast_location_mappings
 WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
 AND verified_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_rows)
 AS x(kind text,provider_guid uuid,name text,modifier_group_guids jsonb)
 WHERE x.kind NOT IN ('item','modifier') OR x.name IS NULL OR length(x.name)>200
 OR x.provider_guid IS NULL OR jsonb_typeof(x.modifier_group_guids)<>'array')
 THEN RAISE EXCEPTION 'invalid Toast catalog batch'; END IF;
 INSERT INTO toast_catalog_facts(business_id,restaurant_guid,kind,provider_guid,
 name,category,price_cents,pricing_strategy,modifier_group_guids,fetched_at)
 SELECT p_business_id,p_restaurant_guid,x.kind,x.provider_guid,x.name,
 x.category,x.price_cents,x.pricing_strategy,x.modifier_group_guids,now()
 FROM jsonb_to_recordset(p_rows) AS x(
 kind text,provider_guid uuid,name text,category text,price_cents bigint,
 pricing_strategy text,modifier_group_guids jsonb)
 ON CONFLICT(business_id,restaurant_guid,kind,provider_guid) DO UPDATE SET
 name=EXCLUDED.name,category=EXCLUDED.category,price_cents=EXCLUDED.price_cents,
 pricing_strategy=EXCLUDED.pricing_strategy,
 modifier_group_guids=EXCLUDED.modifier_group_guids,fetched_at=now();
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO toast_catalog_price_versions(business_id,restaurant_guid,kind,
 provider_guid,price_fingerprint,price_cents,name,category)
 SELECT p_business_id,p_restaurant_guid,x.kind,x.provider_guid,
 md5(jsonb_build_array(x.name,x.category,x.price_cents,x.pricing_strategy)::text),
 x.price_cents,x.name,x.category
 FROM jsonb_to_recordset(p_rows) AS x(kind text,provider_guid uuid,name text,
 category text,price_cents bigint,pricing_strategy text)
 ON CONFLICT DO NOTHING;
 RETURN n;
END $$;
CREATE FUNCTION toast_link_catalog(
 p_business_id uuid,p_restaurant_guid uuid,p_kind text,p_provider_guid uuid,p_canonical_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_kind='item' THEN
  IF NOT EXISTS(SELECT 1 FROM menu_items WHERE business_id=p_business_id
   AND id=p_canonical_id) THEN RAISE EXCEPTION 'cross-tenant product mapping'; END IF;
  UPDATE toast_catalog_facts SET linked_menu_item_id=p_canonical_id
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
  AND kind='item' AND provider_guid=p_provider_guid
  AND (linked_menu_item_id IS NULL OR linked_menu_item_id=p_canonical_id);
 ELSIF p_kind='modifier' THEN
  IF NOT EXISTS(SELECT 1 FROM modifier_recipes WHERE business_id=p_business_id
   AND id=p_canonical_id) THEN RAISE EXCEPTION 'cross-tenant modifier mapping'; END IF;
  UPDATE toast_catalog_facts SET linked_modifier_recipe_id=p_canonical_id
  WHERE business_id=p_business_id AND restaurant_guid=p_restaurant_guid
  AND kind='modifier' AND provider_guid=p_provider_guid
  AND (linked_modifier_recipe_id IS NULL OR linked_modifier_recipe_id=p_canonical_id);
 ELSE RAISE EXCEPTION 'invalid catalog kind'; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'catalog mapping needs review'; END IF;
 RETURN true;
END $$;

-- Opt-in import of actual, PAID-eligible attendance only after human-approved employee link.
-- Owner/manual timecards and linked recipe/catalog data are never changed.
CREATE FUNCTION toast_import_confirmed_attendance(
 p_business_id uuid,p_restaurant_guid uuid,p_guids jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE rec record; n integer:=0; provider_id text;
BEGIN
 IF jsonb_typeof(p_guids)<>'array' OR jsonb_array_length(p_guids)>100 OR
 NOT EXISTS(SELECT 1 FROM toast_location_mappings WHERE business_id=p_business_id
 AND restaurant_guid=p_restaurant_guid AND verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid import request'; END IF;
 -- A requested GUID without a source row or an explicitly approved employee
 -- link is not a successful no-op. Reject the whole batch before any payroll write.
 IF EXISTS (
   SELECT 1 FROM jsonb_array_elements_text(p_guids) x
   LEFT JOIN toast_labor_entries l ON l.business_id=p_business_id
     AND l.restaurant_guid=p_restaurant_guid AND
       l.external_time_entry_id=x.value::uuid
   LEFT JOIN toast_employee_directory e ON e.business_id=p_business_id
     AND e.restaurant_guid=p_restaurant_guid AND
       e.employee_guid=l.external_employee_id
   WHERE l.external_time_entry_id IS NULL OR e.linked_employee_id IS NULL
 ) THEN RAISE EXCEPTION 'unmatched attendance requires explicit owner mapping'; END IF;
 FOR rec IN SELECT l.*,e.linked_employee_id
 FROM toast_labor_entries l JOIN toast_employee_directory e
 ON e.business_id=l.business_id AND e.restaurant_guid=l.restaurant_guid
 AND e.employee_guid=l.external_employee_id
 WHERE l.business_id=p_business_id AND l.restaurant_guid=p_restaurant_guid
 AND l.external_time_entry_id IN
   (SELECT value::uuid FROM jsonb_array_elements_text(p_guids))
 ORDER BY l.external_time_entry_id LOOP
  IF rec.linked_employee_id IS NULL OR rec.deleted OR rec.clock_out IS NULL
  OR rec.hourly_wage_cents IS NULL OR rec.hourly_wage_cents<=0
  OR rec.wage_status<>'verified' THEN RAISE EXCEPTION 'attendance is not payroll ready'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
   p_business_id::text||':'||rec.linked_employee_id::text,0));
  provider_id:='toast:'||p_restaurant_guid::text||':'||rec.external_time_entry_id::text;
  -- Same canonical ID may already be owner-edited; NEVER overwrite it. Avoid
  -- overlapping manual, schedule or CSV timecards from the same employee.
  IF EXISTS(SELECT 1 FROM timecards t WHERE t.business_id=p_business_id
   AND t.employee_id=rec.linked_employee_id AND
   t.pos_timecard_id IS DISTINCT FROM provider_id
   AND tstzrange(t.clock_in,coalesce(t.clock_out,t.clock_in+interval '24 hours'),'[)')
    && tstzrange(rec.clock_in,rec.clock_out,'[)'))
  THEN RAISE EXCEPTION 'owner/imported shift overlap requires review'; END IF;
  INSERT INTO timecards(business_id,employee_id,pos_timecard_id,clock_in,clock_out,
    hourly_wage_cents,breaks,source_type,source_provider)
  VALUES(p_business_id,rec.linked_employee_id,provider_id,rec.clock_in,rec.clock_out,
    rec.hourly_wage_cents,rec.breaks,'connected_pos','Toast')
  ON CONFLICT(business_id,pos_timecard_id) DO NOTHING;
  IF FOUND THEN n:=n+1; END IF;
 END LOOP;
 IF n<jsonb_array_length(p_guids) AND EXISTS(SELECT 1 FROM
  jsonb_array_elements_text(p_guids) x
  WHERE NOT EXISTS(SELECT 1 FROM toast_labor_entries l
   WHERE l.business_id=p_business_id AND l.restaurant_guid=p_restaurant_guid
   AND l.external_time_entry_id=x.value::uuid))
 THEN RAISE EXCEPTION 'missing attendance records'; END IF;
 RETURN n;
END $$;
-- Reviewer can see a changed imported Toast timecard, but changes NEVER replace owner edits.
CREATE VIEW toast_attendance_review AS
 SELECT l.business_id,l.restaurant_guid,l.external_time_entry_id,
 l.location_id,l.clock_in,l.deleted,l.wage_status,
 e.linked_employee_id,t.id AS canonical_timecard_id,
 CASE WHEN l.deleted THEN 'provider_deleted'
 WHEN e.linked_employee_id IS NULL THEN 'employee_unmatched'
 WHEN l.clock_out IS NULL THEN 'still_open'
 WHEN l.wage_status='missing' THEN 'wage_missing'
 WHEN t.id IS NULL THEN 'not_imported'
 WHEN t.employee_id IS DISTINCT FROM e.linked_employee_id OR
  t.clock_in IS DISTINCT FROM l.clock_in OR t.clock_out IS DISTINCT FROM l.clock_out
  OR t.hourly_wage_cents IS DISTINCT FROM l.hourly_wage_cents
  OR t.breaks IS DISTINCT FROM l.breaks THEN 'review_canonical_owner_correction'
 ELSE 'matched' END AS reconciliation_status
 FROM toast_labor_entries l LEFT JOIN toast_employee_directory e
 ON e.business_id=l.business_id AND e.restaurant_guid=l.restaurant_guid
 AND e.employee_guid=l.external_employee_id
 LEFT JOIN timecards t ON t.business_id=l.business_id
 AND t.pos_timecard_id='toast:'||l.restaurant_guid::text||':'||l.external_time_entry_id::text;
REVOKE ALL ON toast_attendance_review FROM PUBLIC,anon,authenticated;
GRANT SELECT ON toast_attendance_review TO service_role;
REVOKE ALL ON FUNCTION toast_stage_employee_roster(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_link_employee(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_stage_catalog(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_link_catalog(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION toast_import_confirmed_attendance(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION toast_stage_employee_roster(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION toast_link_employee(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION toast_stage_catalog(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION toast_link_catalog(uuid,uuid,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION toast_import_confirmed_attendance(uuid,uuid,jsonb) TO service_role;
