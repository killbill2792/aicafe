-- 14E: owner-confirmed historical statement evidence in the existing upload table.
-- Not a bank connection, complete account inventory, payment authority or ledger.
set lock_timeout='3s';
set statement_timeout='30s';

alter table public.uploads
 add column financial_owner_user_id uuid references auth.users(id) on delete cascade,
 add column financial_source_sha256 text,
 add column financial_account_key text,
 add column financial_currency text,
 add column financial_from date,
 add column financial_to date,
 add column financial_opening_cents bigint,
 add column financial_closing_cents bigint,
 add column financial_transactions jsonb;
alter table public.uploads add constraint uploads_financial_evidence_shape check (
 (num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents,
  financial_transactions)=0)
 or ((num_nonnulls(financial_owner_user_id,financial_source_sha256,financial_account_key,
  financial_currency,financial_from,financial_to,financial_opening_cents,financial_closing_cents,
  financial_transactions)=9 and kind='statement' and status='done'
  and financial_source_sha256 ~ '^[0-9a-f]{64}$' and financial_account_key ~ '^[0-9a-f]{64}$'
  and financial_currency ~ '^[A-Z]{3}$' and financial_from<=financial_to
  and financial_opening_cents between -9007199254740991 and 9007199254740991
  and financial_closing_cents between -9007199254740991 and 9007199254740991
  and jsonb_typeof(financial_transactions)='array'
  and jsonb_array_length(financial_transactions) between 2 and 10000) is true)
);
create unique index uploads_financial_source_uq on public.uploads
 (business_id,financial_owner_user_id,financial_source_sha256);
create index uploads_financial_account_idx on public.uploads
 (business_id,financial_owner_user_id,financial_account_key,financial_to desc)
 where financial_owner_user_id is not null;

-- Existing member upload policies must not expose or permit forged finance evidence.
create policy financial_upload_owner_read on public.uploads as restrictive for select to authenticated
 using(financial_owner_user_id is null or (financial_owner_user_id=(select auth.uid()) and exists(
  select 1 from public.memberships m where m.business_id=uploads.business_id
  and m.user_id=(select auth.uid()) and m.role='owner')));
create policy financial_upload_no_direct_insert on public.uploads as restrictive for insert to authenticated
 with check(financial_owner_user_id is null);
create policy financial_upload_no_direct_update on public.uploads as restrictive for update to authenticated
 using(financial_owner_user_id is null) with check(financial_owner_user_id is null);
create policy financial_upload_no_direct_delete on public.uploads as restrictive for delete to authenticated
 using(financial_owner_user_id is null);

-- Trusted server passes re-parsed original CSV (only normalized transaction facts, no descriptions).
-- The DB repeats scope/date/currency/chain checks and serializes replay with the source unique key.
create function public.supervisor_record_statement_evidence(
 p_business_id uuid,p_owner_user_id uuid,p_source_sha256 text,p_account_key text,
 p_currency text,p_from date,p_to date,p_opening_cents bigint,p_closing_cents bigint,p_transactions jsonb
) returns uuid language plpgsql security invoker set search_path=public as $$
declare v_id uuid; v_existing public.uploads; v_day date; v_currency text;
 v_row jsonb; v_date date; v_prior date; v_first date; v_running numeric:=p_opening_cents;
 v_amount bigint; v_balance bigint; v_indices integer[]:='{}'; v_index integer;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'service_role_only' using errcode='42501';end if;
 perform 1 from public.memberships m where m.business_id=p_business_id
  and m.user_id=p_owner_user_id and m.role='owner' for share;
 if not found then raise exception 'financial_owner_required' using errcode='42501';end if;
 select (now() at time zone b.timezone)::date,b.currency into v_day,v_currency
  from public.businesses b where b.id=p_business_id and not b.is_demo;
 if v_day is null or v_currency is null or p_currency is distinct from v_currency
  or p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-f]{64}$'
  or p_account_key is null or p_account_key !~ '^[0-9a-f]{64}$'
  or p_from is null or p_to is null or p_to<p_from or p_to>v_day
  or p_opening_cents is null or p_closing_cents is null
  or abs(p_opening_cents::numeric)>9007199254740991 or abs(p_closing_cents::numeric)>9007199254740991
  or jsonb_typeof(p_transactions) is distinct from 'array'
 then raise exception 'financial_statement_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_transactions) not between 2 and 10000 then
  raise exception 'financial_statement_size' using errcode='22023';end if;
 for v_row in select value from jsonb_array_elements(p_transactions) loop
  if jsonb_typeof(v_row) is distinct from 'object' or not (v_row ?& array['i','date','amountCents','balanceCents'])
   or jsonb_typeof(v_row->'i') is distinct from 'number'
   or jsonb_typeof(v_row->'amountCents') is distinct from 'number'
   or jsonb_typeof(v_row->'balanceCents') is distinct from 'number'
   or v_row->>'i' !~ '^[0-9]+$' or v_row->>'amountCents' !~ '^-?[0-9]+$'
   or v_row->>'balanceCents' !~ '^-?[0-9]+$' or v_row->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or (v_row-array['i','date','amountCents','balanceCents'])<>'{}'::jsonb
  then raise exception 'financial_statement_row_invalid' using errcode='22023';end if;
  v_index:=(v_row->>'i')::integer;v_date:=(v_row->>'date')::date;
  v_amount:=(v_row->>'amountCents')::bigint;v_balance:=(v_row->>'balanceCents')::bigint;
  if v_date is null or v_index=any(v_indices) or v_index>=jsonb_array_length(p_transactions)
   or (v_prior is not null and v_date<v_prior) or abs(v_amount::numeric)>9007199254740991
   or abs(v_balance::numeric)>9007199254740991
  then raise exception 'financial_statement_row_invalid' using errcode='22023';end if;
  v_indices:=array_append(v_indices,v_index);
  v_first:=coalesce(v_first,v_date);v_prior:=v_date;
  v_running:=v_running+v_amount;
  if v_running<>v_balance then raise exception 'financial_statement_balance_mismatch' using errcode='22023';end if;
 end loop;
 if v_first is distinct from p_from or v_prior is distinct from p_to or v_running<>p_closing_cents then
  raise exception 'financial_statement_balance_mismatch' using errcode='22023';end if;
 insert into public.uploads(business_id,kind,status,financial_owner_user_id,financial_source_sha256,
  financial_account_key,financial_currency,financial_from,financial_to,financial_opening_cents,
  financial_closing_cents,financial_transactions)
 values(p_business_id,'statement','done',p_owner_user_id,p_source_sha256,p_account_key,p_currency,
  p_from,p_to,p_opening_cents,p_closing_cents,p_transactions)
 on conflict(business_id,financial_owner_user_id,financial_source_sha256) do nothing returning id into v_id;
 if v_id is not null then return v_id;end if;
 select * into v_existing from public.uploads where business_id=p_business_id
  and financial_owner_user_id=p_owner_user_id and financial_source_sha256=p_source_sha256;
 if not found or v_existing.financial_account_key is distinct from p_account_key
  or v_existing.financial_currency is distinct from p_currency
  or v_existing.financial_from is distinct from p_from or v_existing.financial_to is distinct from p_to
  or v_existing.financial_opening_cents is distinct from p_opening_cents
  or v_existing.financial_closing_cents is distinct from p_closing_cents
  or v_existing.financial_transactions is distinct from p_transactions
 then raise exception 'financial_statement_source_conflict' using errcode='22023';end if;
 return v_existing.id;
end $$;
revoke all on function public.supervisor_record_statement_evidence(uuid,uuid,text,text,text,date,date,bigint,bigint,jsonb)
 from public,anon,authenticated;
grant execute on function public.supervisor_record_statement_evidence(uuid,uuid,text,text,text,date,date,bigint,bigint,jsonb) to service_role;
