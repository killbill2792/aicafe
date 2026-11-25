-- Extend the existing durable event queue, not a second queue.
alter table public.toast_webhook_subscriptions add column event_kind text not null default 'orders'
 check(event_kind in ('orders','menus','stock','availability','ordering'));
alter table public.toast_order_events add column event_kind text not null default 'orders'
 check(event_kind in ('orders','menus','stock','availability','ordering'));
alter table public.toast_order_events add column event_version text;
alter table public.toast_order_events add column item_guid uuid;
create or replace function public.toast_claim_provider_events(p_limit integer)
returns table(business_id uuid,event_guid uuid,restaurant_guid uuid,order_guid uuid,attempts integer,lease_nonce uuid,event_kind text,event_version text,item_guid uuid,event_time timestamptz)
language sql security definer set search_path=public as $$
 with chosen as (
 select e.business_id,e.event_guid from public.toast_order_events e
 where (e.order_guid is not null or e.event_kind<>'orders')
 and e.next_attempt_at<=now() and e.state in ('pending','processing','failed')
 order by (e.event_kind='orders') desc,e.received_at asc for update skip locked
 limit least(greatest(p_limit,1),3)
 ) update public.toast_order_events e set state='processing',attempts=e.attempts+1,
 lease_nonce=gen_random_uuid(),next_attempt_at=now()+interval '3 minutes'
 from chosen c where e.business_id=c.business_id and e.event_guid=c.event_guid
 returning e.business_id,e.event_guid,e.restaurant_guid,e.order_guid,e.attempts,e.lease_nonce,e.event_kind,e.event_version,e.item_guid,e.event_time
$$;
revoke all on function public.toast_claim_provider_events(integer) from public,anon,authenticated;
grant execute on function public.toast_claim_provider_events(integer) to service_role;
