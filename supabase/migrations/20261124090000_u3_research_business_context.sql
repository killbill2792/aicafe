-- Extend the existing tenant-scoped research surface, without creating new
-- stores, writers, provider reads or credentials. All views are read-only to
-- the model role and have the same signed scope/RLS as the original surface.
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

GRANT SELECT (id,timezone,currency,opened_on,payroll_tax_rate,payroll_tax_rate_status,
 payroll_tax_rate_source,target_operating_margin,target_operating_margin_status,
 owner_monthly_payroll_extras_cents,owner_monthly_payroll_extras_updated_at,
 target_ingredient_cost_rate,target_ingredient_cost_rate_status)
 ON public.businesses TO aicafe_research_view_owner;
CREATE POLICY u3_research_scoped_select ON public.businesses
 FOR SELECT TO aicafe_research_view_owner
 USING (id=(SELECT u3_research_private.business_id()));
CREATE VIEW u3_research.cafe_settings WITH (security_barrier=true) AS
 SELECT timezone,currency,opened_on,payroll_tax_rate,payroll_tax_rate_status,
 payroll_tax_rate_source,target_operating_margin,target_operating_margin_status,
 owner_monthly_payroll_extras_cents,owner_monthly_payroll_extras_updated_at,
 target_ingredient_cost_rate,target_ingredient_cost_rate_status
 FROM public.businesses WHERE id=(SELECT u3_research_private.business_id());
COMMENT ON VIEW u3_research.cafe_settings IS
 'One café settings record. Currency governs monetary values unless source states otherwise. Rates are fractions, not percentage points. Owner payroll extras are monthly; respect effective information and status; NULL means unknown, not zero.';

GRANT SELECT (open_hours) ON public.locations TO aicafe_research_view_owner;
CREATE VIEW u3_research.opening_hours WITH (security_barrier=true) AS
 SELECT l.id AS location_id,l.timezone,d.weekday,
 CASE WHEN jsonb_typeof(l.open_hours->d.weekday)='array' THEN
   CASE WHEN jsonb_array_length(l.open_hours->d.weekday)=0 THEN 'closed'
        WHEN i.ordinality IS NOT NULL THEN 'open' ELSE 'unknown' END
 ELSE 'unknown' END AS hours_status,
 i.ordinality AS interval_index,i.open_time,i.close_time
 FROM public.locations l
 CROSS JOIN (VALUES ('sun'),('mon'),('tue'),('wed'),('thu'),('fri'),('sat')) d(weekday)
 LEFT JOIN LATERAL (
   SELECT x.ordinality,x.value->>0 AS open_time,x.value->>1 AS close_time
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.open_hours->d.weekday)='array'
          THEN l.open_hours->d.weekday ELSE '[]'::jsonb END)
     WITH ORDINALITY x(value,ordinality)
   WHERE CASE WHEN jsonb_typeof(x.value)='array' THEN jsonb_array_length(x.value)=2 ELSE false END
     AND x.value->>0 ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
     AND x.value->>1 ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
 ) i ON true
 WHERE l.business_id=(SELECT u3_research_private.business_id());
COMMENT ON VIEW u3_research.opening_hours IS
 'One configured weekly location opening interval or one closed/unknown weekday row; join locations by location_id. Local HH:mm, overnight intervals may cross midnight. Unknown is not closed; regular hours are not historical actual trading or exception hours.';

GRANT SELECT (breaks,schedule_id,pos_owner_edited) ON public.timecards TO aicafe_research_view_owner;
CREATE VIEW u3_research.timecard_breaks WITH (security_barrier=true) AS
 SELECT t.id AS timecard_id,t.employee_id,t.clock_in,t.clock_out,t.source_type,t.source_provider,
 t.pos_last_synced_at,
 CASE WHEN jsonb_typeof(t.breaks)='array' THEN jsonb_array_length(t.breaks) END AS recorded_break_count,
 b.ordinality AS break_index,
 CASE WHEN b.value->>'start' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN b.value->>'start' END AS break_start,
 CASE WHEN b.value->>'end' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN b.value->>'end' END AS break_end,
 CASE WHEN jsonb_typeof(b.value->'paid')='boolean' THEN (b.value->>'paid')::boolean END AS paid
 FROM public.timecards t
 LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.breaks)='array'
    THEN t.breaks ELSE '[]'::jsonb END) WITH ORDINALITY b(value,ordinality) ON true
 WHERE t.business_id=(SELECT u3_research_private.business_id())
   AND (SELECT u3_research_private.mode()) IN ('owner','durable');
COMMENT ON VIEW u3_research.timecard_breaks IS
 'Owner-only recorded timecard break entries, joined to timecards by timecard_id; no raw provider JSON. A timecard with no break entry still appears once with NULL break_index. No recorded break is not proof no break occurred. Distinguish incomplete punches, actual clock observations and schedules; timestamp text is provider-recorded ISO format, not invented duration.';

GRANT SELECT (business_id,fact_key,value_json,unit,period_scope,source,created_at,updated_at,superseded_at)
 ON public.owner_facts TO aicafe_research_view_owner;
CREATE POLICY u3_research_scoped_select ON public.owner_facts
 FOR SELECT TO aicafe_research_view_owner
 USING (business_id=(SELECT u3_research_private.business_id()) AND superseded_at IS NULL
 AND (SELECT u3_research_private.mode()) IN ('owner','durable'));
CREATE VIEW u3_research.current_owner_facts WITH (security_barrier=true) AS
 SELECT fact_key,unit,period_scope,source,created_at,updated_at,
 jsonb_typeof(value_json) AS value_type,
 CASE WHEN jsonb_typeof(value_json)='number' THEN (value_json#>>'{}')::numeric END AS numeric_value,
 CASE WHEN jsonb_typeof(value_json)='boolean' THEN (value_json#>>'{}')::boolean END AS boolean_value
 FROM public.owner_facts WHERE business_id=(SELECT u3_research_private.business_id())
 AND superseded_at IS NULL AND (SELECT u3_research_private.mode()) IN ('owner','durable');
COMMENT ON VIEW u3_research.current_owner_facts IS
 'Current owner-stated facts, never superseded or forgotten values. Numeric and boolean scalars only; unit and period_scope determine interpretation. Other fact types remain available through existing authorized owner context. Owner statements are not automatically verified actuals.';

GRANT SELECT (business_id,business_date,amount_cents,status,source_type,provider,updated_at)
 ON public.processing_fee_daily_facts TO aicafe_research_view_owner;
CREATE POLICY u3_research_scoped_select ON public.processing_fee_daily_facts
 FOR SELECT TO aicafe_research_view_owner
 USING (business_id=(SELECT u3_research_private.business_id()));
CREATE VIEW u3_research.processing_fee_daily_facts WITH (security_barrier=true) AS
 SELECT business_date,amount_cents,status,source_type,provider,updated_at
 FROM public.processing_fee_daily_facts WHERE business_id=(SELECT u3_research_private.business_id());
COMMENT ON VIEW u3_research.processing_fee_daily_facts IS
 'One selected daily processing fee fact; status and source distinguish actual from estimated or missing. Do not add the same fees from rollups and this source. No processor credentials or raw metadata.';

GRANT SELECT (code,qb_account_type,is_running_cost) ON public.expense_categories TO aicafe_research_view_owner;
CREATE POLICY u3_research_scoped_select ON public.expense_categories
 FOR SELECT TO aicafe_research_view_owner USING ((SELECT u3_research_private.business_id()) IS NOT NULL);
CREATE VIEW u3_research.expense_categories WITH (security_barrier=true) AS
 SELECT code,qb_account_type,is_running_cost FROM public.expense_categories
 WHERE (SELECT u3_research_private.business_id()) IS NOT NULL;
COMMENT ON VIEW u3_research.expense_categories IS
 'Shared accounting category definitions, not a café-specific list of incurred costs. Join actual expense and recurring-cost categories; classify fixed or variable using real business evidence and assumptions.';

-- Do not give the model raw table privileges or change the existing role.
DO $$
DECLARE rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['cafe_settings','opening_hours','timecard_breaks',
 'current_owner_facts','processing_fee_daily_facts','expense_categories'] LOOP
  EXECUTE format('ALTER VIEW u3_research.%I OWNER TO aicafe_research_view_owner',rel);
  EXECUTE format('REVOKE ALL ON u3_research.%I FROM PUBLIC, anon, authenticated',rel);
  EXECUTE format('GRANT SELECT ON u3_research.%I TO aicafe_research',rel);
 END LOOP;
END $$;
REVOKE aicafe_research_view_owner FROM postgres;
