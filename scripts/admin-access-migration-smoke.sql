-- Executed only against disposable local Supabase after full migration replay.
-- Fail the gate when install, least-privilege, or new-cafe enforcement disappears.
do $admin_access_check$
declare
 function_count integer;
begin
 select count(*) into function_count from pg_proc p
 join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in
 ('initialize_new_cafe_access','redeem_free_access_code',
  'admin_change_cafe_access','admin_code_redemption_counts',
  'guard_ai_team_rule_cafe_access');
 if function_count <> 5 then
   raise exception 'expected five installed admin-access functions, got %',function_count;
 end if;
 if not exists (
   select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
   join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='businesses'
     and t.tgname='initialize_cafe_access' and not t.tgisinternal
 ) then raise exception 'new cafe access trigger missing'; end if;
 if not exists (
   select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
   join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='ai_team_rules'
     and t.tgname='ai_team_rules_cafe_access' and not t.tgisinternal
 ) then raise exception 'direct memory rule access guard missing'; end if;
 if position('new.timezone' in pg_get_functiondef('public.initialize_new_cafe_access()'::regprocedure))=0
 then raise exception 'new cafe expiry must use cafe timezone'; end if;
 if has_function_privilege('authenticated','public.redeem_free_access_code(uuid,text,uuid)','EXECUTE')
 or has_function_privilege('authenticated','public.admin_change_cafe_access(uuid,text,date)','EXECUTE')
 or has_table_privilege('authenticated','public.free_access_codes','SELECT')
 or has_table_privilege('authenticated','public.cafe_access','UPDATE')
 then raise exception 'authenticated access exceeded intended private grants'; end if;
 if not has_function_privilege('service_role','public.redeem_free_access_code(uuid,text,uuid)','EXECUTE')
 then raise exception 'service role cannot redeem codes'; end if;
end $admin_access_check$;
