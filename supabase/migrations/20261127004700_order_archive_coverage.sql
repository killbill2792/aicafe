alter table public.external_resources add column last_complete_scope jsonb;
comment on column public.external_resources.last_complete_scope is
  'Scope confirmed by the latest complete observation. A verified business date does not claim complete coverage of other dates.';

-- Toast's closeout already has the authoritative completed-window receipt.
-- Publish that evidence with the shared resource without issuing another fetch.
create function public.external_note_toast_order_coverage()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare complete boolean; observed timestamptz:=clock_timestamp();
begin
 if new.import_state='missing' then return new; end if;
 if tg_op='UPDATE' and (new.import_state,new.coverage_complete,new.unparsed_count,new.last_import_run_id)
   is not distinct from (old.import_state,old.coverage_complete,old.unparsed_count,old.last_import_run_id)
 then return new; end if;
 complete:=new.import_state='imported' and new.coverage_complete
   and new.unparsed_count=0 and new.last_import_run_id is not null;

 insert into public.external_resources as r
  (business_id,provider,source_account,resource,status,last_attempt_at,last_complete_at,last_complete_scope)
 values(new.business_id,'toast',new.restaurant_guid::text,'order',
   case when complete then 'current' when new.import_state='failed' then 'unavailable' else 'incomplete' end,
   observed,case when complete then observed end,
   case when complete then jsonb_build_object('business_date',new.business_date,'run_id',new.last_import_run_id) end)
 on conflict (business_id,provider,source_account,resource) do update
 set status=excluded.status,last_attempt_at=excluded.last_attempt_at,
     last_complete_at=coalesce(excluded.last_complete_at,r.last_complete_at),
     last_complete_scope=coalesce(excluded.last_complete_scope,r.last_complete_scope);
 return new;
end $$;
revoke all on function public.external_note_toast_order_coverage() from public,anon,authenticated;
create trigger external_note_toast_order_coverage after insert or
 update of import_state,coverage_complete,unparsed_count,last_import_run_id on public.toast_day_status
 for each row execute function public.external_note_toast_order_coverage();
