set lock_timeout = '1s';
set statement_timeout = '5s';
-- Observation history, never retroactive effective recipe claims. Baseline is
-- captured only when the existing café refresh actually observes source rows.
create table public.catalog_cost_history_start (
 business_id uuid primary key references public.businesses(id) on delete cascade,
 observed_at timestamptz not null default clock_timestamp()
);
create table public.catalog_cost_history (
 id bigint generated always as identity primary key,
 business_id uuid not null references public.businesses(id) on delete cascade,
 kind text not null check(kind in ('recipe_line','ingredient_price','combo_component')),
 entity_id uuid not null,
 row_id uuid not null,
 observed_at timestamptz not null default clock_timestamp(),
 present boolean not null,
 quantity numeric,
 effective_from date,
 price_micros bigint,
 price_recorded_at timestamptz
);
create index catalog_cost_history_lookup on public.catalog_cost_history
 (business_id,kind,entity_id,row_id,observed_at desc,id desc);
-- Reason: New private table has RLS enabled before any client grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.catalog_cost_history_start enable row level security;
-- Reason: New private table has RLS enabled before any client grant.
-- squawk-ignore ban-alter-row-level-security
alter table public.catalog_cost_history enable row level security;
revoke all on public.catalog_cost_history_start,public.catalog_cost_history from public,anon,authenticated;
-- Even service callers cannot rewrite observation history through normal APIs.
revoke all on public.catalog_cost_history_start,public.catalog_cost_history from service_role;

create function public.catalog_cost_record_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_old jsonb;v_new jsonb;v_row jsonb;v_kind text;v_entity uuid;v_key uuid;v_business uuid;v_present boolean;
begin
 if tg_op<>'INSERT' then v_old:=to_jsonb(old);end if;
 if tg_op<>'DELETE' then v_new:=to_jsonb(new);end if;
 if tg_op='UPDATE' and v_old=v_new then return null;end if;
 -- Row changes, not full catalog snapshots. Multiple concurrent edits of
 -- distinct recipe lines cannot overwrite each others' history.
 if tg_table_name='recipe_lines' then v_kind:='recipe_line';
 elsif tg_table_name='ingredient_prices' then v_kind:='ingredient_price';
 elsif tg_table_name='menu_combo_components' then v_kind:='combo_component';
 else raise exception 'catalog_history_source_invalid';end if;
 for v_row,v_present in select v.row_data,v.present from
  (values (v_old,false,0),(v_new,true,1)) v(row_data,present,seq)
  where v.row_data is not null order by v.seq loop
  if v_kind='recipe_line' then
   v_entity:=(v_row->>'menu_item_id')::uuid;v_key:=(v_row->>'ingredient_id')::uuid;
   select business_id into v_business from public.menu_items where id=v_entity;
  elsif v_kind='ingredient_price' then
   v_entity:=(v_row->>'ingredient_id')::uuid;v_key:=(v_row->>'id')::uuid;
   select business_id into v_business from public.ingredients where id=v_entity;
  else
   v_entity:=(v_row->>'combo_item_id')::uuid;v_key:=(v_row->>'component_item_id')::uuid;
   v_business:=(v_row->>'business_id')::uuid;
  end if;
  -- A cascading parent deletion cannot certify a future recipe; the reader
  -- also requires current tenant identity and rejects removed ingredients.
  if v_business is not null and exists(select 1 from public.businesses where id=v_business) then
   insert into public.catalog_cost_history(business_id,kind,entity_id,row_id,present,quantity,effective_from,price_micros,price_recorded_at)
   values(v_business,v_kind,v_entity,v_key,v_present,(v_row->>'quantity')::numeric,
    (v_row->>'effective_from')::date,(v_row->>'cost_per_base_unit_micros')::bigint,(v_row->>'recorded_at')::timestamptz);
  end if;
 end loop;
 return null;
end $$;
revoke all on function public.catalog_cost_record_change() from public,anon,authenticated,service_role;
create trigger catalog_recipe_history after insert or update or delete on public.recipe_lines
 for each row execute function public.catalog_cost_record_change();
create trigger catalog_price_history after insert or update or delete on public.ingredient_prices
 for each row execute function public.catalog_cost_record_change();
create trigger catalog_combo_history after insert or update or delete on public.menu_combo_components
 for each row execute function public.catalog_cost_record_change();

create function public.supervisor_capture_catalog_cost_baseline(p_business_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(
 select 1 from public.businesses where id=p_business_id and not is_demo)
 then raise exception 'catalog_baseline_scope_invalid' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-cost-baseline:'||p_business_id::text,0));
 if exists(select 1 from public.catalog_cost_history_start where business_id=p_business_id) then return false;end if;
 -- Hold the source rows against edits until observation is committed. New
 -- rows are independently captured by their insert trigger. No old-dated seed.
 insert into public.catalog_cost_history(business_id,kind,entity_id,row_id,present,quantity)
 select p_business_id,'recipe_line',r.menu_item_id,r.ingredient_id,true,r.quantity
 from public.recipe_lines r join public.menu_items m on m.id=r.menu_item_id
 where m.business_id=p_business_id for share of r;
 insert into public.catalog_cost_history(business_id,kind,entity_id,row_id,present,effective_from,price_micros,price_recorded_at)
 select p_business_id,'ingredient_price',p.ingredient_id,p.id,true,p.effective_from,p.cost_per_base_unit_micros,p.recorded_at
 from public.ingredient_prices p join public.ingredients i on i.id=p.ingredient_id
 where i.business_id=p_business_id for share of p;
 insert into public.catalog_cost_history(business_id,kind,entity_id,row_id,present)
 select p_business_id,'combo_component',c.combo_item_id,c.component_item_id,true
 from public.menu_combo_components c where c.business_id=p_business_id for share of c;
 insert into public.catalog_cost_history_start(business_id) values(p_business_id);
 return true;
end $$;
revoke all on function public.supervisor_capture_catalog_cost_baseline(uuid) from public,anon,authenticated;
grant execute on function public.supervisor_capture_catalog_cost_baseline(uuid) to service_role;

-- Independent reconciliation proof for the existing deterministic theoretical
-- ingredient-cost basis. The money total continues to come from daily_rollups.
-- No unsupported modifier/combination/changed-during-day recipe is certified.
create function public.read_historical_ingredient_cost_proof(p_business_id uuid,p_from date,p_to date)
returns table(business_date date,ingredients_cents bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if (coalesce(auth.role(),'')<>'service_role' and (auth.uid() is null or not public.is_member(p_business_id)))
 or p_business_id is null or p_from is null or p_to is null or p_to<p_from or p_to-p_from>370
 then raise exception 'catalog_history_scope_invalid' using errcode='42501';end if;
 return query
 with days as (
  select d.business_date,d.net_sales_cents,d.orders_count,d.drinks_count,d.ingredients_cents,
    d.voids_status,d.voids_source,
    (d.business_date::timestamp at time zone b.timezone) as start_at,
    ((d.business_date+1)::timestamp at time zone b.timezone) as end_at
  from public.daily_rollups d join public.businesses b on b.id=d.business_id
  join public.catalog_cost_history_start h on h.business_id=d.business_id
  where d.business_id=p_business_id and d.business_date between p_from and p_to
    and d.sales_data_status='actual' and h.observed_at<=(d.business_date::timestamp at time zone b.timezone)
    and d.business_date<(statement_timestamp() at time zone b.timezone)::date
 ), active_orders as (
  select o.id,o.business_date,o.net_sales_cents,o.pos_order_id from public.orders o
  join days d on d.business_date=o.business_date
  where o.business_id=p_business_id and not o.toast_excluded and o.superseded_by is null
 ), order_totals as (
  select o.business_date,count(*) n,sum(o.net_sales_cents) net,bool_or(o.pos_order_id like 'toast:%') toast
  from active_orders o group by o.business_date
 ), sold as (
  select o.business_date,l.menu_item_id,sum(l.quantity) qty,
   sum(l.net_sales_cents) net,
   bool_or(l.quantity<=0 or l.menu_item_id is null or
    (l.modifiers is not null and l.modifiers not in ('[]'::jsonb,'{}'::jsonb))) unsupported
  from active_orders o join public.order_lines l on l.order_id=o.id
  where not l.voided group by o.business_date,l.menu_item_id
 ), recipe_state as (
  select s.business_date,s.menu_item_id,s.qty,s.net,s.unsupported,d.start_at,d.end_at,
   coalesce((select jsonb_agg(jsonb_build_object('ingredient',v.row_id,'quantity',v.quantity)) from (
    select distinct on(h.row_id) h.row_id,h.present,h.quantity
    from public.catalog_cost_history h where h.business_id=p_business_id
     and h.kind='recipe_line' and h.entity_id=s.menu_item_id and h.observed_at<=d.start_at
    order by h.row_id,h.observed_at desc,h.id desc
   ) v where v.present),'[]'::jsonb) recipe
  from sold s join days d on d.business_date=s.business_date
 ), supported as (
  select r.*,
   not r.unsupported and r.menu_item_id is not null and jsonb_array_length(r.recipe)>0
   and exists(select 1 from public.menu_items m where m.id=r.menu_item_id and m.business_id=p_business_id)
   and not exists(select 1 from public.catalog_cost_history h where h.business_id=p_business_id
     and h.entity_id=r.menu_item_id and (h.kind='combo_component' or
       (h.kind='recipe_line' and h.observed_at>r.start_at and h.observed_at<r.end_at)))
   as supported_recipe
  from recipe_state r
 ), costs as (
  select r.business_date,r.menu_item_id,r.qty,r.net,r.supported_recipe,
    count(*) filter(where line.ingredient is not null) line_count,
    count(*) filter(where line.quantity>0 and i.id is not null and cost.price_micros>0
     and not exists(select 1 from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='ingredient_price'
      and h.entity_id=line.ingredient and h.observed_at>r.start_at and h.observed_at<r.end_at)) priced_count,
    sum(line.quantity*cost.price_micros) micros
  from supported r
  left join lateral jsonb_to_recordset(r.recipe) as line(ingredient uuid,quantity numeric) on true
  left join public.ingredients i on i.id=line.ingredient and i.business_id=p_business_id
  left join lateral (
   select v.price_micros from (
    select distinct on(h.row_id) h.row_id,h.present,h.effective_from,h.price_micros,h.price_recorded_at
    from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='ingredient_price'
     and h.entity_id=line.ingredient and h.observed_at<=r.start_at
    order by h.row_id,h.observed_at desc,h.id desc
   ) v where v.present and v.effective_from<=r.business_date
   order by v.effective_from desc,v.price_recorded_at desc,v.row_id desc limit 1
  ) cost on true
  group by r.business_date,r.menu_item_id,r.qty,r.net,r.supported_recipe
 ), item_totals as (
  select c.business_date,sum(c.qty) qty,sum(c.net) net,
    round(sum(c.qty*c.micros)/1000000)::bigint ingredients,
    bool_and(c.supported_recipe and c.line_count>0 and c.line_count=c.priced_count) complete
  from costs c group by c.business_date
 )
 select d.business_date,d.ingredients_cents::bigint from days d
 join order_totals o on o.business_date=d.business_date
 join item_totals i on i.business_date=d.business_date
 where i.complete and o.n=d.orders_count and o.net=d.net_sales_cents
   and i.qty=d.drinks_count and i.net=d.net_sales_cents and i.ingredients=d.ingredients_cents
   and (not o.toast or (d.voids_status='complete' and d.voids_source='toast'
    and not exists(select 1 from public.toast_owner_attention_days_v a
      where a.business_id=p_business_id and a.business_date=d.business_date)))
 order by d.business_date;
end $$;
revoke all on function public.read_historical_ingredient_cost_proof(uuid,date,date) from public,anon;
grant execute on function public.read_historical_ingredient_cost_proof(uuid,date,date) to authenticated,service_role;

-- Prior observed recipe configuration and prices. No current recipe is
-- substituted for missing history. Keep the single RPC result bounded.
create function public.supervisor_prior_recipe_evidence(p_business_id uuid,p_as_of date)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare cutoff timestamptz; result jsonb; row_count bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' or p_business_id is null or p_as_of is null then
  raise exception 'catalog_history_scope_invalid' using errcode='42501';end if;
 select (p_as_of+1)::timestamp at time zone b.timezone into cutoff
 from public.businesses b join public.catalog_cost_history_start h on h.business_id=b.id
 where b.id=p_business_id and not b.is_demo
 and h.observed_at<(p_as_of+1)::timestamp at time zone b.timezone
 and p_as_of<(statement_timestamp() at time zone b.timezone)::date;
 if cutoff is null then return null;end if;
 with recipe as (
  select distinct on(h.entity_id,h.row_id) h.entity_id,h.row_id,h.quantity,h.present
  from public.catalog_cost_history h join public.menu_items m on m.id=h.entity_id and m.business_id=p_business_id
  where h.business_id=p_business_id and h.kind='recipe_line' and h.observed_at<cutoff
  order by h.entity_id,h.row_id,h.observed_at desc,h.id desc
 ), combo as (
  select distinct on(h.entity_id,h.row_id) h.entity_id,h.present
  from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='combo_component' and h.observed_at<cutoff
  order by h.entity_id,h.row_id,h.observed_at desc,h.id desc
 ), price_revisions as (
  select distinct on(h.entity_id,h.row_id) h.entity_id,h.row_id,h.effective_from,h.price_micros,h.price_recorded_at,h.present
  from public.catalog_cost_history h where h.business_id=p_business_id and h.kind='ingredient_price' and h.observed_at<cutoff
  order by h.entity_id,h.row_id,h.observed_at desc,h.id desc
 ), prices as (
  select distinct on(p.entity_id) p.entity_id,p.price_micros
  from price_revisions p where p.present and p.effective_from<=p_as_of
  order by p.entity_id,p.effective_from desc,p.price_recorded_at desc,p.row_id desc
 ), evidence as (
  select r.entity_id as product_id,r.row_id as ingredient_id,r.quantity,
   case when i.id is not null then p.price_micros else null end as price_micros
  from recipe r left join public.ingredients i on i.id=r.row_id and i.business_id=p_business_id
  left join prices p on p.entity_id=r.row_id
  where r.present and not exists(select 1 from combo c where c.entity_id=r.entity_id and c.present)
  limit 5001
 ) select count(*),jsonb_agg(to_jsonb(e)) into row_count,result from evidence e;
 if row_count>5000 then raise exception 'catalog_history_truncated';end if;
 return coalesce(result,'[]'::jsonb);
end $$;
revoke all on function public.supervisor_prior_recipe_evidence(uuid,date) from public,anon,authenticated;
grant execute on function public.supervisor_prior_recipe_evidence(uuid,date) to service_role;
