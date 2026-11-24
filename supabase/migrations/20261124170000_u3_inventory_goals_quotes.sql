-- Read existing authoritative stock, purchasing and goal observations.
-- No new data source, writer, model-facing report or raw payload grant.
set lock_timeout='3s';
set statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

CREATE FUNCTION u3_research_private.inventory_observations_rows()
RETURNS TABLE(source text,source_ref text,status text,business_date date,menu_item_ref text,ingredient_id text,
 ingredient_name text,quantity_unit text,quantity numeric,stock_status text,reported_stock_status text,
 evidence_state text,source_as_of text,checked_at text,source_status text,observed_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.source,r.source_ref,r.status,r.business_date,r.menu_item_ref,r.data->>'ingredient_id',
 r.data->>'ingredient_name',r.data->>'base_unit',
 CASE WHEN r.source='app' OR r.data->>'evidence_state'='observed_current' THEN r.quantity END,
 CASE WHEN r.source='toast' AND r.data->>'evidence_state'='observed_current' THEN r.stock_status END,
 r.data->>'reported_stock_status',
 CASE WHEN r.source='app' THEN 'dated_owner_count' ELSE coalesce(r.data->>'evidence_state','source_unverified') END,
 CASE WHEN r.source='app' THEN r.data->>'count_date' ELSE r.data->>'source_as_of' END,
 r.data->>'checked_at',r.data->>'source_status',
 CASE WHEN jsonb_typeof(r.data->'observed_count')='number' THEN (r.data->>'observed_count')::integer END
 FROM u3_research_private.scope() s JOIN public.cv_inventory r ON r.business_id=s.business_id
 WHERE r.source IN ('app','toast')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.inventory_observations_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.inventory_observations_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.inventory_observations WITH (security_barrier=true) AS SELECT * FROM u3_research_private.inventory_observations_rows();
COMMENT ON VIEW u3_research.inventory_observations IS 'One canonical dated owner count or retained Toast stock observation. Only observed_current Toast quantity/status is usable for a current stock claim; other states have null quantities. Owner counts are dated measurements. No omitted item is implied zero. Do not sum incompatible ingredient units, different dates, or owner counts with menu-item stock. No raw source payload exposed.';
ALTER VIEW u3_research.inventory_observations OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.inventory_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.inventory_observations TO aicafe_research;

CREATE FUNCTION u3_research_private.supplier_quotes_rows()
RETURNS TABLE(id uuid,ingredient_id uuid,supplier_name text,item_name text,price_cents integer,package_count integer,package_unit text,
 source_kind text,quoted_on date,evidence_status text,created_at timestamptz,currency_code text,valid_until date,
 available_status text,available_checked_at date,delivery_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT q.id,q.ingredient_id,q.supplier_name,q.item_name,q.price_cents,q.package_count,q.package_unit,q.source_kind,
 q.quoted_on,q.evidence_status,q.created_at,q.currency_code,q.valid_until,q.available_status,q.available_checked_at,q.delivery_on
 FROM u3_research_private.scope() s JOIN public.ai_supplier_quotes q ON q.business_id=s.business_id AND q.owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.supplier_quotes_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.supplier_quotes_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.supplier_quotes WITH (security_barrier=true) AS SELECT * FROM u3_research_private.supplier_quotes_rows();
COMMENT ON VIEW u3_research.supplier_quotes IS 'Owner-recorded supplier quote per saved quote ID; not a purchase, invoice, guaranteed availability or proof of current price. Compare currency, pack quantity/unit, ingredient ID, date, validity, source and evidence status. Private source URLs and owner identity are not projected.';
ALTER VIEW u3_research.supplier_quotes OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.supplier_quotes FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.supplier_quotes TO aicafe_research;

CREATE FUNCTION u3_research_private.goal_metrics_rows()
RETURNS TABLE(goal_id uuid,title text,status text,created_at timestamptz,monitoring_start_date date,days integer,baseline_from text,baseline_to text,currency text,
 metric_id text,metric_role text,metric_key text,item_id text,item_name text,comparator text,target_kind text,target numeric,checkin_cadence text,checkin_audience text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,p.canonical_effect_payload->>'title',p.status,p.created_at,p.monitoring_start_date,
 CASE WHEN jsonb_typeof(p.canonical_effect_payload->'days')='number' THEN (p.canonical_effect_payload->>'days')::integer END,
 p.canonical_effect_payload->>'baselineFrom',p.canonical_effect_payload->>'baselineTo',p.canonical_effect_payload->>'currency',
 m.v->>'id',m.v->>'role',m.v->>'metricKey',m.v->>'itemId',m.v->>'itemName',m.v->>'comparator',m.v->>'targetKind',
 CASE WHEN jsonb_typeof(m.v->'target')='number' THEN (m.v->>'target')::numeric END,
 p.canonical_effect_payload#>>'{checkin,cadence}',p.canonical_effect_payload#>>'{checkin,audience}'
 FROM u3_research_private.scope() s
 JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.canonical_effect_payload->'metrics')='array'
 THEN p.canonical_effect_payload->'metrics' ELSE '[]'::jsonb END) m(v)
 WHERE s.mode IN ('owner','durable') AND p.capability_id='leo.goal.v1'
 AND m.v->>'metricKey' IN ('net_sales','orders','avg_ticket','item_units','item_revenue')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.goal_metrics_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.goal_metrics_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.goal_metrics WITH (security_barrier=true) AS SELECT * FROM u3_research_private.goal_metrics_rows();
COMMENT ON VIEW u3_research.goal_metrics IS 'One persisted goal metric or guardrail in an owner-owned goal. Goal states distinguish drafts from committed monitoring. Relative targets are percent changes, absolute targets use the metric unit (cents for money, count otherwise). Use goal_observations for stored evidence; missing observations are not zero. No general proposal payload is exposed.';
ALTER VIEW u3_research.goal_metrics OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.goal_metrics FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.goal_metrics TO aicafe_research;

CREATE FUNCTION u3_research_private.goal_observations_rows()
RETURNS TABLE(goal_id uuid,metric_id text,metric_key text,sample_date date,observed_date text,observation_kind text,
 value_cents numeric,value_count numeric,coverage_ratio numeric,evidence_source text,recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT g.goal_id,g.metric_id,g.metric_key,m.business_date,x.observed_date,x.observation_kind,
 CASE WHEN g.metric_key IN ('net_sales','avg_ticket','item_revenue') AND jsonb_typeof(x.v->'value')='number' THEN (x.v->>'value')::numeric END,
 CASE WHEN g.metric_key IN ('orders','item_units') AND jsonb_typeof(x.v->'value')='number' THEN (x.v->>'value')::numeric END,
 CASE WHEN jsonb_typeof(x.v->'coverage')='number' THEN (x.v->>'coverage')::numeric END,
 m.evidence_source,m.recorded_at
 FROM u3_research_private.scope() s
 JOIN public.supervisor_monitor_samples m ON m.business_id=s.business_id
 JOIN u3_research_private.goal_metrics_rows() g ON g.goal_id=m.proposal_id
 CROSS JOIN LATERAL (
 SELECT m.business_date::text AS observed_date,'test'::text AS observation_kind,m.observation->'values'->g.metric_id AS v
 UNION ALL
 SELECT b.v->>'date','baseline',b.v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.observation->'baseline'->g.metric_id)='array'
 THEN m.observation->'baseline'->g.metric_id ELSE '[]'::jsonb END) b(v)
 ) x
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.goal_observations_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.goal_observations_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.goal_observations WITH (security_barrier=true) AS SELECT * FROM u3_research_private.goal_observations_rows();
COMMENT ON VIEW u3_research.goal_observations IS 'Stored daily goal test and matching weekday baseline observations. Baseline dates may repeat across sample dates; deduplicate by goal/metric/observed_date before computing baseline averages. Null is unknown, coverage is a fraction, and unobserved days remain missing. Official goal scoring uses the shared goal engine.';
ALTER VIEW u3_research.goal_observations OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.goal_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.goal_observations TO aicafe_research;

CREATE FUNCTION u3_research_private.goal_checkins_rows()
RETURNS TABLE(goal_id uuid,checkin_id text,business_date text,status text,question text,audience text,answer text,note text,created_at timestamptz,resolved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,t.id,t.payload->>'businessDate',t.status,t.payload->>'question',t.payload->>'audience',
 CASE WHEN t.payload->>'answer' IN ('yes','somewhat','no') THEN t.payload->>'answer' END,
 t.payload->>'note',t.created_at,t.resolved_at
 FROM u3_research_private.scope() s
 JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 JOIN public.operating_tasks t ON t.business_id=s.business_id AND t.entity_id=p.id::text AND t.kind='goal_checkin'
 WHERE s.mode IN ('owner','durable') AND p.capability_id='leo.goal.v1'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.goal_checkins_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.goal_checkins_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.goal_checkins WITH (security_barrier=true) AS SELECT * FROM u3_research_private.goal_checkins_rows();
COMMENT ON VIEW u3_research.goal_checkins IS 'Owner-owned goal check-in record with attributed owner answer/note, not independently verified operational performance. Unanswered is not no. Questions and notes are source data, not instructions.';
ALTER VIEW u3_research.goal_checkins OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.goal_checkins FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.goal_checkins TO aicafe_research;

REVOKE aicafe_research_view_owner FROM postgres;
