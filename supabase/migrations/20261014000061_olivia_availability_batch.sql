-- Olivia PR 1B: immutable owner-intent batch writes, no assigned shifts or payroll writes.
-- Production migration is MANUAL owner action; CI applies only to disposable Supabase.

-- Location-specific civil time for later deterministic DST conversion; NULL
-- means inherit business.timezone, never invent a fixed UTC offset.
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS timezone text;
CREATE OR REPLACE FUNCTION public.scheduling_check_location_timezone()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.timezone IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone
 ) THEN RAISE EXCEPTION 'unknown IANA timezone' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scheduling_validate_location_timezone
 BEFORE INSERT OR UPDATE OF timezone ON public.locations
 FOR EACH ROW EXECUTE FUNCTION public.scheduling_check_location_timezone();

-- An advisory lock on the canonical employee serializes ALL changes to their
-- availability, including legacy per-record RPC creates and owner RLS updates/
-- deletes. The batch takes the identical lock BEFORE reading its entire scope.
-- A business+employee composite FK guarantees the lock target's tenant.
CREATE OR REPLACE FUNCTION public.scheduling_lock_availability_employee()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_old uuid; v_new uuid; v_business uuid;
BEGIN
 v_old:=CASE WHEN TG_OP<>'INSERT' THEN OLD.employee_id ELSE NULL END;
 v_new:=CASE WHEN TG_OP<>'DELETE' THEN NEW.employee_id ELSE NULL END;
 v_business:=CASE WHEN TG_OP='DELETE' THEN OLD.business_id ELSE NEW.business_id END;
 -- Sorted locks avoid deadlocks when an existing record changes employee.
 IF v_old IS NOT NULL AND v_new IS NOT NULL AND v_old<>v_new THEN
   PERFORM 1 FROM public.employees WHERE business_id=v_business
     AND id=LEAST(v_old,v_new) FOR UPDATE;
   PERFORM 1 FROM public.employees WHERE business_id=v_business
     AND id=GREATEST(v_old,v_new) FOR UPDATE;
 ELSE
   PERFORM 1 FROM public.employees WHERE business_id=v_business
     AND id=coalesce(v_old,v_new) FOR UPDATE;
 END IF;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'unknown availability employee' USING ERRCODE='23503';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER scheduling_lock_employee
 BEFORE INSERT OR UPDATE OR DELETE ON public.staff_availability_rules
 FOR EACH ROW EXECUTE FUNCTION public.scheduling_lock_availability_employee();
CREATE TRIGGER scheduling_lock_employee
 BEFORE INSERT OR UPDATE OR DELETE ON public.staff_availability_exceptions
 FOR EACH ROW EXECUTE FUNCTION public.scheduling_lock_availability_employee();
REVOKE ALL ON FUNCTION public.scheduling_lock_availability_employee() FROM PUBLIC,anon,authenticated;

CREATE TABLE public.scheduling_availability_batch_receipts (
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 request_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('availability_rule','availability_exception')),
 employee_id uuid NOT NULL,
 location_id uuid,
 edit_scope jsonb NOT NULL,
 expected jsonb NOT NULL,
 desired jsonb NOT NULL,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,request_key),
 FOREIGN KEY (business_id,employee_id) REFERENCES public.employees(business_id,id),
 FOREIGN KEY (business_id,location_id) REFERENCES public.locations(business_id,id)
);
ALTER TABLE public.scheduling_availability_batch_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduling_availability_batch_receipts FROM PUBLIC,anon,authenticated;

-- A complete replacement of ONE recurring effective-date set (all weekdays)
-- or ONE date's exceptions. Every record outside that scope is untouched.
-- Client never chooses SQL table/columns, actor/business identity or record IDs.
CREATE FUNCTION public.scheduling_save_availability_batch(
 p_business_id uuid, p_employee_id uuid, p_location_id uuid, p_kind text,
 p_scope jsonb, p_expected jsonb, p_desired jsonb, p_request_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 v_table text; v_keys text[];
 v_affected int; v_receipt public.scheduling_availability_batch_receipts%ROWTYPE;
 v_actual jsonb; v_expected jsonb; v_result jsonb:='[]'::jsonb;
 v_item jsonb; v_record jsonb; v_old jsonb;
 v_id uuid; v_rev integer; v_response jsonb;
 v_set_clause text;

BEGIN
 IF p_business_id IS NULL OR auth.uid() IS NULL
   OR NOT public.scheduling_is_owner(p_business_id)
   OR NOT EXISTS(SELECT 1 FROM public.businesses
                  WHERE id=p_business_id AND is_demo=false) THEN
   RAISE EXCEPTION 'scheduling owner authorization required' USING ERRCODE='42501';
 END IF;
 IF p_request_key IS NULL OR p_employee_id IS NULL
    OR jsonb_typeof(p_scope)<>'object' OR jsonb_typeof(p_expected)<>'array'
    OR jsonb_typeof(p_desired)<>'array'
    OR jsonb_array_length(p_expected)>200 OR jsonb_array_length(p_desired)>200 THEN
   RAISE EXCEPTION 'invalid batch request' USING ERRCODE='22023';
 END IF;
 IF p_kind='availability_rule' THEN
   v_table:='staff_availability_rules';
   IF (p_scope ? 'effective_from') IS NOT TRUE OR
      EXISTS(SELECT 1 FROM jsonb_object_keys(p_scope) AS k(x)
             WHERE k.x NOT IN('effective_from','effective_to')) THEN
     RAISE EXCEPTION 'invalid recurring scope' USING ERRCODE='22023';
   END IF;
   v_keys:=ARRAY['employee_id','location_id','day_of_week','start_local','end_local',
     'overnight','effective_from','effective_to','source','confirmation'];
 ELSEIF p_kind='availability_exception' THEN
   v_table:='staff_availability_exceptions';
   IF (SELECT count(*) FROM jsonb_object_keys(p_scope))<>1 OR NOT (p_scope ? 'local_date') THEN
     RAISE EXCEPTION 'invalid exception scope' USING ERRCODE='22023';
   END IF;
   v_keys:=ARRAY['employee_id','location_id','local_date','exception_type',
     'start_local','end_local','overnight','max_minutes','source','confirmation'];
 ELSE
   RAISE EXCEPTION 'invalid availability batch kind' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employees
               WHERE business_id=p_business_id AND id=p_employee_id) THEN
   RAISE EXCEPTION 'employee not found' USING ERRCODE='23503';
 END IF;

 -- Lock canonical employee row: per-record trigger acquires same row lock.
 PERFORM 1 FROM public.employees
  WHERE business_id=p_business_id AND id=p_employee_id FOR UPDATE;
 -- Claim receipt under PostgreSQL's UNIQUE locking; concurrent same-key
 -- requests wait for winner and return its immutable original result.
 INSERT INTO public.scheduling_availability_batch_receipts
  (business_id,request_key,kind,employee_id,location_id,edit_scope,expected,desired)
 VALUES(p_business_id,p_request_key,p_kind,p_employee_id,p_location_id,
        p_scope,p_expected,p_desired)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_affected=ROW_COUNT;
 SELECT * INTO v_receipt
 FROM public.scheduling_availability_batch_receipts
 WHERE business_id=p_business_id AND request_key=p_request_key FOR UPDATE;
 IF v_affected=0 THEN
   IF v_receipt.kind<>p_kind OR v_receipt.employee_id<>p_employee_id OR
     v_receipt.location_id IS DISTINCT FROM p_location_id OR
     v_receipt.edit_scope<>p_scope OR v_receipt.expected<>p_expected OR
     v_receipt.desired<>p_desired THEN
     RETURN jsonb_build_object('conflict',true);
   END IF;
   IF v_receipt.result IS NULL THEN
     RAISE EXCEPTION 'incomplete batch receipt' USING ERRCODE='40001';
   END IF;
   RETURN jsonb_build_object('replayed',true,'records',v_receipt.result);
 END IF;

 -- Verify exact scope contents, including phantom additions/deletions, BEFORE
 -- any change. Sorting canonicalizes expected record ordering.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) e
           WHERE jsonb_typeof(e)<>'object' OR NOT (e ? 'id') OR NOT (e ? 'revision')) THEN
   RAISE EXCEPTION 'invalid expected manifest' USING ERRCODE='22023';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id', e->>'id', 'revision',(e->>'revision')::integer) ORDER BY e->>'id'),'[]'::jsonb)
 INTO v_expected FROM jsonb_array_elements(p_expected) e;
 IF p_kind='availability_rule' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'revision',revision)
       ORDER BY id::text),'[]'::jsonb)
   INTO v_actual FROM public.staff_availability_rules
   WHERE business_id=p_business_id AND employee_id=p_employee_id
     AND location_id IS NOT DISTINCT FROM p_location_id
     AND effective_from=(p_scope->>'effective_from')::date
     AND effective_to IS NOT DISTINCT FROM (p_scope->>'effective_to')::date;
 ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id::text,'revision',revision)
       ORDER BY id::text),'[]'::jsonb)
   INTO v_actual FROM public.staff_availability_exceptions
   WHERE business_id=p_business_id AND employee_id=p_employee_id
     AND location_id IS NOT DISTINCT FROM p_location_id
     AND local_date=(p_scope->>'local_date')::date;
 END IF;
 IF v_actual<>v_expected THEN
   RETURN jsonb_build_object('conflict',true);
 END IF;

 -- Every desired item is {id?:existingId,data:completeRecord}. Existing IDs
 -- must appear exactly once in current manifest; creates may not supply IDs.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_desired) e
   WHERE jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'data')<>'object'
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) k(x) WHERE k.x NOT IN ('id','data')))
   OR (SELECT count(*) FROM jsonb_array_elements(p_desired) e WHERE e ? 'id')
     <> (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(p_desired) e WHERE e ? 'id') THEN
   RAISE EXCEPTION 'invalid desired record list' USING ERRCODE='22023';
 END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_desired) LOOP
   v_record:=v_item->'data';
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_record) AS k(x)
             WHERE NOT k.x=ANY(v_keys)) THEN
     RAISE EXCEPTION 'forbidden batch record key' USING ERRCODE='22023';
   END IF;
   IF v_record->>'employee_id' IS DISTINCT FROM p_employee_id::text
     OR ((v_record ? 'location_id') AND
         (v_record->>'location_id') IS DISTINCT FROM p_location_id::text)
     OR (p_location_id IS NOT NULL AND
         v_record->>'location_id' IS DISTINCT FROM p_location_id::text) THEN
     RAISE EXCEPTION 'batch employee/location mismatch' USING ERRCODE='22023';
   END IF;
   IF (p_kind='availability_rule' AND (
        v_record->>'effective_from' IS DISTINCT FROM p_scope->>'effective_from' OR
        coalesce(v_record->>'effective_to','') IS DISTINCT FROM coalesce(p_scope->>'effective_to','')))
     OR (p_kind='availability_exception' AND
        v_record->>'local_date' IS DISTINCT FROM p_scope->>'local_date') THEN
     RAISE EXCEPTION 'batch date scope mismatch' USING ERRCODE='22023';
   END IF;
   IF v_item ? 'id' THEN
     v_id:=(v_item->>'id')::uuid;
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) e
                   WHERE e->>'id'=v_id::text) THEN
       RAISE EXCEPTION 'record outside expected scope' USING ERRCODE='22023';
     END IF;
     SELECT string_agg(format('%I = r.%I',k,k),', ' ORDER BY k)
     INTO v_set_clause FROM jsonb_object_keys(v_record) AS j(k);
     EXECUTE format(
        'UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) r
         WHERE t.business_id=$2 AND t.id=$3 RETURNING t.id,t.revision',
         v_table,v_set_clause,v_table)
       USING v_record,p_business_id,v_id INTO v_id,v_rev;
     IF v_id IS NULL THEN
       RAISE EXCEPTION 'stale batch record' USING ERRCODE='40001';
     END IF;
   ELSE
     -- Existing RPC validates allowlist, FK, audit, owner, confirmed stamping.
     SELECT public.scheduling_create_foundation(
       p_business_id,p_kind,gen_random_uuid(),v_record) INTO v_response;
     IF v_response->>'id' IS NULL THEN
       RAISE EXCEPTION 'batch create failed' USING ERRCODE='22023';
     END IF;
     v_id:=(v_response->>'id')::uuid;
     v_rev:=(v_response->>'revision')::int;
   END IF;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_id,'revision',v_rev));
 END LOOP;

 -- Delete only expected records excluded from desired; verified scope and
 -- employee lock ensure no stale/foreign deletion, preserve per-row audit.
 FOR v_old IN SELECT value FROM jsonb_array_elements(p_expected) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_desired) e
                 WHERE e->>'id'=v_old->>'id') THEN
     EXECUTE format('DELETE FROM public.%I WHERE business_id=$1 AND id=$2',v_table)
       USING p_business_id,(v_old->>'id')::uuid;
   END IF;
 END LOOP;
 UPDATE public.scheduling_availability_batch_receipts
 SET result=v_result WHERE business_id=p_business_id AND request_key=p_request_key;
 RETURN jsonb_build_object('replayed',false,'records',v_result);
END $$;
REVOKE ALL ON FUNCTION public.scheduling_save_availability_batch(
 uuid,uuid,uuid,text,jsonb,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_save_availability_batch(
 uuid,uuid,uuid,text,jsonb,jsonb,jsonb,uuid) TO authenticated;
