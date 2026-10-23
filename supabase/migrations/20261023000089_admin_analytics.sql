-- Internal only: deterministic topics, aggregated cost diagnostics and inert card ideas.
-- Rerunnable; safe on existing production data. No owner grants or publications.
alter table public.agent_turn_logs add column if not exists question_topic text;
alter table public.agent_turn_logs add column if not exists topic_version integer not null default 0;
create index if not exists agent_turn_logs_topic_backlog_idx
  on public.agent_turn_logs (topic_version, started_at, id);
create index if not exists agent_turn_logs_topic_recent_idx
  on public.agent_turn_logs (question_topic, started_at desc);
create table if not exists public.admin_home_card_suggestions (
  id uuid primary key default gen_random_uuid(),
  topic text not null unique check (topic in ('break_even','best_sellers','labor','schedule','menu_price','sales','expenses','inventory')),
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'suggested' check (status = 'suggested'),
  created_at timestamptz not null default now()
);
-- Earlier previews may have installed a restrictive NOT NULL / RESTRICT key.
-- Admin suggestions are inert history and must never block account deletion.
alter table public.admin_home_card_suggestions alter column requested_by drop not null;
alter table public.admin_home_card_suggestions
  drop constraint if exists admin_home_card_suggestions_requested_by_fkey;
alter table public.admin_home_card_suggestions
  add constraint admin_home_card_suggestions_requested_by_fkey
  foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.admin_home_card_suggestions enable row level security;
revoke all on public.admin_home_card_suggestions from public, anon, authenticated;
grant select, insert on public.admin_home_card_suggestions to service_role;

-- The server's daily classifier sends ONLY a UUID and a controlled topic.
-- Do not accept raw question text, tool arguments or other sensitive values here.
create or replace function public.admin_classify_turns(p_rows jsonb)
returns integer language plpgsql security invoker set search_path=public as $$
declare changed integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_only' using errcode='42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200
     or exists (select 1 from jsonb_to_recordset(p_rows) as x(id uuid, topic text)
       where x.id is null or x.topic is null or x.topic not in
        ('break_even','best_sellers','labor','schedule','menu_price','sales','expenses','inventory','other')) then
    raise exception 'invalid_topics' using errcode='23514';
  end if;
  update public.agent_turn_logs l
    set question_topic=x.topic, topic_version=1
    from jsonb_to_recordset(p_rows) as x(id uuid, topic text)
    where l.id=x.id and l.topic_version<1;
  get diagnostics changed=row_count;
  return changed;
end $$;
revoke all on function public.admin_classify_turns(jsonb) from public, anon, authenticated;
grant execute on function public.admin_classify_turns(jsonb) to service_role;

-- Exact database-side aggregation avoids PostgREST's default 1,000-row truncation.
-- A cost is KNOWN only when the per-turn amount is non-null.
create or replace function public.admin_cost_rollup()
returns jsonb language sql stable security invoker set search_path=public as $$
select jsonb_build_object(
 'totals', (select to_jsonb(x) from (
   select count(*) as turns, count(cost_usd) as priced_turns,
     coalesce(sum(input_tokens),0)::bigint as input_tokens,
     coalesce(sum(output_tokens),0)::bigint as output_tokens,
     coalesce(sum(cost_usd),0)::numeric(16,6) as known_cost_usd
   from public.agent_turn_logs) x),
 'cafes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.known_cost_usd desc), '[]'::jsonb) from (
   select l.business_id,b.name, count(*) as turns,count(l.cost_usd) as priced_turns,
     coalesce(sum(l.input_tokens),0)::bigint as input_tokens,
     coalesce(sum(l.output_tokens),0)::bigint as output_tokens,
     coalesce(sum(l.cost_usd),0)::numeric(16,6) as known_cost_usd
   from public.agent_turn_logs l join public.businesses b on b.id=l.business_id
   group by l.business_id,b.name) x),
 'days', (select coalesce(jsonb_agg(to_jsonb(x) order by x.day desc), '[]'::jsonb) from (
   select (started_at at time zone 'UTC')::date as day,
     count(*) as turns,count(cost_usd) as priced_turns,
     coalesce(sum(input_tokens),0)::bigint as input_tokens,
     coalesce(sum(output_tokens),0)::bigint as output_tokens,
     coalesce(sum(cost_usd),0)::numeric(16,6) as known_cost_usd
   from public.agent_turn_logs
   group by (started_at at time zone 'UTC')::date) x),
 'topics', (select coalesce(jsonb_agg(to_jsonb(x) order by x.known_cost_usd desc), '[]'::jsonb) from (
   select coalesce(question_topic,'pending_classification') as topic,
     count(*) as turns,count(cost_usd) as priced_turns,
     coalesce(sum(input_tokens),0)::bigint as input_tokens,
     coalesce(sum(output_tokens),0)::bigint as output_tokens,
     coalesce(sum(cost_usd),0)::numeric(16,6) as known_cost_usd
   from public.agent_turn_logs group by coalesce(question_topic,'pending_classification')) x),
 'top_turns', (select coalesce(jsonb_agg(to_jsonb(x) order by x.cost_usd desc), '[]'::jsonb) from (
   select l.id,l.business_id,b.name, l.started_at,l.question_topic,
     l.input_tokens,l.output_tokens,l.cost_usd
   from public.agent_turn_logs l join public.businesses b on b.id=l.business_id
   where l.cost_usd is not null order by l.cost_usd desc,l.id limit 10) x)
) $$;
revoke all on function public.admin_cost_rollup() from public, anon, authenticated;
grant execute on function public.admin_cost_rollup() to service_role;

-- Ninety-day window, one row per topic and day; cafe-local hour is calculated
-- before grouping, so its mode is meaningful across different time zones.
create or replace function public.admin_pattern_rollup()
returns jsonb language sql stable security invoker set search_path=public as $$
with recent as (
  select l.question_topic as topic,l.business_id,l.started_at,l.cost_usd,
    extract(hour from l.started_at at time zone coalesce(b.timezone,'UTC'))::integer as local_hour,
    (l.started_at at time zone 'UTC')::date as day
  from public.agent_turn_logs l join public.businesses b on b.id=l.business_id
  where l.started_at >= now()-interval '90 days' and l.question_topic is not null
)
select jsonb_build_object(
 'topics',(select coalesce(jsonb_agg(to_jsonb(x) order by x.questions desc),'[]'::jsonb) from (
   select topic,count(*) as questions,count(distinct business_id) as cafes,
     mode() within group (order by local_hour) as common_local_hour,
     avg(cost_usd)::numeric(16,6) as avg_cost_usd,count(cost_usd) as priced_questions
   from recent group by topic) x),
 'daily',(select coalesce(jsonb_agg(to_jsonb(x) order by x.day desc, x.questions desc),'[]'::jsonb) from (
   select day,topic,count(*) as questions,count(distinct business_id) as cafes
   from recent group by day,topic order by day desc,questions desc) x),
 'pending',(select count(*) from public.agent_turn_logs
   where started_at>=now()-interval '90 days' and question_topic is null)
) $$;
revoke all on function public.admin_pattern_rollup() from public, anon, authenticated;
grant execute on function public.admin_pattern_rollup() to service_role;

-- Proactive sources are intentionally kept separate: a generated in-app update
-- is not evidence of push delivery, and provider acceptance does not mean opened.
create or replace function public.admin_proactive_rollup(p_cafe uuid default null)
returns jsonb language sql stable security invoker set search_path=public as $$
select jsonb_build_object(
 'cafes',(select coalesce(jsonb_agg(to_jsonb(x) order by x.in_app_created + x.outbound_sent desc),'[]'::jsonb) from (
   select b.id as business_id,b.name,
     coalesce(u.created,0) as in_app_created,
     coalesce(u.opened,0) as in_app_opened,
     coalesce(u.acted,0) as in_app_acted,
     coalesce(u.dismissed,0) as in_app_dismissed,
     coalesce(d.sent,0) as outbound_sent,
     coalesce(d.failed,0) as outbound_failed,
     coalesce(d.pending,0) as outbound_pending
   from (select business_id from public.team_updates
         union select business_id from public.ai_delivery_attempts) business
   join public.businesses b on b.id=business.business_id
   left join (
     select business_id,count(*) as created,
       count(*) filter (where status in ('seen','acted','dismissed')) as opened,
       count(*) filter (where status='acted') as acted,
       count(*) filter (where status='dismissed') as dismissed
     from public.team_updates group by business_id
   ) u on u.business_id=business.business_id
   left join (
     select business_id,
       count(*) filter (where state='sent') as sent,
       count(*) filter (where state='failed') as failed,
       count(*) filter (where state='reserved') as pending
     from public.ai_delivery_attempts group by business_id
   ) d on d.business_id=business.business_id
   where p_cafe is null or business.business_id=p_cafe
 ) x),
 'recent_updates',(select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) from (
   select id,business_id,domain,kind,severity,text,status,notified_at,created_at
   from public.team_updates
   where p_cafe is null or business_id=p_cafe
   order by created_at desc,id desc limit 100
 ) x),
 'recent_deliveries',(select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) from (
   select id,business_id,task_id,state,task_status,created_at,sent_at,failure_code
   from public.ai_delivery_attempts
   where p_cafe is null or business_id=p_cafe
   order by created_at desc,id desc limit 100
 ) x)
) $$;
revoke all on function public.admin_proactive_rollup(uuid) from public, anon, authenticated;
grant execute on function public.admin_proactive_rollup(uuid) to service_role;
