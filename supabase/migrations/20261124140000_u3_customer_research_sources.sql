-- Read existing customer sources and denominators; no new identity resolver,
-- writer, raw table grants or data-readiness policy.
set lock_timeout='3s';
set statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;
CREATE FUNCTION u3_research_private.customer_visits_rows()
RETURNS SETOF public.cv_customer_visits
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $rows$
 SELECT r.business_id,
 r.source,
 CASE WHEN s.mode IN ('owner','durable') THEN r.source_ref ELSE NULL END,
 r.status,
 r.business_date,
 CASE WHEN s.mode IN ('owner','durable') THEN r.identity_ref ELSE NULL END,
 r.identity_state,
 CASE WHEN s.mode IN ('owner','durable') THEN r.restaurant_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.order_ref ELSE NULL END,
 r.eligible_check_count,
 r.net_sales_cents,
 r.known_money_check_count,
 r.first_observed_date,
 r.last_observed_date,
 r.previous_observed_date,
 r.next_observed_date,
 r.observed_visit_number,
 r.days_since_previous,
 r.days_since_last_observed,
 r.first_observed_visit,
 r.returning_visit,
 r.observed_return_7d,
 r.observed_return_30d,
 r.observed_return_60d,
 r.observed_return_90d,
 r.history_start_date,
 r.as_of_date,
 r.period_account_visits,
 r.period_account_net_sales_cents,
 r.period_account_revenue_share,
 r.period_account_revenue_share_squared,
 r.history_account_net_sales_cents,
 r.observed_prior_cadence_days,
 r.observed_reactivation_gap_ratio,
 r.observed_lapse_gap_ratio,
 r.order_duration_seconds,
 r.observed_lapse_flag,
 r.observed_reappearance_flag,
 r.historical_recipe_cost_cents,
 r.historical_recipe_contribution_cents
 FROM u3_research_private.scope() s
 CROSS JOIN LATERAL (SELECT nullif(current_setting('aicafe.u3_date_from',true),'')::date AS from_day,
 nullif(current_setting('aicafe.u3_date_to',true),'')::date AS to_day) w
 CROSS JOIN LATERAL public.customer_visits_for(s.business_id,w.from_day,w.to_day) r
 WHERE w.from_day IS NOT NULL AND w.to_day IS NOT NULL AND w.to_day>=w.from_day AND r.business_id=s.business_id
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.customer_visits_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.customer_visits_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.customer_visits WITH (security_barrier=true) AS
 SELECT source,source_ref,status,business_date,identity_ref,identity_state,restaurant_ref,order_ref,eligible_check_count,net_sales_cents,known_money_check_count,first_observed_date,last_observed_date,previous_observed_date,next_observed_date,observed_visit_number,days_since_previous,days_since_last_observed,first_observed_visit,returning_visit,observed_return_7d,observed_return_30d,observed_return_60d,observed_return_90d,history_start_date,as_of_date,period_account_visits,period_account_net_sales_cents,period_account_revenue_share,period_account_revenue_share_squared,history_account_net_sales_cents,observed_prior_cadence_days,observed_reactivation_gap_ratio,observed_lapse_gap_ratio,order_duration_seconds,observed_lapse_flag,observed_reappearance_flag,historical_recipe_cost_cents,historical_recipe_contribution_cents FROM u3_research_private.customer_visits_rows();
COMMENT ON VIEW u3_research.customer_visits IS 'Canonical visit or unlinked order observation; explicit date pair required. Identity/order references are owner/durable only. Period-account metrics repeat across visit rows; do not sum them. First-observed is not first-ever. Use customer_coverage for the unfiltered denominator. Historical cost/contribution may be unknown.';
ALTER VIEW u3_research.customer_visits OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.customer_visits FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.customer_visits TO aicafe_research;

CREATE FUNCTION u3_research_private.customer_products_rows()
RETURNS SETOF public.cv_customer_products
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $rows$
 SELECT r.business_id,
 r.source,
 CASE WHEN s.mode IN ('owner','durable') THEN r.source_ref ELSE NULL END,
 r.status,
 r.business_date,
 CASE WHEN s.mode IN ('owner','durable') THEN r.restaurant_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.identity_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.visit_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.order_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.check_ref ELSE NULL END,
 r.visit_class,
 r.fact_kind,
 CASE WHEN s.mode IN ('owner','durable') THEN r.product_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.item_group_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.modifier_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.option_group_ref ELSE NULL END,
 CASE WHEN s.mode IN ('owner','durable') THEN r.paired_product_ref ELSE NULL END,
 r.quantity,
 r.pair_occurrence,
 r.order_channel,
 r.local_hour,
 r.business_weekday
 FROM u3_research_private.scope() s
 CROSS JOIN LATERAL (SELECT nullif(current_setting('aicafe.u3_date_from',true),'')::date AS from_day,
 nullif(current_setting('aicafe.u3_date_to',true),'')::date AS to_day) w
 CROSS JOIN LATERAL public.customer_products_for(s.business_id,w.from_day,w.to_day) r
 WHERE w.from_day IS NOT NULL AND w.to_day IS NOT NULL AND w.to_day>=w.from_day AND r.business_id=s.business_id
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.customer_products_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.customer_products_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.customer_products WITH (security_barrier=true) AS
 SELECT source,source_ref,status,business_date,restaurant_ref,identity_ref,visit_ref,order_ref,check_ref,visit_class,fact_kind,product_ref,item_group_ref,modifier_ref,option_group_ref,paired_product_ref,quantity,pair_occurrence,order_channel,local_hour,business_weekday FROM u3_research_private.customer_products_rows();
COMMENT ON VIEW u3_research.customer_products IS 'Canonical product, modifier and basket-pair observations at visit grain. Explicit date pair required. References are owner/durable only. Respect fact_kind, compatible units and missing identities; use customer_coverage for the denominator.';
ALTER VIEW u3_research.customer_products OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.customer_products FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.customer_products TO aicafe_research;

CREATE FUNCTION u3_research_private.customer_coverage_row()
RETURNS TABLE(eligible_check_count bigint,linked_check_count bigint,named_check_count bigint,
 known_money_check_count bigint,linked_known_money_check_count bigint,
 recorded_net_cents bigint,linked_recorded_net_cents bigint,
 expected_location_days bigint,complete_location_days bigint,complete boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $coverage$
 SELECT (c.v->>'eligibleChecks')::bigint,(c.v->>'linkedChecks')::bigint,
 (c.v->>'namedChecks')::bigint,(c.v->>'knownMoneyChecks')::bigint,
 (c.v->>'linkedKnownMoneyChecks')::bigint,(c.v->>'recordedNetCents')::bigint,
 (c.v->>'linkedRecordedNetCents')::bigint,(c.v->>'expectedLocationDays')::bigint,
 (c.v->>'completeLocationDays')::bigint,(c.v->>'complete')::boolean
 FROM u3_research_private.scope() s
 CROSS JOIN LATERAL (SELECT nullif(current_setting('aicafe.u3_date_from',true),'')::date AS from_day,
 nullif(current_setting('aicafe.u3_date_to',true),'')::date AS to_day) w
 CROSS JOIN LATERAL (SELECT public.customer_query_coverage(s.business_id,w.from_day,w.to_day) AS v) c
 WHERE w.from_day IS NOT NULL AND w.to_day IS NOT NULL AND w.to_day>=w.from_day AND c.v IS NOT NULL
$coverage$;
REVOKE ALL ON FUNCTION u3_research_private.customer_coverage_row() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.customer_coverage_row() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.customer_coverage WITH (security_barrier=true) AS
 SELECT * FROM u3_research_private.customer_coverage_row();
COMMENT ON VIEW u3_research.customer_coverage IS 'One canonical unfiltered denominator for all eligible checks in the explicit selected business-date pair. Coverage and identity linkage are independent of filtered rows. Null money is unknown; incomplete history cannot certify all-café customer totals.';
ALTER VIEW u3_research.customer_coverage OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.customer_coverage FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.customer_coverage TO aicafe_research;

REVOKE aicafe_research_view_owner FROM postgres;
