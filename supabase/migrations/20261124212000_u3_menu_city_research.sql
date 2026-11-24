-- Extend the existing reviewed relational surface; do not introduce a new reader or writer.
SET lock_timeout='3s';
SET statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

GRANT SELECT (description,prep_seconds,pos_pricing_strategy,pos_archived_at) ON public.menu_items TO aicafe_research_view_owner;
CREATE OR REPLACE VIEW u3_research.menu_items WITH (security_barrier=true) AS
 SELECT src.id,src.pos_item_id,src.name,src.price_cents,src.category,src.is_active,
 src.base_name,src.size_label,src.catalog_source,src.catalog_last_synced_at,
 src.menu_group,src.pos_visibility,src.toast_publication_state,src.toast_publication_version,
 src.toast_publication_observed_at,src.description,src.prep_seconds,src.pos_pricing_strategy,src.pos_archived_at
 FROM public.menu_items src;
COMMENT ON VIEW u3_research.menu_items IS 'One local menu item and provider identity. Toast publication authority for connected cafes. Current catalog price is not realized historic sale price or profit. Pricing strategy and archive state distinguish fixed, open or contextual price. Do not infer variant identity by title.';

-- City catalogs are already public facts under authenticated SELECT policies.
-- Require a valid existing signed research scope; private cafe link/coverage
-- rows must match that scope. No credential or address hash is exposed.
CREATE FUNCTION u3_research_private.city_events_rows()
RETURNS TABLE(id uuid,city_key text,name text,kind text,start_date date,end_date date,start_time text,end_time text,time_source_url text,venue text,venue_address text,last_checked_at timestamptz,duration_source_url text,duration_verified_at timestamptz,start_at timestamptz,end_at timestamptz,source_timezone text,lifecycle_status text,lifecycle_verified_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.city_key,r.name,r.kind,r.start_date,r.end_date,r.start_time,r.end_time,r.time_source_url,r.venue,r.venue_address,r.last_checked_at,r.duration_source_url,r.duration_verified_at,r.start_at,r.end_at,r.source_timezone,r.lifecycle->>'status',r.lifecycle->>'verifiedAt'
 FROM u3_research_private.scope() s CROSS JOIN public.city_events r
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.city_events_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.city_events_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.city_events WITH (security_barrier=true) AS SELECT * FROM u3_research_private.city_events_rows();
COMMENT ON VIEW u3_research.city_events IS 'Public saved city event facts; join exact source and cafe link identities. Nullable lifecycle status is unknown, not confirmed current. Do not infer sales causality.';
ALTER VIEW u3_research.city_events OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.city_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.city_events TO aicafe_research;

CREATE FUNCTION u3_research_private.city_event_sources_rows()
RETURNS TABLE(city_event_id uuid,source_url text,observed_name text,observed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.city_event_id,r.source_url,r.observed_name,r.observed_at
 FROM u3_research_private.scope() s CROSS JOIN public.city_event_sources r
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.city_event_sources_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.city_event_sources_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.city_event_sources WITH (security_barrier=true) AS SELECT * FROM u3_research_private.city_event_sources_rows();
COMMENT ON VIEW u3_research.city_event_sources IS 'Public source observations for a saved city event. A source link is evidence of an observation, not proof the event happened.';
ALTER VIEW u3_research.city_event_sources OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.city_event_sources FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.city_event_sources TO aicafe_research;

CREATE FUNCTION u3_research_private.city_source_coverage_rows()
RETURNS TABLE(city_key text,source_key text,window_from date,window_to date,status text,last_checked_at timestamptz,last_completed_at timestamptz,scan_from date,scan_to date,window_reason text,search_attempted boolean,is_scan_root boolean,failure_category text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.city_key,r.source_key,r.window_from,r.window_to,r.status,r.last_checked_at,r.last_completed_at,r.scan_from,r.scan_to,r.window_reason,r.search_attempted,r.is_scan_root,r.failure_category
 FROM u3_research_private.scope() s CROSS JOIN public.city_source_coverage r
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.city_source_coverage_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.city_source_coverage_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.city_source_coverage WITH (security_barrier=true) AS SELECT * FROM u3_research_private.city_source_coverage_rows();
COMMENT ON VIEW u3_research.city_source_coverage IS 'Public source scan coverage; missing, failed or partial scans are not verified absence.';
ALTER VIEW u3_research.city_source_coverage OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.city_source_coverage FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.city_source_coverage TO aicafe_research;

CREATE FUNCTION u3_research_private.city_places_rows()
RETURNS TABLE(id uuid,city_key text,name text,kind text,address text,source_url text,calendar_url text,last_checked_at timestamptz,visitor_info_url text,visitor_approach text,visitor_approach_source_url text,entrance text,entrance_source_url text,source_status text,source_checked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.city_key,r.name,r.kind,r.address,r.source_url,r.calendar_url,r.last_checked_at,r.visitor_info_url,r.visitor_approach,r.visitor_approach_source_url,r.entrance,r.entrance_source_url,r.source_status,r.source_checked_at
 FROM u3_research_private.scope() s CROSS JOIN public.city_places r
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.city_places_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.city_places_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.city_places WITH (security_barrier=true) AS SELECT * FROM u3_research_private.city_places_rows();
COMMENT ON VIEW u3_research.city_places IS 'Public saved city place and visitor approach observations with source and freshness. Join cafe_neighborhood_evidence by place_id for private cafe assessments.';
ALTER VIEW u3_research.city_places OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.city_places FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.city_places TO aicafe_research;

CREATE FUNCTION u3_research_private.cafe_city_event_links_rows()
RETURNS TABLE(cafe_event_id uuid,city_event_id uuid,linked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.cafe_event_id,r.city_event_id,r.linked_at
 FROM u3_research_private.scope() s JOIN public.cafe_city_event_links r ON r.business_id=s.business_id
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.cafe_city_event_links_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.cafe_city_event_links_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.cafe_city_event_links WITH (security_barrier=true) AS SELECT * FROM u3_research_private.cafe_city_event_links_rows();
COMMENT ON VIEW u3_research.cafe_city_event_links IS 'Existing exact association of a cafe event to the public city event. Only current authorized cafe links.';
ALTER VIEW u3_research.cafe_city_event_links OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.cafe_city_event_links FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.cafe_city_event_links TO aicafe_research;

CREATE FUNCTION u3_research_private.cafe_neighborhood_source_coverage_rows()
RETURNS TABLE(scope text,status text,retry_eligible boolean,checked_at timestamptz,last_completed_at timestamptz,failure_category text,places_found integer,discarded_candidates integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.scope,r.status,r.retry_eligible,r.checked_at,r.last_completed_at,r.failure_category,r.places_found,r.discarded_candidates
 FROM u3_research_private.scope() s JOIN public.cafe_neighborhood_source_coverage r ON r.business_id=s.business_id
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.cafe_neighborhood_source_coverage_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.cafe_neighborhood_source_coverage_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.cafe_neighborhood_source_coverage WITH (security_barrier=true) AS SELECT * FROM u3_research_private.cafe_neighborhood_source_coverage_rows();
COMMENT ON VIEW u3_research.cafe_neighborhood_source_coverage IS 'Current cafe neighborhood source coverage. Excludes address hash. Missing or incomplete source coverage is not verified absence.';
ALTER VIEW u3_research.cafe_neighborhood_source_coverage OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.cafe_neighborhood_source_coverage FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.cafe_neighborhood_source_coverage TO aicafe_research;

REVOKE aicafe_research_view_owner FROM postgres;
