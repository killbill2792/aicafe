-- Phase 6: owner-private reference files, not automatic AI ingestion.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ai-chat-private','ai-chat-private',false,2097152,
  array['text/plain','application/pdf','image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
create table if not exists ai_attachments (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null, owner_user_id uuid not null, thread_id uuid not null,
 object_path text not null unique,
 original_name text not null check(length(original_name) between 1 and 150),
 media_type text not null check(media_type in ('text/plain','application/pdf','image/jpeg','image/png','image/webp')),
 bytes integer not null check(bytes between 1 and 2097152),
 processing_state text not null default 'stored_unanalysed' check(processing_state='stored_unanalysed'),
 created_at timestamptz not null default now(),
 foreign key(business_id,thread_id,owner_user_id)
  references ai_threads(business_id,id,owner_user_id) on delete cascade
);
create index if not exists ai_attachments_owner_thread on ai_attachments
 (business_id,owner_user_id,thread_id,created_at desc);
alter table ai_attachments enable row level security;
create policy "owners read their attachments" on ai_attachments for select to authenticated
using(owner_user_id=(select auth.uid()) and exists
 (select 1 from memberships m where m.business_id=ai_attachments.business_id
  and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owners create their attachments" on ai_attachments for insert to authenticated
with check(owner_user_id=(select auth.uid()) and
 object_path like business_id::text||'/'||owner_user_id::text||'/'||thread_id::text||'/'||id::text||'/%'
 and exists (select 1 from memberships m where m.business_id=ai_attachments.business_id
  and m.user_id=(select auth.uid()) and m.role='owner'));
grant select,insert on ai_attachments to authenticated;
revoke update,delete on ai_attachments from authenticated;
-- Storage path: businessId/ownerId/threadId/attachmentId/filename.
create policy "owner upload AI chat objects" on storage.objects for insert to authenticated
with check(bucket_id='ai-chat-private' and exists (
 select 1 from ai_threads t join memberships m on m.business_id=t.business_id
 where t.business_id::text=(storage.foldername(name))[1]
 and t.owner_user_id::text=(storage.foldername(name))[2]
 and t.id::text=(storage.foldername(name))[3] and m.role='owner'
 and m.user_id=(select auth.uid()) and t.owner_user_id=(select auth.uid())
));
create policy "owner read AI chat objects" on storage.objects for select to authenticated
using(bucket_id='ai-chat-private' and exists (
 select 1 from ai_threads t join memberships m on m.business_id=t.business_id
 where t.business_id::text=(storage.foldername(name))[1]
 and t.owner_user_id::text=(storage.foldername(name))[2]
 and t.id::text=(storage.foldername(name))[3] and m.role='owner'
 and m.user_id=(select auth.uid()) and t.owner_user_id=(select auth.uid())
));
create policy "owner cleanup AI chat objects" on storage.objects for delete to authenticated
using(bucket_id='ai-chat-private' and exists (
 select 1 from ai_threads t join memberships m on m.business_id=t.business_id
 where t.business_id::text=(storage.foldername(name))[1]
 and t.owner_user_id::text=(storage.foldername(name))[2]
 and t.id::text=(storage.foldername(name))[3] and m.role='owner'
 and m.user_id=(select auth.uid()) and t.owner_user_id=(select auth.uid())
));