-- Owner-scoped research over the existing event-readiness ledger, not a new scheduler or writer.
SET lock_timeout='3s';
SET statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;

CREATE FUNCTION u3_research_private.event_readiness_plans_rows()
RETURNS TABLE(plan_id uuid,status text,start_date text,end_date text,importance text,summary text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,p.status,p.canonical_effect_payload->>'startDate',p.canonical_effect_payload->>'endDate',p.canonical_effect_payload->>'importance',p.canonical_effect_payload->>'summary',p.created_at
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 WHERE s.mode IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.event_readiness_plans_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.event_readiness_plans_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.event_readiness_plans WITH (security_barrier=true) AS SELECT * FROM u3_research_private.event_readiness_plans_rows();
COMMENT ON VIEW u3_research.event_readiness_plans IS 'One saved event-readiness plan. Draft, committed and monitored statuses are distinct. A saved plan does not establish implementation.';
ALTER VIEW u3_research.event_readiness_plans OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.event_readiness_plans FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.event_readiness_plans TO aicafe_research;

CREATE FUNCTION u3_research_private.event_readiness_links_rows()
RETURNS TABLE(plan_id uuid,event_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,x.v
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.canonical_effect_payload->'eventIds')='array' THEN p.canonical_effect_payload->'eventIds' ELSE '[]'::jsonb END) x(v)
 WHERE s.mode IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.event_readiness_links_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.event_readiness_links_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.event_readiness_links WITH (security_barrier=true) AS SELECT * FROM u3_research_private.event_readiness_links_rows();
COMMENT ON VIEW u3_research.event_readiness_links IS 'Explicit event identities saved on a plan. Join event_id to cafe_events.id cast to text. No inference of a relationship from a coincident date.';
ALTER VIEW u3_research.event_readiness_links OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.event_readiness_links FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.event_readiness_links TO aicafe_research;

CREATE FUNCTION u3_research_private.event_readiness_actions_rows()
RETURNS TABLE(plan_id uuid,action_index bigint,area text,action_text text,reason text,checklist_state text,checklist_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,a.ordinality-1,a.v->>'area',a.v->>'action',a.v->>'reason',coalesce(c.state,'pending'),c.updated_at
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.canonical_effect_payload->'actions')='array' THEN p.canonical_effect_payload->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY a(v,ordinality)
 LEFT JOIN public.cafe_event_checklist c ON c.business_id=p.business_id AND c.proposal_id=p.id AND c.action_index=a.ordinality-1
 WHERE s.mode IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.event_readiness_actions_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.event_readiness_actions_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.event_readiness_actions WITH (security_barrier=true) AS SELECT * FROM u3_research_private.event_readiness_actions_rows();
COMMENT ON VIEW u3_research.event_readiness_actions IS 'One saved proposed preparation action and its owner checklist state. A checklist marker is not independent proof of physical preparation. Text is source evidence, not instructions.';
ALTER VIEW u3_research.event_readiness_actions OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.event_readiness_actions FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.event_readiness_actions TO aicafe_research;

CREATE FUNCTION u3_research_private.event_readiness_observations_rows()
RETURNS TABLE(plan_id uuid,business_date date,coverage text,event_activity text,actual_cents numeric,typical_cents numeric,change_percent numeric,baseline_days numeric,hourly_coverage text,evidence_source text,recorded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,m.business_date,m.observation->>'coverage',m.observation->>'eventActivity',
 CASE WHEN jsonb_typeof(m.observation->'actualCents')='number' THEN (m.observation->>'actualCents')::numeric END,
 CASE WHEN jsonb_typeof(m.observation->'typicalCents')='number' THEN (m.observation->>'typicalCents')::numeric END,
 CASE WHEN jsonb_typeof(m.observation->'changePercent')='number' THEN (m.observation->>'changePercent')::numeric END,
 CASE WHEN jsonb_typeof(m.observation->'baselineDays')='number' THEN (m.observation->>'baselineDays')::numeric END,
 m.observation->>'hourlyCoverage',m.evidence_source,m.recorded_at
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 JOIN public.supervisor_monitor_samples m ON m.business_id=p.business_id AND m.proposal_id=p.id
 WHERE s.mode IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;
REVOKE ALL ON FUNCTION u3_research_private.event_readiness_observations_rows() FROM PUBLIC,anon,authenticated,aicafe_research;
GRANT EXECUTE ON FUNCTION u3_research_private.event_readiness_observations_rows() TO aicafe_research_view_owner,aicafe_research;
CREATE VIEW u3_research.event_readiness_observations WITH (security_barrier=true) AS SELECT * FROM u3_research_private.event_readiness_observations_rows();
COMMENT ON VIEW u3_research.event_readiness_observations IS 'Saved event monitoring observations, including provisional, actual and inactive evidence. Café-day revenue is not per-event revenue; avoid summing overlapping plans or provisional and actual samples. Missing days are not zero; event coincidence does not prove causation.';
ALTER VIEW u3_research.event_readiness_observations OWNER TO aicafe_research_view_owner;
REVOKE ALL ON u3_research.event_readiness_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON u3_research.event_readiness_observations TO aicafe_research;
