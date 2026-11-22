-- #553: existing Toast ingress, current SQL readers and shared registered tools only.
-- Additive: no operational data writes or new store; existing invoker-RLS applies.
set lock_timeout='5s';
set statement_timeout='45s';
create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $path$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$'
  and not exists (
   select 1 from unnest(string_to_array(substr(p_col,6),'.')) s(part)
   where regexp_replace(part,'_','','g') ~* '^(pan|primaryAccountNumber|cardNumber|paymentCardNumber|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|track1|track2|trackData|track1Data|track2Data|cardLast4|last4Digits|lastFour|first5|first6|first5Digits|first6Digits|expiration|expiry|expireDate|expirationDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|oauthToken|bearerToken|apiSecret|token|tokenId|fingerprint|networkTransactionIdentifier|routingNumber|bankAccountNumber|accountNumber|signature|last4|firstFive|firstSix|expirationMonth|expirationYear|expiryMonth|expiryYear|expMonth|expYear|cardExpMonth|cardExpYear|cardExpirationMonth|cardExpirationYear|networkId)$'
      or regexp_replace(part,'_','','g') ~* '(Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|AuthorizationToken|OAuthToken|BearerToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$'
      or regexp_replace(part,'_','','g') ~* '^(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$'
  )
  and not (
   p_col ~* '^data\.(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)\.(number|value|last4|first5|first6|first5Digits|first6Digits|lastFour|maskedNumber|expirationDate|expiryDate|expiryMonth|expiryYear|expMonth|expYear|holderName|cardholderName|networkId|networkTransactionIdentifier|accountId|accountNumber|tokenId)(\.|$)'
  )
 then string_to_array(substr(p_col,6),'.') end $path$;

revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;

-- History remains the original rollup; live data uses the same saved
-- toast_today_live reading as Home and the existing registered today tool.
-- The closed-day rollup takes precedence to prevent overlapping money.
create or replace view public.cv_sales_hours
 (business_id,source,source_ref,status,business_date,net_sales_cents,orders_count,data)
 with (security_invoker=true) as
select h.business_id,'app'::text,
 'hour:'||h.business_date::text||':'||h.hour_local::text||':'||coalesce(h.location_id::text,'all'),
 'actual'::text,h.business_date,h.net_sales_cents,h.orders_count,
 jsonb_build_object('hour_local',h.hour_local,'location_id',h.location_id,
  'net_sales_cents',h.net_sales_cents,'orders_count',h.orders_count)
from public.hourly_sales_rollup h
union all
select t.business_id,'toast'::text,
 'live-hour:'||t.business_date::text||':'||(hour.value->>'hourLocal'),
 'provisional'::text,t.business_date,
 (hour.value->>'netSalesCents')::bigint,(hour.value->>'ordersCount')::integer,
 jsonb_build_object(
   'hour_local',(hour.value->>'hourLocal')::integer,
   'location_id',null,'net_sales_cents',(hour.value->>'netSalesCents')::bigint,
   'orders_count',(hour.value->>'ordersCount')::integer,
   'source_as_of',t.read_at,
   'hourly_unassigned_orders',t.reading->'hourlyUnassignedOrders',
   'locations_failed',t.reading->'locationsFailed',
   'truncated',t.reading->'truncated',
   'unparsed_orders',t.reading->'unparsedOrders')
from public.toast_today_live t
cross join lateral jsonb_array_elements(
 case when jsonb_typeof(t.reading->'hourlySales')='array'
 then t.reading->'hourlySales' else '[]'::jsonb end) hour(value)
where not exists(select 1 from public.hourly_sales_rollup closed
 where closed.business_id=t.business_id and closed.business_date=t.business_date)
 and hour.value->>'hourLocal' ~ '^([0-9]|1[0-9]|2[0-3])$'
 and hour.value->>'netSalesCents' ~ '^-?[0-9]{1,15}$'
 and hour.value->>'ordersCount' ~ '^[0-9]{1,10}$';
revoke all on public.cv_sales_hours from public,anon;
grant select on public.cv_sales_hours to authenticated,service_role;


-- Keep the #539 identity/visit semantics; avoid materializing all unlinked
-- checks and unrelated cost lines in historical visit queries.
create or replace function public.customer_visits_for(p_business_id uuid,p_from date,p_to date)
returns table(business_id uuid,source text,source_ref text,status text,business_date date,
 identity_ref text,identity_state text,restaurant_ref text,order_ref text,
 eligible_check_count bigint,net_sales_cents bigint,known_money_check_count bigint,
 first_observed_date date,last_observed_date date,previous_observed_date date,next_observed_date date,
 observed_visit_number bigint,days_since_previous integer,days_since_last_observed integer,
 first_observed_visit integer,returning_visit integer,
 observed_return_7d integer,observed_return_30d integer,observed_return_60d integer,observed_return_90d integer,
 history_start_date date,as_of_date date,
 period_account_visits bigint,period_account_net_sales_cents bigint,
 period_account_revenue_share numeric,period_account_revenue_share_squared numeric,
 history_account_net_sales_cents bigint,
 observed_prior_cadence_days numeric,observed_reactivation_gap_ratio numeric,observed_lapse_gap_ratio numeric,
 order_duration_seconds bigint,observed_lapse_flag integer,observed_reappearance_flag integer,
 historical_recipe_cost_cents bigint,historical_recipe_contribution_cents bigint)
language sql stable security invoker set search_path=public as $visits$
 with checks as materialized (
  select r.business_id,r.business_date,r.status,r.order_ref,r.check_ref,
   r.data#>>'{aiCafeCustomer,identityRef}' identity_ref,
   r.data#>>'{aiCafeCustomer,identityState}' identity_state,
   r.data#>>'{aiCafeCustomer,restaurantRef}' restaurant_ref,
   r.data#>>'{aiCafeCustomer,visitRef}' visit_ref,
   (r.data#>>'{aiCafeCustomer,netSalesCents}')::bigint net_cents,
   (r.data#>>'{aiCafeCustomer,orderDurationSeconds}')::bigint duration_seconds,
   least(coalesce(p_to,(now() at time zone b.timezone)::date),
    (now() at time zone b.timezone)::date) as_of
  from public.toast_records_for(p_business_id,null,p_to) r
  join public.businesses b on b.id=r.business_id
  where r.record_type='check' and r.counts_in_sales and r.business_date is not null
    and nullif(r.data#>>'{aiCafeCustomer,identityRef}','') is not null
    and nullif(r.data#>>'{aiCafeCustomer,visitRef}','') is not null
   and r.business_date<=least(coalesce(p_to,(now() at time zone b.timezone)::date),
    (now() at time zone b.timezone)::date)
 ), historical_costs as materialized (
  select * from public.customer_historical_recipe_cost_items(p_business_id,p_from,p_to)
 ), source_items as materialized (
  select r.business_id,r.business_date,r.order_ref,r.check_ref,r.record_ref,r.status,
   r.data#>>'{aiCafeCustomer,restaurantRef}' restaurant_ref,
   r.data#>>'{item,guid}' product_ref,
   case when jsonb_typeof(r.data->'quantity')='number' then (r.data->>'quantity')::numeric end quantity
  from public.toast_records_for(p_business_id,p_from,p_to) r
  where r.record_type='item' and r.counts_in_sales
   and exists(select 1 from historical_costs hc where hc.business_date=r.business_date)
   and exists(select 1 from checks ck where ck.business_id=r.business_id
    and ck.business_date=r.business_date and ck.order_ref=r.order_ref
    and ck.check_ref=r.check_ref)
 ), matched_lines as (
  select s.*,o.id normalized_order_id,o.net_sales_cents normalized_order_net,
   case when s.status='actual' and s.quantity>0 and s.quantity=l.quantity
    and l.pos_item_id='toast:'||s.restaurant_ref||':'||s.product_ref
    and l.menu_item_id=hc.menu_item_id and hc.unit_cost_microcents>0
    and coalesce(l.modifiers,'[]'::jsonb) in ('[]'::jsonb,'{}'::jsonb)
    then s.quantity*hc.unit_cost_microcents end cost_micros
  from source_items s
  left join public.orders o on o.business_id=s.business_id and o.business_date=s.business_date
   and o.pos_order_id='toast:'||s.restaurant_ref||':'||s.order_ref and not o.toast_excluded and o.superseded_by is null
  left join public.order_lines l on l.order_id=o.id and l.pos_line_id=s.record_ref and not l.voided
  left join historical_costs hc on hc.business_date=s.business_date and hc.menu_item_id=l.menu_item_id
 ), verified_orders as (
  -- One exact provider-order/selection mapping for every nonvoid normalized
  -- line; raw check net must reconcile independently to the normalized order.
  select m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.normalized_order_id
  from matched_lines m
  join lateral (
   select count(*) n,count(distinct c.check_ref) unique_n,count(c.net_cents) money_n,sum(c.net_cents) net,
    bool_and(c.status='actual') actual
   from checks c where c.business_id=m.business_id and c.restaurant_ref=m.restaurant_ref
    and c.order_ref=m.order_ref and c.business_date=m.business_date
  ) c on c.n=c.unique_n and c.n=c.money_n and c.n>0 and c.actual and c.net=m.normalized_order_net
  where m.normalized_order_id is not null
   and exists(select 1 from checks c where c.business_id=m.business_id and c.restaurant_ref=m.restaurant_ref
    and c.order_ref=m.order_ref and c.business_date=m.business_date and c.check_ref=m.check_ref)
  group by m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.normalized_order_id
  having count(*)=count(distinct m.record_ref) and count(*)=count(m.cost_micros)
   and count(*)=(select count(*) from public.order_lines l where l.order_id=m.normalized_order_id and not l.voided)
   and not exists(select 1 from source_items s where s.business_id=m.business_id and s.restaurant_ref=m.restaurant_ref
    and s.order_ref=m.order_ref and s.business_date=m.business_date
    and not exists(select 1 from checks c where c.business_id=s.business_id and c.restaurant_ref=s.restaurant_ref
     and c.order_ref=s.order_ref and c.business_date=s.business_date and c.check_ref=s.check_ref))
 ), check_costs as (
  select m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.check_ref,sum(m.cost_micros) cost_micros
  from matched_lines m join verified_orders v using(business_id,restaurant_ref,order_ref,business_date,normalized_order_id)
  group by m.business_id,m.restaurant_ref,m.order_ref,m.business_date,m.check_ref
 ), coverage as (
  select business_id,restaurant_ref,min(business_date) history_start
  from checks group by business_id,restaurant_ref
 ), grouped as (
  select c.business_id,c.identity_ref,c.restaurant_ref,c.order_ref,c.visit_ref,
   min(c.identity_state) identity_state,min(c.business_date) business_date,
   case when bool_and(c.status='actual') then 'actual' else 'provisional' end status,
   count(*) check_count,count(c.net_cents) known_money,
   case when count(*)=count(c.net_cents) and count(*)=count(distinct c.check_ref)
    and abs(sum(c.net_cents))<=9007199254740991 then sum(c.net_cents)::bigint end net_cents,
   min(c.as_of) as_of,
   case when count(c.duration_seconds)=count(*) and min(c.duration_seconds)=max(c.duration_seconds) then min(c.duration_seconds) end duration_seconds,
   case when count(cc.cost_micros)=count(*) and count(*)=count(distinct c.check_ref)
    and sum(cc.cost_micros)>=0 and round(sum(cc.cost_micros)/1000000)<=9007199254740991
    then round(sum(cc.cost_micros)/1000000)::bigint end recipe_cost
  from checks c left join check_costs cc on cc.business_id=c.business_id and cc.restaurant_ref=c.restaurant_ref
   and cc.order_ref=c.order_ref and cc.business_date=c.business_date and cc.check_ref=c.check_ref
  where c.identity_ref is not null and c.visit_ref is not null
  group by c.business_id,c.identity_ref,c.restaurant_ref,c.order_ref,c.visit_ref
  having count(distinct c.business_date)=1
 ), timeline as (
  select g.*,
   min(g.business_date) over person first_day,max(g.business_date) over person last_day,
   lag(g.business_date) over visits prev_day,lead(g.business_date) over visits next_day,
   row_number() over visits visit_number,
   sum(g.net_cents) over person history_net,
   count(g.net_cents) over person history_money_count,
   count(*) over person history_visits
  from grouped g
  window person as (partition by g.business_id,g.restaurant_ref,g.identity_ref),
   visits as (partition by g.business_id,g.restaurant_ref,g.identity_ref order by g.business_date,g.visit_ref)
 ), period_accounts as (
  -- Only visits in the requested period, but ordinal/recency history is not
  -- clipped at the period start. One aggregate per scoped account.
  select business_id,restaurant_ref,identity_ref,count(*) visits,
   case when count(*)=count(net_cents) and abs(sum(net_cents))<=9007199254740991
    then sum(net_cents)::bigint end net
  from timeline where (p_from is null or business_date>=p_from)
  group by business_id,restaurant_ref,identity_ref
 ), period_totals as (
  select business_id,case when count(*)=count(net) and min(net)>=0 and sum(net)>0
   then sum(net) end total
  from period_accounts group by business_id
 ), cadence as (
  -- Use positive date gaps only. Same-day order sequence is not a
  -- cadence measurement. Need two prior observed gaps, not one.
  select t.*,
   avg(t.business_date-t.prev_day) filter(where t.business_date>t.prev_day) over prior_gaps prior_cadence,
   count(*) filter(where t.business_date>t.prev_day) over prior_gaps prior_gap_count,
   avg(t.business_date-t.prev_day) filter(where t.business_date>t.prev_day) over through_gaps last_cadence,
   count(*) filter(where t.business_date>t.prev_day) over through_gaps last_gap_count
  from timeline t
  window prior_gaps as (partition by t.business_id,t.restaurant_ref,t.identity_ref order by t.business_date,t.visit_ref
   rows between unbounded preceding and 1 preceding),
   through_gaps as (partition by t.business_id,t.restaurant_ref,t.identity_ref order by t.business_date,t.visit_ref
   rows between unbounded preceding and current row)
 )
 select t.business_id,'toast'::text,t.visit_ref,t.status,t.business_date,
  t.identity_ref,t.identity_state,t.restaurant_ref,t.order_ref,t.check_count,t.net_cents,t.known_money,
  t.first_day,t.last_day,t.prev_day,t.next_day,t.visit_number,
  t.business_date-t.prev_day,t.as_of-t.last_day,
  (t.visit_number=1)::integer,(t.visit_number>1)::integer,
  -- NULL unless the FIRST observed cohort's whole source horizon elapsed
  -- and was imported complete. Zero is "none observed", not proof of churn.
  case when t.visit_number=1 and t.status='actual' and c.days7=8 and t.business_date+7<=t.as_of
   then coalesce((t.next_day<=t.business_date+7)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days30=31 and t.business_date+30<=t.as_of
   then coalesce((t.next_day<=t.business_date+30)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days60=61 and t.business_date+60<=t.as_of
   then coalesce((t.next_day<=t.business_date+60)::integer,0) end,
  case when t.visit_number=1 and t.status='actual' and c.days90=91 and t.business_date+90<=t.as_of
   then coalesce((t.next_day<=t.business_date+90)::integer,0) end,
  h.history_start,t.as_of,
  -- Account facts occur once at the last visit through the cutoff.
  -- The period denominator is all *linked* accounts, not all sales.
  case when t.next_day is null then a.visits end,
  case when t.next_day is null then a.net end,
  case when t.next_day is null then a.net::numeric/nullif(p.total,0) end,
  case when t.next_day is null then power(a.net::numeric/nullif(p.total,0),2) end,
  case when t.next_day is null and t.history_money_count=t.history_visits
   and abs(t.history_net)<=9007199254740991 then t.history_net::bigint end,
  case when t.prior_gap_count>=2 and cadence_days.through_visit=t.business_date-t.first_day+1
   then t.prior_cadence end,
  case when t.prior_gap_count>=2 and t.business_date>t.prev_day
   and cadence_days.through_visit=t.business_date-t.first_day+1
   then (t.business_date-t.prev_day)::numeric/nullif(t.prior_cadence,0) end,
  case when t.next_day is null and t.last_gap_count>=2
   and cadence_days.through_as_of=t.as_of-t.first_day+1
   then (t.as_of-t.last_day)::numeric/nullif(t.last_cadence,0) end,
  t.duration_seconds,
  -- Two typical positive gaps overdue is a review heuristic, not proof a
  -- person left. Non-last rows and incomplete histories remain NULL.
  case when t.next_day is null and t.last_gap_count>=2
   and cadence_days.through_as_of=t.as_of-t.first_day+1
   then ((t.as_of-t.last_day)::numeric>=2*t.last_cadence)::integer end,
  case when t.prior_gap_count>=2 and t.business_date>t.prev_day
   and cadence_days.through_visit=t.business_date-t.first_day+1
   then ((t.business_date-t.prev_day)::numeric>=2*t.prior_cadence)::integer end,
  t.recipe_cost,
  case when t.net_cents is not null and t.recipe_cost is not null
    and abs(t.net_cents::numeric-t.recipe_cost)<=9007199254740991
   then t.net_cents-t.recipe_cost end
 from cadence t
 join coverage h on h.business_id=t.business_id and h.restaurant_ref=t.restaurant_ref
 left join period_accounts a on a.business_id=t.business_id and a.restaurant_ref=t.restaurant_ref and a.identity_ref=t.identity_ref
 left join period_totals p on p.business_id=t.business_id
 left join lateral (
  select count(*) filter(where ds.business_date<=t.business_date) through_visit,count(*) through_as_of
  from public.toast_day_status ds
  where (t.prior_gap_count>=2 or (t.next_day is null and t.last_gap_count>=2))
   and ds.business_id=t.business_id and ds.restaurant_guid::text=t.restaurant_ref
   and ds.business_date between t.first_day and case when t.next_day is null then t.as_of else t.business_date end
   and ds.import_state='imported' and ds.coverage_complete and ds.unparsed_count=0
   and ds.recon_state not in ('mismatch','owner_flagged')
 ) cadence_days on true
 left join lateral (
  select count(*) filter(where ds.business_date<=t.business_date+7) days7,
   count(*) filter(where ds.business_date<=t.business_date+30) days30,
   count(*) filter(where ds.business_date<=t.business_date+60) days60,
   count(*) days90
  from public.toast_day_status ds
  where t.visit_number=1 and ds.business_id=t.business_id
   and ds.restaurant_guid::text=t.restaurant_ref
   and ds.business_date between t.business_date and least(t.business_date+90,t.as_of)
   and ds.import_state='imported' and ds.coverage_complete and ds.unparsed_count=0
   and ds.recon_state not in ('mismatch','owner_flagged')
 ) c on true
 where (p_from is null or t.business_date>=p_from)
 and (p_to is null or t.business_date<=p_to)
$visits$;

revoke all on function public.customer_visits_for(uuid,date,date) from public,anon;
grant execute on function public.customer_visits_for(uuid,date,date) to authenticated,service_role;
