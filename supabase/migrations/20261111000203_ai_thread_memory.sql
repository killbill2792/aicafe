-- One bounded, provenance-checked recap on the existing private thread row.
-- No separate memory table, reader, job, or live-turn integration is introduced.
alter table public.ai_threads
  add column memory_summary jsonb not null default
    '{"version":1,"revision":0,"cursor":null,"entries":[],"tombstones":[],"retry":null}'::jsonb;

alter table public.ai_threads
  add constraint ai_threads_memory_summary_shape check (
    case when jsonb_typeof(memory_summary) = 'object' then
      (memory_summary - array['version','revision','cursor','entries','tombstones','retry']) = '{}'::jsonb
      and memory_summary ?& array['version','revision','cursor','entries','tombstones','retry']
      and memory_summary->>'version' = '1'
      and coalesce(memory_summary->>'revision','') ~ '^(0|[1-9][0-9]{0,8})$'
      and case when jsonb_typeof(memory_summary->'entries') = 'array'
        then jsonb_array_length(memory_summary->'entries') <= 20 else false end
      and case when jsonb_typeof(memory_summary->'tombstones') = 'array'
        then jsonb_array_length(memory_summary->'tombstones') <= 40 else false end
      and case when memory_summary->'cursor' = 'null'::jsonb then true
        when jsonb_typeof(memory_summary->'cursor') = 'object' then
          (memory_summary->'cursor' - array['createdAt','id']) = '{}'::jsonb
          and memory_summary->'cursor' ?& array['createdAt','id']
        else false end
      and case when memory_summary->'retry' = 'null'::jsonb then true
        when jsonb_typeof(memory_summary->'retry') = 'object' then
          (memory_summary->'retry' - array['code','at']) = '{}'::jsonb
          and memory_summary->'retry' ?& array['code','at']
        else false end
    else false end
  );

comment on column public.ai_threads.memory_summary is
  'Bounded nonfinancial owner-authored thread context; provenance and revision are validated by save_ai_thread_memory.';

-- Authenticated owner-only CAS. SECURITY DEFINER is required because the
-- append-only ai_threads table deliberately has no authenticated UPDATE grant.
-- Identity, exact thread scope and current owner membership are rechecked here.
create function public.save_ai_thread_memory(
  p_business_id uuid,
  p_owner_user_id uuid,
  p_thread_id uuid,
  p_expected_revision bigint,
  p_memory_summary jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $save_thread_memory$
declare
  v_current jsonb;
  v_revision bigint;
  v_new_revision bigint;
  v_cursor jsonb;
  v_cursor_id uuid;
  v_cursor_at timestamptz;
  v_current_cursor_id uuid;
  v_current_cursor_at timestamptz;
  v_entry jsonb;
  v_tombstone jsonb;
  v_kind text;
  v_key text;
  v_text text;
  v_source_id text;
  v_source_uuid uuid;
  v_source_at_text text;
  v_source_at timestamptz;
  v_entry_revision_text text;
  v_entry_revision bigint;
  v_retry_at timestamptz;
begin
  if auth.uid() is null or auth.uid() is distinct from p_owner_user_id
    or p_expected_revision is null or p_expected_revision < 0
    or p_expected_revision = 9223372036854775807 then
    return jsonb_build_object('ok',false,'reason','unauthorized');
  end if;

  select t.memory_summary into v_current
  from public.ai_threads t
  where t.id = p_thread_id
    and t.business_id = p_business_id
    and t.owner_user_id = p_owner_user_id
    and exists (
      select 1 from public.memberships m
      where m.business_id = t.business_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  for update;

  if not found then
    return jsonb_build_object('ok',false,'reason','unauthorized');
  end if;
  v_revision := (v_current->>'revision')::bigint;
  if v_revision <> p_expected_revision then
    return jsonb_build_object('ok',false,'reason','stale_revision','revision',v_revision);
  end if;

  if p_memory_summary is null or jsonb_typeof(p_memory_summary) <> 'object' then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;
  if (p_memory_summary - array['version','revision','cursor','entries','tombstones','retry']) <> '{}'::jsonb
    or not (p_memory_summary ?& array['version','revision','cursor','entries','tombstones','retry'])
    or p_memory_summary->>'version' is distinct from '1'
    or coalesce(p_memory_summary->>'revision','') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(p_memory_summary->'entries') is distinct from 'array'
    or jsonb_typeof(p_memory_summary->'tombstones') is distinct from 'array' then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;
  v_new_revision := (p_memory_summary->>'revision')::bigint;
  if v_new_revision <> p_expected_revision + 1
    or jsonb_array_length(p_memory_summary->'entries') > 20
    or jsonb_array_length(p_memory_summary->'tombstones') > 40 then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;

  v_cursor := p_memory_summary->'cursor';
  if v_cursor <> 'null'::jsonb then
    if jsonb_typeof(v_cursor) is distinct from 'object'
      or (v_cursor - array['createdAt','id']) <> '{}'::jsonb
      or not (v_cursor ?& array['createdAt','id'])
      or coalesce(v_cursor->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_cursor->>'createdAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    begin
      v_cursor_id := (v_cursor->>'id')::uuid;
      v_cursor_at := (v_cursor->>'createdAt')::timestamptz;
    exception when others then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end;
    if not exists (
      select 1 from public.ai_messages m
      where m.id = v_cursor_id
        and m.business_id = p_business_id
        and m.owner_user_id = p_owner_user_id
        and m.thread_id = p_thread_id
        and m.created_at = v_cursor_at
    ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
  else
    v_cursor_id := null;
    v_cursor_at := null;
  end if;

  if v_current->'cursor' <> 'null'::jsonb then
    begin
      v_current_cursor_id := (v_current->'cursor'->>'id')::uuid;
      v_current_cursor_at := (v_current->'cursor'->>'createdAt')::timestamptz;
    exception when others then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end;
    if v_cursor_at is null or
      (v_cursor_at, v_cursor_id) < (v_current_cursor_at, v_current_cursor_id) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
  else
    v_current_cursor_id := null;
    v_current_cursor_at := null;
  end if;
  if v_cursor_at is null and (
    jsonb_array_length(p_memory_summary->'entries') > 0
    or jsonb_array_length(p_memory_summary->'tombstones') > 0
  ) then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;

  for v_entry in select value from jsonb_array_elements(p_memory_summary->'entries') loop
    if jsonb_typeof(v_entry) is distinct from 'object'
      or (v_entry - array['kind','key','text','sourceMessageId','sourceAt','revision']) <> '{}'::jsonb
      or not (v_entry ?& array['kind','key','text','sourceMessageId','sourceAt','revision']) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    v_kind := v_entry->>'kind';
    v_key := v_entry->>'key';
    v_text := v_entry->>'text';
    v_source_id := v_entry->>'sourceMessageId';
    v_source_at_text := v_entry->>'sourceAt';
    v_entry_revision_text := v_entry->>'revision';
    if v_kind not in ('preference','decision','goal','open_work')
      or not (
        (v_kind = 'preference' and v_key ~ '^preference:[a-z][a-z_-]{0,59}$')
        or (v_kind = 'decision' and v_key ~ '^decision:[a-z][a-z_-]{0,59}$')
        or (v_kind = 'goal' and v_key ~ '^goal:[a-z][a-z_-]{0,59}$')
        or (v_kind = 'open_work' and v_key ~ '^open_work:[a-z][a-z_-]{0,59}$')
      )
      or v_text is null or char_length(v_text) not between 3 and 240
      or btrim(v_text) <> v_text
      or v_text ~ '[[:digit:]٠-٩۰-۹$€£¥₹₽₩₺₫₪₦₱]'
      or v_text ~* '\m(price|prices|pricing|sales|revenue|income|profit|profits|cost|costs|payroll|wages?|salaries|salary|rent|bills?|bank|cash|fees?|margin|tax|refunds?|tips?|expenses?|financial|money|invoices?|payments?|discounts?|break[- ]even|budget|balance|transaction|metrics?|kpis?|unit sales)\M'
      or v_text ~* '\m(password|passcode|api[ _-]?key|secret|token|credential|authorization|permission|consent|approval|approved|authorize|mandate|execute|transfer|purchase|payout)\M'
      or coalesce(v_source_id,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_source_at_text,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or coalesce(v_entry_revision_text,'') !~ '^[1-9][0-9]{0,8}$' then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    begin
      v_source_uuid := v_source_id::uuid;
      v_source_at := v_source_at_text::timestamptz;
      v_entry_revision := v_entry_revision_text::bigint;
    exception when others then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end;
    if v_entry_revision > v_new_revision
      or v_cursor_at is null
      or (v_source_at, v_source_uuid) > (v_cursor_at, v_cursor_id)
      or not exists (
        select 1 from public.ai_messages m
        where m.id = v_source_uuid
          and m.business_id = p_business_id
          and m.owner_user_id = p_owner_user_id
          and m.thread_id = p_thread_id
          and m.role = 'owner'
          and m.created_at = v_source_at
          and position(v_text in regexp_replace(btrim(m.text_content), '[[:space:]]+', ' ', 'g')) > 0
      ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    if v_current_cursor_at is not null and
      (v_source_at, v_source_uuid) <= (v_current_cursor_at, v_current_cursor_id)
      and not exists (
        select 1 from jsonb_array_elements(v_current->'entries') old(value)
        where old.value->>'key' = v_key
          and old.value->>'kind' = v_kind
          and old.value->>'text' = v_text
          and old.value->>'sourceMessageId' = v_source_id
          and old.value->>'sourceAt' = v_source_at_text
      ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_current->'entries') old(value)
      where old.value->>'key' = v_key
        and not (
          old.value->>'kind' = v_kind and old.value->>'text' = v_text
          and old.value->>'sourceMessageId' = v_source_id
          and old.value->>'sourceAt' = v_source_at_text
        )
        and (v_source_at, v_source_uuid) <= (
          (old.value->>'sourceAt')::timestamptz,
          (old.value->>'sourceMessageId')::uuid
        )
    ) or exists (
      select 1 from jsonb_array_elements(v_current->'tombstones') old(value)
      where old.value->>'key' = v_key
        and (v_source_at, v_source_uuid) <= (
          (old.value->>'sourceAt')::timestamptz,
          (old.value->>'sourceMessageId')::uuid
        )
    ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
  end loop;

  for v_tombstone in select value from jsonb_array_elements(p_memory_summary->'tombstones') loop
    if jsonb_typeof(v_tombstone) is distinct from 'object'
      or (v_tombstone - array['key','sourceMessageId','sourceAt','revision']) <> '{}'::jsonb
      or not (v_tombstone ?& array['key','sourceMessageId','sourceAt','revision']) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    v_key := v_tombstone->>'key';
    v_source_id := v_tombstone->>'sourceMessageId';
    v_source_at_text := v_tombstone->>'sourceAt';
    v_entry_revision_text := v_tombstone->>'revision';
    if coalesce(v_key,'') !~ '^(preference|decision|goal|open_work):[a-z][a-z_-]{0,59}$'
      or coalesce(v_source_id,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(v_source_at_text,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or coalesce(v_entry_revision_text,'') !~ '^[1-9][0-9]{0,8}$' then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    begin
      v_source_uuid := v_source_id::uuid;
      v_source_at := v_source_at_text::timestamptz;
      v_entry_revision := v_entry_revision_text::bigint;
    exception when others then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end;
    if v_entry_revision > v_new_revision or v_cursor_at is null
      or (v_source_at, v_source_uuid) > (v_cursor_at, v_cursor_id)
      or not exists (
        select 1 from public.ai_messages m
        where m.id = v_source_uuid
          and m.business_id = p_business_id
          and m.owner_user_id = p_owner_user_id
          and m.thread_id = p_thread_id
          and m.role = 'owner'
          and m.created_at = v_source_at
      ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    if v_current_cursor_at is not null and
      (v_source_at, v_source_uuid) <= (v_current_cursor_at, v_current_cursor_id)
      and not exists (
        select 1 from jsonb_array_elements(v_current->'tombstones') old(value)
        where old.value->>'key' = v_key
          and old.value->>'sourceMessageId' = v_source_id
          and old.value->>'sourceAt' = v_source_at_text
      ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    if not exists (
      select 1 from jsonb_array_elements(v_current->'entries') old(value)
      where old.value->>'key' = v_key
    ) and not exists (
      select 1 from jsonb_array_elements(v_current->'tombstones') old(value)
      where old.value->>'key' = v_key
        and old.value->>'sourceMessageId' = v_source_id
        and old.value->>'sourceAt' = v_source_at_text
    ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_current->'entries') old(value)
      where old.value->>'key' = v_key
        and (v_source_at, v_source_uuid) <= (
          (old.value->>'sourceAt')::timestamptz,
          (old.value->>'sourceMessageId')::uuid
        )
    ) or exists (
      select 1 from jsonb_array_elements(v_current->'tombstones') old(value)
      where old.value->>'key' = v_key
        and (v_source_at, v_source_uuid) <= (
          (old.value->>'sourceAt')::timestamptz,
          (old.value->>'sourceMessageId')::uuid
        )
        and not (
          old.value->>'sourceMessageId' = v_source_id
          and old.value->>'sourceAt' = v_source_at_text
        )
    ) then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
  end loop;

  -- Existing keys cannot silently disappear: every removal leaves a
  -- tombstone, and a forgotten key can return only as a newer explicit entry.
  if exists (
    select 1 from jsonb_array_elements(v_current->'entries') old(value)
    where not exists (
      select 1 from jsonb_array_elements(p_memory_summary->'entries') fresh(value)
      where fresh.value->>'key' = old.value->>'key'
    ) and not exists (
      select 1 from jsonb_array_elements(p_memory_summary->'tombstones') fresh(value)
      where fresh.value->>'key' = old.value->>'key'
    )
  ) or exists (
    select 1 from jsonb_array_elements(v_current->'tombstones') old(value)
    where not exists (
      select 1 from jsonb_array_elements(p_memory_summary->'tombstones') fresh(value)
      where fresh.value->>'key' = old.value->>'key'
    ) and not exists (
      select 1 from jsonb_array_elements(p_memory_summary->'entries') fresh(value)
      where fresh.value->>'key' = old.value->>'key'
    )
  ) then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_memory_summary->'entries') e(value)
    join jsonb_array_elements(p_memory_summary->'tombstones') t(value)
      on e.value->>'key' = t.value->>'key'
  ) then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_memory_summary->'entries') e(value)
    group by e.value->>'key' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_memory_summary->'tombstones') t(value)
    group by t.value->>'key' having count(*) > 1
  ) then
    return jsonb_build_object('ok',false,'reason','invalid_summary');
  end if;

  if p_memory_summary->'retry' <> 'null'::jsonb then
    if jsonb_typeof(p_memory_summary->'retry') is distinct from 'object'
      or (p_memory_summary->'retry' - array['code','at']) <> '{}'::jsonb
      or not (p_memory_summary->'retry' ?& array['code','at'])
      or p_memory_summary->'retry'->>'code' not in ('provider_error','invalid_summary','storage_error')
      or coalesce(p_memory_summary->'retry'->>'at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
    begin
      v_retry_at := (p_memory_summary->'retry'->>'at')::timestamptz;
    exception when others then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end;
    if v_cursor is distinct from v_current->'cursor' then
      return jsonb_build_object('ok',false,'reason','invalid_summary');
    end if;
  end if;

  update public.ai_threads
  set memory_summary = p_memory_summary
  where id = p_thread_id and business_id = p_business_id and owner_user_id = p_owner_user_id;
  return jsonb_build_object('ok',true,'revision',v_new_revision);
end;
$save_thread_memory$;

revoke all on function public.save_ai_thread_memory(uuid,uuid,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.save_ai_thread_memory(uuid,uuid,uuid,bigint,jsonb)
  to authenticated;
