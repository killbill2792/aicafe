-- #562 private signup: render/retry races must not create multiple cafés.
-- This is the existing authenticated server onboarding path, not an auth
-- trigger or a new provisioning flow. Existing membership is never replaced.
set lock_timeout='3s';
set statement_timeout='45s';
create function public.ensure_private_onboarding_cafe(
 p_user_id uuid,p_name text,p_recovery_order text[]
) returns uuid
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_business uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' then
  raise exception 'Service role required' using errcode='42501';
 end if;
 if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then
  raise exception 'onboarding_identity_invalid' using errcode='42501';
 end if;
 -- Transaction-scoped per-user lock; no second business can be allocated
 -- by this path until its membership and defaults are committed.
 perform pg_advisory_xact_lock(hashtextextended('private-cafe-onboarding:'||p_user_id::text,0));
 if exists(select 1 from public.employees where staff_auth_user_id=p_user_id) then
  raise exception 'staff_account_restricted' using errcode='42501';
 end if;
 select m.business_id into v_business
 from public.memberships m join public.businesses b on b.id=m.business_id
 where m.user_id=p_user_id and b.is_demo=false
 order by m.business_id limit 1;
 if v_business is not null then return v_business; end if;
 insert into public.businesses(name,is_demo)
 values(coalesce(nullif(left(btrim(p_name),80),''),'My café'),false)
 returning id into v_business;
 insert into public.memberships(business_id,user_id,role,can_see_profit)
 values(v_business,p_user_id,'owner',true);
 insert into public.recovery_order(business_id,bucket_code,position)
 select v_business,code,(ordinality-1)::integer
 from unnest(p_recovery_order) with ordinality as items(code,ordinality);
 return v_business;
end;
$$;
revoke all on function public.ensure_private_onboarding_cafe(uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.ensure_private_onboarding_cafe(uuid,text,text[]) to service_role;
