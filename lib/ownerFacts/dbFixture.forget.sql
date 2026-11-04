-- Migration 152 on the isolated CI PostgreSQL only: forgetting a saved fact.
set role authenticated;
select set_config('request.jwt.claim.sub',(select user_a::text from public._owner_fact_test_ids),false);
select public.save_owner_fact(business_a,'supplier','"Mill Street Dairy"'::jsonb) from public._owner_fact_test_ids;
select public.save_owner_fact(business_a,'monthly_bills_cents','6000'::jsonb) from public._owner_fact_test_ids;
do $forget$
declare v_business uuid; v_user uuid; v_ok boolean;
begin
 select business_a,user_a into v_business,v_user from public._owner_fact_test_ids;
 if not public.forget_owner_fact(v_business,'supplier') then raise exception 'forget returned false'; end if;
 -- History stays; nothing is current; who forgot it is recorded.
 if (select count(*) from public.owner_facts where business_id=v_business and fact_key='supplier')<>1
  or exists(select 1 from public.owner_facts where business_id=v_business and fact_key='supplier' and superseded_at is null)
  or (select forgotten_by from public.owner_facts where business_id=v_business and fact_key='supplier')<>v_user
 then raise exception 'forget did not close the fact with its author'; end if;
 -- Forgetting again is harmless.
 if public.forget_owner_fact(v_business,'supplier') then raise exception 'second forget claimed a change'; end if;
 -- A fact also on a screen is changed, never forgotten.
 begin perform public.forget_owner_fact(v_business,'monthly_bills_cents'); v_ok:=true;
 exception when others then v_ok:=false; end;
 if v_ok or not exists(select 1 from public.owner_facts where business_id=v_business
   and fact_key='monthly_bills_cents' and superseded_at is null)
 then raise exception 'screen fact was forgotten'; end if;
 -- Saving it again later works as a fresh fact.
 perform public.save_owner_fact(v_business,'supplier','"Valley Milk"'::jsonb);
 if (select value_json from public.owner_facts where business_id=v_business and fact_key='supplier'
   and superseded_at is null)<>'"Valley Milk"'::jsonb then raise exception 'fact not saved after forget'; end if;
end $forget$;
-- A change card is applied whole: a refused value (card fee above 50%) undoes its forget.
do $atomic$
declare v_business uuid; v_ok boolean; v_result jsonb;
begin
 select business_a into v_business from public._owner_fact_test_ids;
 begin
  perform public.change_owner_facts(v_business,'[{"factKey":"card_fee_rate_percent","value":75}]'::jsonb,array['supplier']);
  v_ok:=true;
 exception when others then v_ok:=false; end;
 if v_ok or not exists(select 1 from public.owner_facts where business_id=v_business
   and fact_key='supplier' and superseded_at is null)
 then raise exception 'a refused value left a fact forgotten'; end if;
 -- The same card with a valid value forgets and saves together.
 v_result:=public.change_owner_facts(v_business,'[{"factKey":"opening_note","value":"Open 6:30"}]'::jsonb,array['supplier']);
 if (v_result->>'forgotten')::int<>1 or jsonb_array_length(v_result->'saved')<>1
  or exists(select 1 from public.owner_facts where business_id=v_business and fact_key='supplier' and superseded_at is null)
  or not exists(select 1 from public.owner_facts where business_id=v_business and fact_key='opening_note' and superseded_at is null)
 then raise exception 'change card did not forget and save together'; end if;
 -- A key may not be both forgotten and saved on one card.
 begin
  perform public.change_owner_facts(v_business,'[{"factKey":"opening_note","value":"x"}]'::jsonb,array['opening_note']);
  v_ok:=true;
 exception when others then v_ok:=false; end;
 if v_ok then raise exception 'forget and save of one key accepted'; end if;
 perform public.save_owner_fact(v_business,'supplier','"Valley Milk"'::jsonb);
end $atomic$;
-- Another café's owner cannot forget café A's facts.
select set_config('request.jwt.claim.sub',(select user_b::text from public._owner_fact_test_ids),false);
do $other$
declare v_business uuid; v_ok boolean;
begin
 select business_a into v_business from public._owner_fact_test_ids;
 begin perform public.forget_owner_fact(v_business,'supplier'); v_ok:=true;
 exception when insufficient_privilege then v_ok:=false; end;
 if v_ok then raise exception 'another café forgot a fact'; end if;
end $other$;
reset role;
do $still$
begin
 if not exists(select 1 from public.owner_facts f join public._owner_fact_test_ids t on f.business_id=t.business_a
   where f.fact_key='supplier' and f.superseded_at is null)
 then raise exception 'another café changed café A'; end if;
end $still$;
select 'FORGET_OK';
