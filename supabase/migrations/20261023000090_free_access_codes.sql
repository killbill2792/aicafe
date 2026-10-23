-- Free codes are private operational records. Existing cafés are grandfathered.
-- Safe to re-run. All code/redemption writes happen through service-only server calls.
create table if not exists public.free_access_codes (
 id uuid primary key default gen_random_uuid(),
 code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
 code_hint text not null,
 duration_months integer check (duration_months between 1 and 120),
 fixed_end_date date,
 max_cafes integer not null check (max_cafes between 1 and 100000),
 note text check (note is null or char_length(note)<=500),
 active boolean not null default true,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 check ((duration_months is not null) <> (fixed_end_date is not null))
);
create table if not exists public.cafe_access (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 mode text not null default 'grandfathered' check (mode in ('grandfathered','code','paused')),
 code_id uuid references public.free_access_codes(id) on delete set null,
 access_end date,
 updated_at timestamptz not null default now(),
 check (mode <> 'code' or access_end is not null)
);
create table if not exists public.free_access_redemptions (
 id uuid primary key default gen_random_uuid(),
 code_id uuid not null references public.free_access_codes(id) on delete cascade,
 business_id uuid not null references public.businesses(id) on delete cascade,
 redeemed_by uuid references auth.users(id) on delete set null,
 redeemed_at timestamptz not null default now(),
 access_end date not null,
 unique (code_id,business_id)
);
create index if not exists free_access_redemptions_cafe_idx on public.free_access_redemptions(business_id,redeemed_at desc);
create table if not exists public.free_access_redeem_limits (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 window_start timestamptz not null default now(),
 attempts integer not null default 0
);
-- Migration-time snapshot. An absent café_access row is also treated as
-- grandfathered to avoid lockout during deployments/new café onboarding.
insert into public.cafe_access(business_id,mode)
select id,'grandfathered' from public.businesses on conflict (business_id) do nothing;
alter table public.free_access_codes enable row level security;
alter table public.cafe_access enable row level security;
alter table public.free_access_redemptions enable row level security;
alter table public.free_access_redeem_limits enable row level security;
revoke all on public.free_access_codes,public.cafe_access,public.free_access_redemptions,public.free_access_redeem_limits from public,anon,authenticated;
grant select,insert,update,delete on public.free_access_codes,public.cafe_access,public.free_access_redemptions,public.free_access_redeem_limits to service_role;

-- Atomic redemption: throttle even incorrect codes; lock the code row before
-- checking/incrementing its unique café count. Re-redeems don't consume another slot.
create or replace function public.redeem_free_access_code(
 p_business_id uuid,p_code_hash text,p_owner_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
 v_limit public.free_access_redeem_limits%rowtype;
 v_code public.free_access_codes%rowtype;
 v_access public.cafe_access%rowtype;
 v_used bigint;
 v_end date;
 v_today date := (now() at time zone 'UTC')::date;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'service_role_only' using errcode='42501';
 end if;
 if p_code_hash !~ '^[a-f0-9]{64}$' or p_business_id is null or p_owner_id is null then
   return jsonb_build_object('status','invalid');
 end if;
 -- An insert conflict serializes competing attempts for a café.
 insert into public.free_access_redeem_limits(business_id,window_start,attempts)
 values(p_business_id,now(),1)
 on conflict (business_id) do update set
   attempts=case when public.free_access_redeem_limits.window_start<now()-interval '15 minutes'
     then 1 else public.free_access_redeem_limits.attempts+1 end,
   window_start=case when public.free_access_redeem_limits.window_start<now()-interval '15 minutes'
     then now() else public.free_access_redeem_limits.window_start end
 returning * into v_limit;
 if v_limit.attempts>5 then
   return jsonb_build_object('status','rate_limited');
 end if;
 select * into v_code from public.free_access_codes
   where code_hash=p_code_hash and active=true for update;
 if not found then return jsonb_build_object('status','invalid'); end if;
 if v_code.fixed_end_date is not null and v_code.fixed_end_date<v_today then
   return jsonb_build_object('status','expired_code');
 end if;
 insert into public.cafe_access(business_id,mode)
 values(p_business_id,'grandfathered') on conflict (business_id) do nothing;
 select * into v_access from public.cafe_access where business_id=p_business_id for update;
 if v_access.mode = 'paused' then
   return jsonb_build_object('status','paused_cafe');
 end if;
 -- A café redeeming the same code may extend; first-time cafés count once.
 if not exists (select 1 from public.free_access_redemptions
      where code_id=v_code.id and business_id=p_business_id) then
   select count(*) into v_used from public.free_access_redemptions where code_id=v_code.id;
   if v_used>=v_code.max_cafes then
     return jsonb_build_object('status','full');
   end if;
 end if;
 if v_code.duration_months is not null then
   v_end := (greatest(v_today,case when v_access.mode='code' then v_access.access_end else v_today end)
               + make_interval(months=>v_code.duration_months))::date;
 else
   v_end := greatest(v_code.fixed_end_date,
             case when v_access.mode='code' then v_access.access_end else v_today end);
 end if;
 insert into public.free_access_redemptions(code_id,business_id,redeemed_by,access_end)
 values(v_code.id,p_business_id,p_owner_id,v_end)
 on conflict (code_id,business_id) do update
 set redeemed_by=excluded.redeemed_by,redeemed_at=now(),
     access_end=greatest(public.free_access_redemptions.access_end,excluded.access_end);
 -- A grandfathered café remains unlimited until an ADMIN explicitly changes
 -- its mode. Redeeming a promotional code must not silently remove the guarantee.
 if v_access.mode <> 'grandfathered' then
   update public.cafe_access
      set mode='code',code_id=v_code.id,access_end=v_end,updated_at=now()
    where business_id=p_business_id;
 end if;
 return jsonb_build_object('status','ok','access_end',v_end);
end $$;
revoke all on function public.redeem_free_access_code(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.redeem_free_access_code(uuid,text,uuid) to service_role;

-- Admin override and extension share the same café row lock as redemption.
-- This prevents a stale browser action from undoing a pause.
create or replace function public.admin_change_cafe_access(
 p_business_id uuid, p_action text, p_access_end date default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_access public.cafe_access%rowtype;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'service_role_only' using errcode='42501';
 end if;
 if p_action not in ('extend','grandfathered','paused') then
   return jsonb_build_object('status','invalid');
 end if;
 insert into public.cafe_access(business_id,mode) values(p_business_id,'grandfathered')
 on conflict (business_id) do nothing;
 select * into v_access from public.cafe_access where business_id=p_business_id for update;
 if p_action='extend' then
   if v_access.mode='paused' then return jsonb_build_object('status','paused_cafe'); end if;
   if p_access_end is null or p_access_end < (now() at time zone 'UTC')::date then
     return jsonb_build_object('status','invalid_end_date');
   end if;
   if v_access.mode='code' and v_access.access_end>=p_access_end then
     return jsonb_build_object('status','not_an_extension');
   end if;
   update public.cafe_access set mode='code', access_end=p_access_end, updated_at=now()
     where business_id=p_business_id;
 else
   update public.cafe_access set mode=p_action, code_id=null, access_end=null,updated_at=now()
     where business_id=p_business_id;
 end if;
 return jsonb_build_object('status','ok');
end $$;
revoke all on function public.admin_change_cafe_access(uuid,text,date) from public,anon,authenticated;
grant execute on function public.admin_change_cafe_access(uuid,text,date) to service_role;

-- Once audit topic labels are derived, permanently eliminate any text that may
-- have been written by older implementations before allowlist-only logging.
update public.agent_turn_logs set
 question='Owner question withheld',
 final_answer=case when final_answer is not null then 'Assistant answer withheld' else null end,
 error_text=case when error_text is not null then 'agent_turn_failed' else null end,
 owner_feedback_comment=case when owner_feedback_comment is not null then '[comment withheld]' else null end,
 question_topic=coalesce(question_topic,'other'),topic_version=1
where question <> 'Owner question withheld'
   or (final_answer is not null and final_answer <> 'Assistant answer withheld')
   or owner_feedback_comment is not null and owner_feedback_comment <> '[comment withheld]'
   or topic_version<1;
update public.agent_turn_steps set
 input_summary=null,output_summary=null,
 error=case when error is not null then 'step_failed' else null end
where input_summary is not null or output_summary is not null or error is not null;

-- This aggregate deliberately covers ALL historical redemptions, not the
-- latest 500 ledger rows rendered by the admin console.
create or replace function public.admin_code_redemption_counts()
returns jsonb language sql stable security invoker set search_path=public as $$
 select coalesce(jsonb_object_agg(code_id,cafe_count),'{}'::jsonb)
 from (select code_id::text as code_id,count(*)::integer as cafe_count
       from public.free_access_redemptions group by code_id) as all_redemptions;
$$;
revoke all on function public.admin_code_redemption_counts() from public,anon,authenticated;
grant execute on function public.admin_code_redemption_counts() to service_role;
