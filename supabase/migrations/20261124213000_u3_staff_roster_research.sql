-- Exact scope-preserving staff identity and schedule research parity.
SET lock_timeout='3s';
SET statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

GRANT SELECT (pos_team_member_id,min_weekly_minutes,max_weekly_minutes,available_days,pos_display_name,pos_last_role,pos_last_wage_cents,pos_last_active) ON public.employees TO aicafe_research_view_owner;
CREATE OR REPLACE VIEW u3_research.employees WITH (security_barrier=true) AS
 SELECT CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.id ELSE NULL END AS id,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.display_name ELSE NULL END AS display_name,
 src.role,src.active,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.default_hourly_wage_cents ELSE NULL END AS default_hourly_wage_cents,
 src.wage_period,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.wage_amount_cents ELSE NULL END AS wage_amount_cents,
 src.pos_last_synced_at,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.pos_team_member_id ELSE NULL END AS pos_team_member_id,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.min_weekly_minutes ELSE NULL END AS min_weekly_minutes,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.max_weekly_minutes ELSE NULL END AS max_weekly_minutes,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.available_days ELSE NULL END AS available_days,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.pos_display_name ELSE NULL END AS pos_display_name,
 src.pos_last_role,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.pos_last_wage_cents ELSE NULL END AS pos_last_wage_cents,
 src.pos_last_active
 FROM public.employees src;
COMMENT ON VIEW u3_research.employees IS 'Existing local team identities, recorded wage settings and availability. Owner-resolved names and wages are not inferred from POS names; join Toast roster directory by its explicit linked employee ID. Contact details and authentication identities excluded.';

GRANT SELECT (break_source,repeat_schedule_id,proposal_id,created_at,updated_at) ON public.scheduled_shifts TO aicafe_research_view_owner;
CREATE OR REPLACE VIEW u3_research.scheduled_shifts WITH (security_barrier=true) AS
 SELECT CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.id ELSE NULL END AS id,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.employee_id ELSE NULL END AS employee_id,
 src.local_date,src.start_local,src.end_local,src.overnight,src.break_minutes,src.role,src.status,src.source,src.deleted_at,
 src.break_source,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.repeat_schedule_id ELSE NULL END AS repeat_schedule_id,
 CASE WHEN u3_research_private.mode() IN ('owner','durable') THEN src.proposal_id ELSE NULL END AS proposal_id,
 src.created_at,src.updated_at
 FROM public.scheduled_shifts src;
COMMENT ON VIEW u3_research.scheduled_shifts IS 'Saved dated local planned shifts, including explicit break source and proposal lineage. Exclude deleted/irrelevant status for current confirmed roster. Not actual worked time; read recorded_timecards for actual punches.';

CREATE FUNCTION u3_research_private.toast_location_mappings_rows()
RETURNS TABLE(location_id uuid,restaurant_guid uuid,verified_at timestamptz,toast_time_zone text,closeout_hour smallint,info_refreshed_at timestamptz,toast_start_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.location_id,r.restaurant_guid,r.verified_at,r.toast_time_zone,r.closeout_hour,r.info_refreshed_at,r.toast_start_date
 FROM u3_research_private.scope() s JOIN public.toast_location_mappings r ON r.business_id=s.business_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.toast_location_mappings_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.toast_location_mappings_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.toast_location_mappings WITH (security_barrier=true) AS SELECT * FROM u3_research_private.toast_location_mappings_rows();
COMMENT ON VIEW u3_research.toast_location_mappings IS 'Exact existing Toast location to restaurant linkage and business-day source metadata. No credentials, integration secrets or worker access details. Join planned shifts by location_id.';
ALTER VIEW u3_research.toast_location_mappings OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.toast_location_mappings FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.toast_location_mappings TO aicafe_research;

CREATE FUNCTION u3_research_private.toast_employee_directory_rows()
RETURNS TABLE(restaurant_guid uuid,employee_guid uuid,display_name text,deleted boolean,linked_employee_id uuid,linked_at timestamptz,fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.restaurant_guid,r.employee_guid,r.display_name,r.deleted,r.linked_employee_id,r.linked_at,r.fetched_at
 FROM u3_research_private.scope() s JOIN public.toast_employee_directory r ON r.business_id=s.business_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.toast_employee_directory_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.toast_employee_directory_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.toast_employee_directory WITH (security_barrier=true) AS SELECT * FROM u3_research_private.toast_employee_directory_rows();
COMMENT ON VIEW u3_research.toast_employee_directory IS 'Saved Toast roster identity scoped by restaurant and employee GUID, with verified local employee link if present. A missing link remains unknown; do not match people by display name. Prefer the linked local display name where available.';
ALTER VIEW u3_research.toast_employee_directory OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.toast_employee_directory FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.toast_employee_directory TO aicafe_research;

CREATE FUNCTION u3_research_private.staff_preference_windows_rows()
RETURNS TABLE(id uuid,employee_id uuid,day_of_week smallint,start_local time,end_local time,overnight boolean,preference text,strength text,effective_from date,effective_to date,source text,confirmation text,confirmed_at timestamptz,revision integer,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.employee_id,r.day_of_week,r.start_local,r.end_local,r.overnight,r.preference,r.strength,r.effective_from,r.effective_to,r.source,r.confirmation,r.confirmed_at,r.revision,r.created_at,r.updated_at
 FROM u3_research_private.scope() s JOIN public.staff_preference_windows r ON r.business_id=s.business_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.staff_preference_windows_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.staff_preference_windows_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.staff_preference_windows WITH (security_barrier=true) AS SELECT * FROM u3_research_private.staff_preference_windows_rows();
COMMENT ON VIEW u3_research.staff_preference_windows IS 'Existing employee scheduling preferences, not confirmed attendance or a published roster. Respect effective dates, confirmation and strength.';
ALTER VIEW u3_research.staff_preference_windows OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.staff_preference_windows FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.staff_preference_windows TO aicafe_research;

CREATE FUNCTION u3_research_private.staff_scheduling_compensation_rows()
RETURNS TABLE(id uuid,employee_id uuid,cash_cost_state text,eligibility_verified_at timestamptz,revision integer,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.employee_id,r.cash_cost_state,r.eligibility_verified_at,r.revision,r.created_at,r.updated_at
 FROM u3_research_private.scope() s JOIN public.staff_scheduling_compensation r ON r.business_id=s.business_id
 WHERE s.mode IN ('owner','durable')
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.staff_scheduling_compensation_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.staff_scheduling_compensation_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.staff_scheduling_compensation WITH (security_barrier=true) AS SELECT * FROM u3_research_private.staff_scheduling_compensation_rows();
COMMENT ON VIEW u3_research.staff_scheduling_compensation IS 'Saved staff scheduling cash-cost eligibility and verification date; unknown or unverified eligibility is not zero wage. No private verifier identity or reference content.';
ALTER VIEW u3_research.staff_scheduling_compensation OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.staff_scheduling_compensation FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.staff_scheduling_compensation TO aicafe_research;

REVOKE aicafe_research_view_owner FROM postgres;
