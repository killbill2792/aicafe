-- Fixes a real bug found running against the first live database: the Menu screen's
-- getMenuItemSnapshots() summed order_lines.quantity per item by fetching every matching row
-- client-side. PostgREST caps a plain select at 1000 rows with no error or truncation signal, so
-- a busy café's 28 days of order_lines (12k+ rows against the pilot café's seed data) silently
-- undercounted quantity sold, which inflated the staff-time-per-drink math by an order of
-- magnitude. Paginating with .range() instead fixed the correctness but was too slow against a
-- joined query at this volume (timed out after ~50s across 13 round trips) — the right fix is one
-- indexed SUM/GROUP BY done server-side. Not SECURITY DEFINER: it runs as the calling user, so
-- RLS on order_lines/orders still applies exactly as it would for a direct query.
create or replace function menu_item_quantities_sold(p_business_id uuid, p_from date, p_to date)
returns table (menu_item_id uuid, total_quantity numeric)
language sql
stable
as $$
  select ol.menu_item_id, sum(ol.quantity) as total_quantity
  from order_lines ol
  join orders o on o.id = ol.order_id
  where o.business_id = p_business_id
    and o.business_date between p_from and p_to
    and ol.voided = false
    and ol.menu_item_id is not null
  group by ol.menu_item_id;
$$;
