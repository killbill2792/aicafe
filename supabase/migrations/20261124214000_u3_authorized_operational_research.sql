-- Research is authorized by the existing signed cafe/owner/thread/lease.
-- The effective projection privilege is separate from the actual claim mode.
-- A verified explicit owner routine or claimed investigation can inspect
-- reviewed owner-safe operational fields. Default unrequested Watch cannot.
-- Customer/retained Toast privacy still uses the actual scope().mode.
set lock_timeout='3s';
set statement_timeout='45s';

CREATE OR REPLACE FUNCTION u3_research_private.mode()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $detail$
DECLARE
 s record;
 payload jsonb;
BEGIN
 SELECT * INTO s FROM u3_research_private.scope() LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF s.mode IN ('owner','durable') THEN RETURN s.mode; END IF;
 IF s.mode='investigation' THEN RETURN 'owner'; END IF;
 IF s.mode='routine' THEN
   -- scope() has already verified this exact signed token, run and lease.
   payload:=convert_from(decode(split_part(current_setting('aicafe.u3_research_scope',true),'.',1),'base64'),'UTF8')::jsonb;
   IF EXISTS (
     SELECT 1 FROM public.supervisor_routine_occurrences o
     JOIN public.supervisor_routines r ON r.business_id=o.business_id AND r.id=o.routine_id
     WHERE o.business_id=s.business_id AND o.run_id=(payload->>'run')::uuid
       AND o.lease_token=(payload->>'lease')::uuid AND o.state='running'
       AND o.lease_until>statement_timestamp() AND r.status='active'
       AND r.revision=o.revision AND r.owner_user_id=s.owner_user_id
       AND r.thread_id=(payload->>'thread')::uuid AND r.execution_mode='objective'
   ) THEN RETURN 'owner'; END IF;
 END IF;
 RETURN s.mode;
END
$detail$;
-- Expose only a boolean authorization observation to the trusted executor;
-- no signed capability, owner identity, raw data or new role grant.
CREATE FUNCTION u3_research.authorized_detail()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $detail$ SELECT coalesce(u3_research_private.mode() IN ('owner','durable'),false) $detail$;
REVOKE ALL ON FUNCTION u3_research.authorized_detail() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION u3_research.authorized_detail() TO aicafe_research;

CREATE OR REPLACE FUNCTION u3_research_private.supplier_quotes_rows()
RETURNS TABLE(id uuid,ingredient_id uuid,supplier_name text,item_name text,price_cents integer,package_count integer,package_unit text,
 source_kind text,quoted_on date,evidence_status text,created_at timestamptz,currency_code text,valid_until date,
 available_status text,available_checked_at date,delivery_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT q.id,q.ingredient_id,q.supplier_name,q.item_name,q.price_cents,q.package_count,q.package_unit,q.source_kind,
 q.quoted_on,q.evidence_status,q.created_at,q.currency_code,q.valid_until,q.available_status,q.available_checked_at,q.delivery_on
 FROM u3_research_private.scope() s JOIN public.ai_supplier_quotes q ON q.business_id=s.business_id AND q.owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.goal_metrics_rows()
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
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='leo.goal.v1'
 AND m.v->>'metricKey' IN ('net_sales','orders','avg_ticket','item_units','item_revenue')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.goal_observations_rows()
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
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.goal_checkins_rows()
RETURNS TABLE(goal_id uuid,checkin_id text,business_date text,status text,question text,audience text,answer text,note text,created_at timestamptz,resolved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,t.id,t.payload->>'businessDate',t.status,t.payload->>'question',t.payload->>'audience',
 CASE WHEN t.payload->>'answer' IN ('yes','somewhat','no') THEN t.payload->>'answer' END,
 t.payload->>'note',t.created_at,t.resolved_at
 FROM u3_research_private.scope() s
 JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 JOIN public.operating_tasks t ON t.business_id=s.business_id AND t.entity_id=p.id::text AND t.kind='goal_checkin'
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='leo.goal.v1'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.financial_statement_documents_rows()
RETURNS TABLE(statement_id uuid,account_key text,currency_code text,statement_from date,statement_to date,opening_cents bigint,closing_cents bigint,transaction_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,u.financial_account_key,u.financial_currency,u.financial_from,u.financial_to,u.financial_opening_cents,u.financial_closing_cents,jsonb_array_length(u.financial_transactions)
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable') AND u.kind='statement' AND u.status='done'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.financial_statement_transactions_rows()
RETURNS TABLE(statement_id uuid,row_index integer,transaction_date date,amount_cents bigint,balance_cents bigint,currency_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,(t.v->>'i')::integer,(t.v->>'date')::date,(t.v->>'amountCents')::bigint,(t.v->>'balanceCents')::bigint,u.financial_currency
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(u.financial_transactions)='array' THEN u.financial_transactions ELSE '[]'::jsonb END) t(v)
 WHERE u3_research_private.mode() IN ('owner','durable') AND u.kind='statement' AND u.status='done'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.financial_invoice_claims_rows()
RETURNS TABLE(invoice_id uuid,supplier_id uuid,purchase_order_id uuid,invoice_reference text,revision integer,issued_on date,due_on date,currency_code text,total_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT i.id,i.supplier_id,i.purchase_order_id,i.invoice_reference,i.revision::integer,i.issued_on,i.due_on,i.currency_code,i.total_cents
 FROM u3_research_private.scope() s JOIN public.supplier_invoices i ON i.business_id=s.business_id AND i.owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.financial_bill_claims_rows()
RETURNS TABLE(bill_id uuid,payee text,bill_reference text,revision bigint,issued_on date,due_on date,amount_cents bigint,currency_code text,source_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT u.id,u.financial_bill_payee,u.financial_bill_reference,u.financial_bill_revision,u.financial_bill_issued_on,u.financial_bill_due_on,u.financial_bill_amount_cents,u.financial_currency,u.financial_bill_source_kind
 FROM u3_research_private.scope() s JOIN public.uploads u ON u.business_id=s.business_id AND u.financial_owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable') AND u.kind='bill_claim' AND u.status='done'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.financial_settlement_evidence_rows()
RETURNS TABLE(event_id uuid,invoice_id uuid,statement_id uuid,row_index bigint,transaction_date date,kind text,allocation_cents bigint,reverses_id uuid,source_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT e.id,e.financial_invoice_id,e.financial_upload_id,e.financial_row_index,e.financial_tx_date,e.financial_kind,e.financial_allocation_cents,e.financial_reverses_id,e.source_revision::text
 FROM u3_research_private.scope() s JOIN public.purchase_reconciliation_events e ON e.business_id=s.business_id AND e.owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable') AND e.financial_kind IN ('settlement_evidence_linked','settlement_evidence_reversed')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.event_readiness_plans_rows()
RETURNS TABLE(plan_id uuid,status text,start_date text,end_date text,importance text,summary text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,p.status,p.canonical_effect_payload->>'startDate',p.canonical_effect_payload->>'endDate',p.canonical_effect_payload->>'importance',p.canonical_effect_payload->>'summary',p.created_at
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.event_readiness_links_rows()
RETURNS TABLE(plan_id uuid,event_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,x.v
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.canonical_effect_payload->'eventIds')='array' THEN p.canonical_effect_payload->'eventIds' ELSE '[]'::jsonb END) x(v)
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.event_readiness_actions_rows()
RETURNS TABLE(plan_id uuid,action_index bigint,area text,action_text text,reason text,checklist_state text,checklist_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT p.id,a.ordinality-1,a.v->>'area',a.v->>'action',a.v->>'reason',coalesce(c.state,'pending'),c.updated_at
 FROM u3_research_private.scope() s JOIN public.supervisor_proposals p ON p.business_id=s.business_id AND p.owner_user_id=s.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.canonical_effect_payload->'actions')='array' THEN p.canonical_effect_payload->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY a(v,ordinality)
 LEFT JOIN public.cafe_event_checklist c ON c.business_id=p.business_id AND c.proposal_id=p.id AND c.action_index=a.ordinality-1
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.event_readiness_observations_rows()
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
 WHERE u3_research_private.mode() IN ('owner','durable') AND p.capability_id='alex.event_readiness.v1'
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.toast_location_mappings_rows()
RETURNS TABLE(location_id uuid,restaurant_guid uuid,verified_at timestamptz,toast_time_zone text,closeout_hour smallint,info_refreshed_at timestamptz,toast_start_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.location_id,r.restaurant_guid,r.verified_at,r.toast_time_zone,r.closeout_hour,r.info_refreshed_at,r.toast_start_date
 FROM u3_research_private.scope() s JOIN public.toast_location_mappings r ON r.business_id=s.business_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.toast_employee_directory_rows()
RETURNS TABLE(restaurant_guid uuid,employee_guid uuid,display_name text,deleted boolean,linked_employee_id uuid,linked_at timestamptz,fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.restaurant_guid,r.employee_guid,r.display_name,r.deleted,r.linked_employee_id,r.linked_at,r.fetched_at
 FROM u3_research_private.scope() s JOIN public.toast_employee_directory r ON r.business_id=s.business_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.staff_preference_windows_rows()
RETURNS TABLE(id uuid,employee_id uuid,day_of_week smallint,start_local time,end_local time,overnight boolean,preference text,strength text,effective_from date,effective_to date,source text,confirmation text,confirmed_at timestamptz,revision integer,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.employee_id,r.day_of_week,r.start_local,r.end_local,r.overnight,r.preference,r.strength,r.effective_from,r.effective_to,r.source,r.confirmation,r.confirmed_at,r.revision,r.created_at,r.updated_at
 FROM u3_research_private.scope() s JOIN public.staff_preference_windows r ON r.business_id=s.business_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;

CREATE OR REPLACE FUNCTION u3_research_private.staff_scheduling_compensation_rows()
RETURNS TABLE(id uuid,employee_id uuid,cash_cost_state text,eligibility_verified_at timestamptz,revision integer,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $rows$
 SELECT r.id,r.employee_id,r.cash_cost_state,r.eligibility_verified_at,r.revision,r.created_at,r.updated_at
 FROM u3_research_private.scope() s JOIN public.staff_scheduling_compensation r ON r.business_id=s.business_id
 WHERE u3_research_private.mode() IN ('owner','durable')
$rows$;
