-- Phase 8: owner-entered supplier evidence, never automatically applied to ingredient costs.
create table if not exists ai_supplier_quotes (
 id uuid primary key default gen_random_uuid(),
 business_id uuid not null references businesses(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id),
 client_request_id uuid not null,
 supplier_name text not null check(char_length(btrim(supplier_name)) between 2 and 120),
 item_name text not null check(char_length(btrim(item_name)) between 2 and 120),
 price_cents integer not null check(price_cents between 1 and 100000000),
 package_count integer not null check(package_count between 1 and 100000),
 package_unit text not null check(package_unit in ('each','oz','lb','kg','gal','liter','case')),
 source_kind text not null check(source_kind in ('supplier_email','supplier_quote','public_listing')),
 source_url text check(source_url is null or
    (length(source_url) between 10 and 500 and source_url ~ '^https://')),
 quoted_on date not null,
 evidence_status text not null default 'owner_reported' check(evidence_status='owner_reported'),
 created_at timestamptz not null default now(),
 unique(business_id,owner_user_id,client_request_id)
);
create index if not exists ai_supplier_quotes_business_item_idx on ai_supplier_quotes
 (business_id,item_name,created_at desc);
alter table ai_supplier_quotes enable row level security;
create policy "cafe owners view supplier evidence" on ai_supplier_quotes for select to authenticated
 using(exists (select 1 from memberships m where m.business_id=ai_supplier_quotes.business_id
  and m.user_id=(select auth.uid()) and m.role='owner'));
create policy "owner adds supplier evidence" on ai_supplier_quotes for insert to authenticated
 with check(owner_user_id=(select auth.uid()) and exists(
  select 1 from memberships m where m.business_id=ai_supplier_quotes.business_id
   and m.user_id=(select auth.uid()) and m.role='owner'));
grant select,insert on ai_supplier_quotes to authenticated;
revoke update,delete on ai_supplier_quotes from authenticated;
