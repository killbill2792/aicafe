-- Supervisor P1/P3 authoritative evidence foundation.
-- Additive migration. NEVER run on live DB without owner approval and a ledger review.
-- The business-wide epoch is deliberately conservative: ANY tracked canonical write
-- invalidates ALL prior source manifests for that café. No inferred completeness.
--
-- Invariants:
--  * only PostgreSQL AFTER STATEMENT triggers advance revisions, in the same
--    transaction as canonical source mutations (including CSV/Toast promotions)
--  * one SQL STABLE snapshot function executes as ONE statement-level MVCC read
--    (not multiple PostgREST queries) and returns the epoch with the data
--  * owner auth and tenant binding are checked in the function; no generic SQL
--    nor revision-update API is granted to authenticated clients
--  * bounded row limits + explicit truncation/import status; neither an absent
--    row nor an imported row is evidence of complete POS coverage
CREATE TABLE public.p1_business_source_epochs (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
ALTER TABLE public.p1_business_source_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.p1_business_source_epochs FROM PUBLIC, anon, authenticated;
-- A baseline is an actual committed DB state after migration, not a promise that
-- sources are complete or that historical data has proof.
INSERT INTO public.p1_business_source_epochs (business_id, revision)
SELECT id, 1 FROM public.businesses ON CONFLICT (business_id) DO NOTHING;

CREATE FUNCTION public.p1_touch_business_epoch(p_business_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'source revision requires a scoped business' USING ERRCODE='23502';
  END IF;
  -- A deleted business has no later readable source snapshot. FK cascade
  -- deletion must not resurrect its epoch or prevent owner-directed removal.
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.p1_business_source_epochs AS epoch(business_id,revision)
    VALUES (p_business_id,1)
  ON CONFLICT (business_id)
  DO UPDATE SET revision = epoch.revision + 1;
END $$;
REVOKE ALL ON FUNCTION public.p1_touch_business_epoch(uuid)
  FROM PUBLIC, anon, authenticated;

-- SECURITY DEFINER is restricted to the trigger's FIXED, reviewable table
-- registration below. Transition tables allow one bump per business/statement,
-- not one bump per CSV row. Sorted business locks avoid reverse-order deadlocks.
CREATE FUNCTION public.p1_track_source_statement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  relation text := TG_ARGV[0];
  fk text := TG_ARGV[1];
  statement text;
  part text;
  names text[] := ARRAY[]::text[];
  transition_name text;
  business uuid;
BEGIN
  IF relation NOT IN ('businesses','direct','ingredients','menu_items',
      'orders','expenses') THEN
    RAISE EXCEPTION 'unsupported revision source registration';
  END IF;
  IF relation='direct' AND fk<>'business_id' THEN
    RAISE EXCEPTION 'unsupported direct source identity';
  END IF;
  IF (relation='ingredients' AND fk<>'ingredient_id') OR
     (relation='menu_items' AND fk<>'menu_item_id') OR
     (relation='orders' AND fk<>'order_id') OR
     (relation='expenses' AND fk<>'expense_id') THEN
    RAISE EXCEPTION 'unsupported child source identity';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN names:=array_append(names,'new_rows'); END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN names:=array_append(names,'old_rows'); END IF;
  FOREACH transition_name IN ARRAY names LOOP
    IF relation='businesses' THEN
      part:=format('SELECT id AS business_id FROM %I',transition_name);
    ELSIF relation='direct' THEN
      part:=format('SELECT business_id FROM %I',transition_name);
    ELSE
      part:=format('SELECT p.business_id FROM %I n JOIN public.%I p ON p.id=n.%I',
        transition_name,relation,fk);
    END IF;
    statement:=CASE WHEN statement IS NULL THEN part
      ELSE statement || ' UNION ALL ' || part END;
  END LOOP;
  FOR business IN EXECUTE
    'SELECT DISTINCT business_id FROM ('||statement||
    ') scoped WHERE business_id IS NOT NULL ORDER BY business_id'
  LOOP
    PERFORM public.p1_touch_business_epoch(business);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.p1_track_source_statement()
  FROM PUBLIC, anon, authenticated;

-- A table missing from an older installation is never silently ignored. That
-- migration must be reconciled first. Explicitly list only source tables that
-- exist in latest main; no application code or import RPC modifications.
DO $$
DECLARE
  t text;
  mode text;
  fk text;
  op text;
  transitions text;
  mappings text[][] := ARRAY[
    ARRAY['businesses','businesses','id'],
    ARRAY['locations','direct','business_id'],
    ARRAY['menu_items','direct','business_id'],
    ARRAY['ingredients','direct','business_id'],
    ARRAY['ingredient_prices','ingredients','ingredient_id'],
    ARRAY['ingredient_unit_conversions','ingredients','ingredient_id'],
    ARRAY['recipe_lines','menu_items','menu_item_id'],
    ARRAY['modifier_recipes','direct','business_id'],
    ARRAY['employees','direct','business_id'],
    ARRAY['timecards','direct','business_id'],
    ARRAY['orders','direct','business_id'],
    ARRAY['order_lines','orders','order_id'],
    ARRAY['daily_rollups','direct','business_id'],
    ARRAY['processing_fee_daily_candidates','direct','business_id'],
    ARRAY['processing_fee_daily_facts','direct','business_id'],
    ARRAY['pos_connections','direct','business_id'],
    ARRAY['staff_schedules','direct','business_id'],
    ARRAY['ai_supplier_quotes','direct','business_id'],
    ARRAY['ai_team_rules','direct','business_id'],
    ARRAY['csv_import_mappings','direct','business_id'],
    ARRAY['expenses','direct','business_id'],
    ARRAY['expense_lines','expenses','expense_id'],
    ARRAY['recurring_costs','direct','business_id'],
    ARRAY['recovery_order','direct','business_id'],
    ARRAY['uploads','direct','business_id'],
    ARRAY['csv_import_jobs','direct','business_id'],
    ARRAY['csv_sales_import_groups','direct','business_id'],
    ARRAY['csv_labor_import_rows','direct','business_id']
  ];
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY mappings LOOP
    t:=spec[1]; mode:=spec[2]; fk:=spec[3];
    IF to_regclass('public.'||t) IS NULL THEN
      RAISE EXCEPTION 'unavailable tracked source table: %',t;
    END IF;
    FOREACH op IN ARRAY ARRAY['INSERT','UPDATE','DELETE']::text[] LOOP
      transitions:=CASE op
        WHEN 'INSERT' THEN 'REFERENCING NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'REFERENCING OLD TABLE AS old_rows'
        ELSE 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'
      END;
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON public.%I %s FOR EACH STATEMENT '||
        'EXECUTE FUNCTION public.p1_track_source_statement(%L,%L)',
        'p1_revision_'||lower(op),op,t,transitions,mode,fk);
    END LOOP;
  END LOOP;
END $$;

-- Bounded records and a completeness signal are returned together in ONE
-- SQL STABLE call. STABLE subqueries share the initiating statement snapshot;
-- PostgreSQL cannot mix a new price with an old epoch in this statement.
-- SQL SECURITY DEFINER bypasses RLS but checks the exact authenticated owner
-- and selected non-demo business first; every subordinate query filters that ID.
CREATE FUNCTION public.p1_authoritative_source_snapshot(p_business_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  WITH allowed AS MATERIALIZED (
    SELECT b.id, b.timezone, b.currency,
           b.payroll_tax_rate, b.payroll_tax_rate_status,
           b.payroll_tax_rate_source
    FROM public.businesses b
    WHERE b.id=p_business_id AND b.is_demo=false
      AND EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.business_id=b.id AND m.user_id=auth.uid()
          AND m.role='owner'
      )
  ),
  epoch AS (
    SELECT e.revision FROM public.p1_business_source_epochs e
    JOIN allowed b ON b.id=e.business_id
  ),
  records AS (
    SELECT
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,name,price_cents,is_active,category
         FROM public.menu_items WHERE business_id=p_business_id
         ORDER BY id LIMIT 501) q) AS menu,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,name,base_unit FROM public.ingredients
         WHERE business_id=p_business_id ORDER BY id LIMIT 501) q) AS ingredients,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT ip.id,ip.ingredient_id,ip.effective_from,
          ip.cost_per_base_unit_micros,ip.source
         FROM public.ingredient_prices ip
         JOIN public.ingredients i ON i.id=ip.ingredient_id
         WHERE i.business_id=p_business_id ORDER BY ip.id LIMIT 501) q) AS prices,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT rl.menu_item_id,rl.ingredient_id,rl.quantity
         FROM public.recipe_lines rl JOIN public.menu_items mi
           ON mi.id=rl.menu_item_id
         WHERE mi.business_id=p_business_id
         ORDER BY rl.menu_item_id,rl.ingredient_id LIMIT 501) q) AS recipes,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,display_name,active,role,default_hourly_wage_cents,
          wage_period,wage_amount_cents
         FROM public.employees WHERE business_id=p_business_id
         ORDER BY id LIMIT 501) q) AS wages,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT business_date,net_sales_cents,orders_count,drinks_count,
          ingredients_cents,staff_wages_cents,staff_tax_cents,
          card_fees_cents,sales_data_status,staff_tax_status
         FROM public.daily_rollups WHERE business_id=p_business_id
         ORDER BY business_date DESC LIMIT 367) q) AS daily,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,spent_on,amount_cents,status,source,category_code
         FROM public.expenses WHERE business_id=p_business_id
         ORDER BY spent_on DESC,id LIMIT 501) q) AS expenses,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,label,amount_cents,frequency,is_estimate,active_from,active_to
         FROM public.recurring_costs WHERE business_id=p_business_id
         ORDER BY id LIMIT 501) q) AS recurring,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT id,kind,status,date_from,date_to,group_count
         FROM public.csv_import_jobs WHERE business_id=p_business_id
         ORDER BY created_at DESC,id LIMIT 101) q) AS imports
  )
  SELECT jsonb_build_object(
    'contract','p1.authoritative_snapshot.v1',
    'businessId',b.id,
    'revision',e.revision::text,
    'timezone',b.timezone,'currency',b.currency,
    'payroll',jsonb_build_object('rate',b.payroll_tax_rate,
       'status',b.payroll_tax_rate_status,
       'source',b.payroll_tax_rate_source),
    'sources',jsonb_build_object(
       'menu',coalesce(r.menu,'[]'::jsonb),
       'ingredients',coalesce(r.ingredients,'[]'::jsonb),
       'ingredientPrices',coalesce(r.prices,'[]'::jsonb),
       'recipes',coalesce(r.recipes,'[]'::jsonb),
       'employees',coalesce(r.wages,'[]'::jsonb),
       'dailyRollups',coalesce(r.daily,'[]'::jsonb),
       'expenses',coalesce(r.expenses,'[]'::jsonb),
       'recurringCosts',coalesce(r.recurring,'[]'::jsonb),
       'imports',coalesce(r.imports,'[]'::jsonb)),
    'truncated',jsonb_build_object(
       'menu',jsonb_array_length(coalesce(r.menu,'[]'::jsonb))>500,
       'ingredients',jsonb_array_length(coalesce(r.ingredients,'[]'::jsonb))>500,
       'ingredientPrices',jsonb_array_length(coalesce(r.prices,'[]'::jsonb))>500,
       'recipes',jsonb_array_length(coalesce(r.recipes,'[]'::jsonb))>500,
       'employees',jsonb_array_length(coalesce(r.wages,'[]'::jsonb))>500,
       'dailyRollups',jsonb_array_length(coalesce(r.daily,'[]'::jsonb))>366,
       'expenses',jsonb_array_length(coalesce(r.expenses,'[]'::jsonb))>500,
       'recurringCosts',jsonb_array_length(coalesce(r.recurring,'[]'::jsonb))>500,
       'imports',jsonb_array_length(coalesce(r.imports,'[]'::jsonb))>100),
    'coverage','not_proven_by_revision'
  )
  FROM allowed b CROSS JOIN epoch e CROSS JOIN records r;
$$;
REVOKE ALL ON FUNCTION public.p1_authoritative_source_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p1_authoritative_source_snapshot(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.p1_authoritative_source_snapshot(uuid) IS
  'One MVCC statement: DB-backed revision and bounded owner-only source facts. Does NOT assert import/POS completeness; no application-level multi-request snapshot.';
