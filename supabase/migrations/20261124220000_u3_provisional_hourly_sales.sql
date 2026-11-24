-- Expose the existing canonical provisional hourly sales to scoped SQL research.
-- cv_sales_hours continues to own the final-versus-provisional precedence.
set lock_timeout='3s';
set statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

CREATE FUNCTION u3_research_private.provisional_hourly_sales_rows()
RETURNS TABLE(business_date date,hour_local integer,net_sales_cents bigint,orders_count integer,
 status text,source_as_of timestamptz,hourly_unassigned_orders numeric,locations_failed numeric,
 truncated boolean,unparsed_orders numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.business_date,(r.data->>'hour_local')::integer,r.net_sales_cents,r.orders_count,
 r.status,(r.data->>'source_as_of')::timestamptz,
 CASE WHEN jsonb_typeof(r.data->'hourly_unassigned_orders')='number' THEN (r.data->>'hourly_unassigned_orders')::numeric END,
 CASE WHEN jsonb_typeof(r.data->'locations_failed')='number' THEN (r.data->>'locations_failed')::numeric END,
 CASE WHEN jsonb_typeof(r.data->'truncated')='boolean' THEN (r.data->>'truncated')::boolean END,
 CASE WHEN jsonb_typeof(r.data->'unparsed_orders')='number' THEN (r.data->>'unparsed_orders')::numeric END
 FROM u3_research_private.scope() s JOIN public.cv_sales_hours r ON r.business_id=s.business_id
 WHERE r.status='provisional'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.provisional_hourly_sales_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.provisional_hourly_sales_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.provisional_hourly_sales WITH (security_barrier=true) AS
 SELECT * FROM u3_research_private.provisional_hourly_sales_rows();
COMMENT ON VIEW u3_research.provisional_hourly_sales IS 'One café business-date/local-hour record from its latest saved Toast live reading. Provisional until closeout, with the observed timestamp and coverage gaps. Finalized hourly rows remain in hourly_sales_rollup. An absent hour is not evidence of zero sales.';
ALTER VIEW u3_research.provisional_hourly_sales OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.provisional_hourly_sales FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.provisional_hourly_sales TO aicafe_research;
REVOKE aicafe_research_view_owner FROM postgres;
