-- Deleting a café failed when it had Toast catalog rows. The delete first clears
-- links on those rows (ON DELETE SET NULL), and the archive trigger from
-- migration 111 saved each passing update into toast_raw_records under the café
-- being deleted; the foreign key to businesses rejected it, so the whole delete
-- rolled back. Archive a staged row only while its café still exists. Nothing
-- else changes: a café that exists is archived exactly as before.
-- Replacing one small function takes only a brief lock, so short limits are enough.
set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.toast_archive_stage_trigger()
returns trigger language plpgsql security definer set search_path=public as $archive$
begin
 if exists(select 1 from public.businesses b
           where b.id=nullif(to_jsonb(new)->>'business_id','')::uuid) then
  perform public.toast_archive_stage_snapshot(to_jsonb(new),tg_argv[0],tg_table_name);
 end if;
 return new;
end $archive$;
