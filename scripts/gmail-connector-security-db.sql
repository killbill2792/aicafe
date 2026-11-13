-- Task 11: disposable migrated-database security acceptance (never use production).
-- RLS, SQL grants, unique receipt identities and service-only finalization.
begin;
do $check$
declare relation_name text;
  fully_qualified text;
  receipt_rpc text:='public.supervisor_finish_gmail_effect_attempt(uuid,uuid,uuid,uuid,uuid,integer,text,text,date)';
begin
  foreach relation_name in array array[
    'connector_accounts','connector_credentials','connector_oauth_states',
    'connector_provider_receipts'
  ] loop
    fully_qualified:='public.'||relation_name;
    if not exists(
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r'
        and c.relrowsecurity
    ) then raise exception 'Gmail RLS missing: %',relation_name; end if;
    if has_table_privilege('anon',fully_qualified,'SELECT') or
      has_table_privilege('authenticated',fully_qualified,'SELECT') or
      has_table_privilege('anon',fully_qualified,'INSERT') or
      has_table_privilege('authenticated',fully_qualified,'INSERT') or
      has_table_privilege('authenticated',fully_qualified,'UPDATE') or
      has_table_privilege('authenticated',fully_qualified,'DELETE')
    then raise exception 'Gmail table is not service-only: %',relation_name; end if;
    if not has_table_privilege('service_role',fully_qualified,'SELECT') then
      raise exception 'Gmail service read missing: %',relation_name; end if;
  end loop;
  if to_regprocedure(receipt_rpc) is null then
    raise exception 'Gmail-specific gateway finalizer missing'; end if;
  if has_function_privilege('anon',receipt_rpc,'EXECUTE') or
    has_function_privilege('authenticated',receipt_rpc,'EXECUTE') then
    raise exception 'Gmail effect finalization exposed to browser'; end if;
  if not has_function_privilege('service_role',receipt_rpc,'EXECUTE') then
    raise exception 'Gmail effect finalization unavailable to gateway'; end if;
  if not exists(
    select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid
    where t.relname='connector_provider_receipts' and c.contype='u'
      and pg_get_constraintdef(c.oid) like '%business_id, proposal_id, effect_hash%'
  ) then raise exception 'Gmail duplicate attempt ledger uniqueness missing'; end if;
  if not exists(
    select 1 from pg_indexes i
    where i.schemaname='public' and i.tablename='connector_provider_receipts'
      and i.indexname='connector_provider_receipts_rfc_id'
  ) then raise exception 'Gmail outbound Message-ID deduplication missing'; end if;
end
$check$;
rollback;
