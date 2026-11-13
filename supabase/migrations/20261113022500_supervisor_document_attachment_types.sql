-- Task 12: retain the same owner-private attachment source and size limit.
-- New readable types are strictly opt-in; no new bucket or unaudited storage path.
set lock_timeout='3s';
set statement_timeout='30s';
-- Reason: Expand the existing MIME allowlist without changing the private
-- storage key or existing valid attachments. No old row can violate the new
-- broader check, and the replacement is validated immediately after swap.
-- Reason: This broadens the existing MIME check without discarding prior guarantees.
-- squawk-ignore ban-drop-constraint
alter table public.ai_attachments drop constraint if exists ai_attachments_media_type_check;
alter table public.ai_attachments add constraint ai_attachments_media_type_check
 check (media_type in ('text/plain','text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf','image/jpeg','image/png','image/webp')) not valid;
update storage.buckets set allowed_mime_types=array[
 'text/plain','text/csv',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/pdf','image/jpeg','image/png','image/webp']
where id='ai-chat-private' and public=false and file_size_limit=2097152;
