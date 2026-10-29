-- The only database populated here is the isolated CI PostgreSQL service.
set role authenticated;
select set_config('request.jwt.claim.sub',
 (select user_a::text from public._owner_fact_test_ids),false);
select public.save_owner_fact(business_a,'payroll_extras_monthly_cents','4200'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'payroll_extras_monthly_cents','5100'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'monthly_bills_cents','5000'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'monthly_bills_cents','6000'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact_answers(business_a,$answers$[
 {"factKey":"card_fee_rate_percent","value":2.9},
 {"factKey":"card_sales_share_percent","value":80},
 {"factKey":"card_transactions_share_percent","value":75},
 {"factKey":"card_fixed_fee_cents","value":10},
 {"factKey":"card_average_ticket_cents","value":1250},
 {"factKey":"card_processor_label","value":"Owner processor"}
]$answers$::jsonb) from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'milk_base_type','"whole milk"'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'milk_ml:16oz','160'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'milk_base_serving_cost_cents:16oz','40'::jsonb)
 from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'milk_almond_serving_cost_cents:16oz','90'::jsonb)
 from public._owner_fact_test_ids;
do $proof$
declare v_business uuid;
begin
 select business_a into v_business from public._owner_fact_test_ids;
 if (select count(*) from public.owner_facts
   where business_id=v_business and fact_key='payroll_extras_monthly_cents'
     and superseded_at is null)<>1
 or (select count(*) from public.owner_facts
   where business_id=v_business and fact_key='payroll_extras_monthly_cents'
     and superseded_at is not null)<>1
 then raise exception 'owner fact version/supersede failure'; end if;
 if (select count(*) from public.owner_facts
   where business_id=v_business and fact_key='monthly_bills_cents')<>2
 then raise exception 'owner bills did not supersede'; end if;
end $proof$;
-- A fresh thread reads these scoped persisted facts, never mock rows.
select 'FACTS_JSON='||coalesce(jsonb_agg(jsonb_build_object(
 'fact_key',fact_key,'value_json',value_json,'created_at',created_at,
 'unit',unit,'period_scope',period_scope) order by fact_key),'[]'::jsonb)::text
from public.owner_facts
where business_id=(select business_a from public._owner_fact_test_ids)
 and superseded_at is null;
-- Switching the authenticated user must hide every row from café A.
select set_config('request.jwt.claim.sub',
 (select user_b::text from public._owner_fact_test_ids),false);
do $isolation$
declare v_business uuid;
begin
 select business_a into v_business from public._owner_fact_test_ids;
 if (select count(*) from public.owner_facts where business_id=v_business)<>0
 then raise exception 'cross-cafe RLS leak'; end if;
end $isolation$;
-- Write privileges cannot bypass the audited RPC.
reset role;
do $write_through$
declare v_business uuid;
begin
 select business_a into v_business from public._owner_fact_test_ids;
 if (select owner_monthly_payroll_extras_cents from public.businesses
      where id=v_business)<>5100
 then raise exception 'payroll extras screen write-through failed'; end if;
 if (select coalesce(sum(amount_cents),0) from public.recurring_costs
      where business_id=v_business and (active_to is null or active_to>=current_date)
      and active_from<=current_date)<>6000
 then raise exception 'bill residual screen write-through failed'; end if;
 if (select count(*) from public.recurring_costs
      where business_id=v_business and source='owner' and amount_cents=3000
        and label='Owner reported monthly bills' and active_from<=current_date
        and (active_to is null or active_to>=current_date))<>1
 then raise exception 'owner bill residual missing or duplicated'; end if;
 if (select count(*) from public.processing_fee_rate_plans
     where business_id=v_business and effective_from<=current_date
       and (effective_to is null or effective_to>=current_date)
       and (rules->0->>'percentageBps')::int=290
       and processed_sales_share_bps=8000
       and processed_transaction_share_bps=7500)<>1
 then raise exception 'complete processing plan write-through failed'; end if;
end $write_through$;
