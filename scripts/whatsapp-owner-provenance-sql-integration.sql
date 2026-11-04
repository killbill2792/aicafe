-- Migrations 149 and 150 on a disposable database (never production).
-- A WhatsApp owner turn can carry exactly its provenance stamp; nothing else can,
-- supervisor rows keep every rule, and a signed-in owner inserting from the website
-- can never stamp provenance. Everything runs in one transaction that rolls back.
-- Run after replaying every migration: psql -v ON_ERROR_STOP=1 -f this-file.
begin;
insert into auth.users(id,phone,phone_confirmed_at) values
  ('a1000000-0000-4000-8000-000000000001','+15550001111',now());
insert into public.businesses(id,name,timezone,currency) values
  ('b1000000-0000-4000-8000-000000000001','Provenance Test Café','UTC','USD');
insert into public.memberships(business_id,user_id,role) values
  ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','owner');
insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values
  ('c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001',gen_random_uuid());

-- Server side (no RLS): the constraint alone decides.
do $$
declare
  biz constant uuid:='b1000000-0000-4000-8000-000000000001';
  thr constant uuid:='c1000000-0000-4000-8000-000000000001';
  own constant uuid:='a1000000-0000-4000-8000-000000000001';
  stamp constant jsonb:='{"sourceChannel":"whatsapp","receivedAt":"2026-11-04T09:38:52.000Z","attachmentIds":[]}';
  bad jsonb;
  owner_row uuid;
begin
  -- Owner turn saved first with no grounding, then stamped: exactly what
  -- markWhatsAppOwnerProvenance does. Before migration 149 this update failed.
  insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,
    text_content,client_message_id)
  values(biz,thr,own,own,'owner','text','Where did my money go yesterday?',gen_random_uuid())
  returning id into owner_row;
  update public.ai_messages set grounding=stamp where id=owner_row and grounding is null;
  if not found or (select grounding->>'sourceChannel' from public.ai_messages where id=owner_row)<>'whatsapp'
    then raise exception 'whatsapp stamp was not stored'; end if;
  -- Up to three attachment ids are part of the stamp.
  update public.ai_messages set grounding=jsonb_set(stamp,'{attachmentIds}',
    '["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"]')
    where id=owner_row;

  -- Anything that is not exactly the stamp is refused on an owner row.
  foreach bad in array array[
    '{"sourceChannel":"web","receivedAt":"2026-11-04T09:38:52.000Z","attachmentIds":[]}'::jsonb,
    stamp||'{"status":"verified"}'::jsonb,
    jsonb_set(stamp,'{receivedAt}','12345'),
    jsonb_set(stamp,'{receivedAt}','"x"'),
    jsonb_set(stamp,'{attachmentIds}','"none"'),
    jsonb_set(stamp,'{attachmentIds}','["a","b","c","d"]'),
    stamp-'attachmentIds',
    '[]'::jsonb
  ] loop
    begin
      update public.ai_messages set grounding=bad where id=owner_row;
      raise exception 'owner grounding accepted: %',bad;
    exception when check_violation then null;
    end;
  end loop;
  -- Owner rows still never carry structured content.
  begin
    update public.ai_messages set structured_content='[{"type":"text","text":"x"}]' where id=owner_row;
    raise exception 'owner structured_content accepted';
  exception when check_violation then null;
  end;

  -- Supervisor rows keep every rule. (The live requires_owner_input rule passes
  -- when ownerInput is absent; saved rows rely on that, so it is left as it was.)
  insert into public.ai_messages(business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding)
  values(biz,thr,own,'supervisor','blocks','[{"type":"text","text":"ok"}]','{"status":"partial"}');
  foreach bad in array array[
    '{"sourceChannel":"whatsapp","receivedAt":"2026-11-04T09:38:52.000Z","attachmentIds":[]}'::jsonb,
    '{"status":"made_up"}'::jsonb,
    '{"status":"requires_owner_input","ownerInput":"not an object"}'::jsonb
  ] loop
    begin
      insert into public.ai_messages(business_id,thread_id,owner_user_id,role,content_type,structured_content,grounding)
      values(biz,thr,own,'supervisor','blocks','[{"type":"text","text":"no"}]',bad);
      raise exception 'supervisor grounding accepted: %',bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- Website side: a signed-in owner under RLS.
set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role='authenticated';
-- An ordinary website message (no grounding) is still allowed.
insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,
  text_content,client_message_id)
values('b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','owner','text',
  'Hello from the website',gen_random_uuid());
-- The same owner can never insert a WhatsApp provenance stamp.
do $$
begin
  insert into public.ai_messages(business_id,thread_id,owner_user_id,author_user_id,role,content_type,
    text_content,client_message_id,grounding)
  values('b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','owner','text',
    'Forged WhatsApp turn',gen_random_uuid(),
    '{"sourceChannel":"whatsapp","receivedAt":"2026-11-04T09:38:52.000Z","attachmentIds":[]}');
  raise exception 'website insert stamped whatsapp provenance';
exception when insufficient_privilege then null;
end $$;
-- And can never update a row to add one (no update grant or policy exists).
do $$
begin
  update public.ai_messages set grounding=
    '{"sourceChannel":"whatsapp","receivedAt":"2026-11-04T09:38:52.000Z","attachmentIds":[]}'
  where text_content='Hello from the website';
  raise exception 'website update stamped whatsapp provenance';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'whatsapp owner provenance: ok' as result;
rollback;
