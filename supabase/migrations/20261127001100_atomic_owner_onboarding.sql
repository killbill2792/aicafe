-- Existing onboarding is a check-then-create across separate HTTP transactions.
-- Serialize only one user's bootstrap and commit all existing writes atomically.
set lock_timeout='2s';
set statement_timeout='20s';

create function public.ensure_owner_onboarding_business(
  p_owner_user_id uuid, p_name text, p_recovery_order text[]
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_business_id uuid;
begin
  -- Internal service-role bootstrap only; the server supplies auth.getUser().id.
  if p_owner_user_id is null or p_name is null or btrim(p_name)='' or char_length(p_name)>80
    or p_recovery_order is null or cardinality(p_recovery_order)=0 then
    raise exception 'invalid_onboarding_input' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('owner-onboarding:'||p_owner_user_id::text,0));
  if exists(select 1 from public.employees where staff_auth_user_id=p_owner_user_id) then
    raise exception 'staff_account_restricted' using errcode='42501';
  end if;
  select m.business_id into v_business_id from public.memberships m
    join public.businesses b on b.id=m.business_id
    where m.user_id=p_owner_user_id and b.is_demo=false
    order by m.created_at,m.business_id limit 1;
  if v_business_id is not null then return v_business_id; end if;
  insert into public.businesses(name,is_demo) values(p_name,false) returning id into v_business_id;
  insert into public.memberships(business_id,user_id,role,can_see_profit)
    values(v_business_id,p_owner_user_id,'owner',true);
  insert into public.recovery_order(business_id,bucket_code,position)
    select v_business_id,bucket,(position-1)::integer
    from unnest(p_recovery_order) with ordinality as r(bucket,position);
  return v_business_id;
end $$;
revoke all on function public.ensure_owner_onboarding_business(uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.ensure_owner_onboarding_business(uuid,text,text[]) to service_role;
