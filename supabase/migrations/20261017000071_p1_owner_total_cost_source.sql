-- Source-contract expansion for owner-entered total product ingredient costs.
-- Safe only after owner review; run as ordinary tracked migration, NEVER
-- manually against production. Price-source precedence remains in lib/calc.
-- The owner cost rows belong to the SAME authorized, single-statement MVCC
-- observation as menu/recipes, and every mutation advances the durable epoch.

CREATE TRIGGER p1_revision_insert AFTER INSERT ON public.menu_item_cost_fallbacks
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.p1_track_source_statement('direct','business_id');
CREATE TRIGGER p1_revision_update AFTER UPDATE ON public.menu_item_cost_fallbacks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.p1_track_source_statement('direct','business_id');
CREATE TRIGGER p1_revision_delete AFTER DELETE ON public.menu_item_cost_fallbacks
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.p1_track_source_statement('direct','business_id');
CREATE TRIGGER p1_forbid_truncate BEFORE TRUNCATE ON public.menu_item_cost_fallbacks
  FOR EACH STATEMENT EXECUTE FUNCTION public.p1_reject_canonical_truncate();

-- Existing manual totals were not previously in the tracked contract.
-- Invalidate any memoized prior revision once per affected tenant.
UPDATE public.p1_business_source_epochs
  SET revision=revision+1
  WHERE business_id IN
    (SELECT DISTINCT business_id FROM public.menu_item_cost_fallbacks);

CREATE OR REPLACE FUNCTION public.p1_authoritative_source_snapshot(p_business_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  WITH allowed AS MATERIALIZED (
    SELECT b.id, b.timezone, b.currency,
           b.payroll_tax_rate, b.payroll_tax_rate_status,
           b.payroll_tax_rate_source
    FROM public.businesses b
    WHERE b.id=p_business_id AND b.is_demo=false
      -- Legacy corruption must not project another tenant's ingredient ID
      -- through an owner-visible recipe. Fail the whole snapshot closed;
      -- never repair or silently omit an invalid recipe link.
      AND NOT EXISTS (
        SELECT 1 FROM public.recipe_lines rl
        JOIN public.menu_items mi ON mi.id=rl.menu_item_id
        LEFT JOIN public.ingredients ri ON ri.id=rl.ingredient_id
        WHERE mi.business_id=b.id AND ri.business_id IS DISTINCT FROM b.id
      )
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
         JOIN public.ingredients ri ON ri.id=rl.ingredient_id
           AND ri.business_id=p_business_id
         WHERE mi.business_id=p_business_id
         ORDER BY rl.menu_item_id,rl.ingredient_id LIMIT 501) q) AS recipes,
      (SELECT jsonb_agg(to_jsonb(q)) FROM
        (SELECT f.menu_item_id,f.cost_cents,f.source_type,f.status,
          f.source_label,f.updated_at
         FROM public.menu_item_cost_fallbacks f
         JOIN public.menu_items mi ON mi.id=f.menu_item_id
           AND mi.business_id=f.business_id
         WHERE f.business_id=p_business_id
         ORDER BY f.menu_item_id LIMIT 501) q) AS owner_totals,
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
       'ownerTotalCosts',coalesce(r.owner_totals,'[]'::jsonb),
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
       'ownerTotalCosts',jsonb_array_length(coalesce(r.owner_totals,'[]'::jsonb))>500,
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
