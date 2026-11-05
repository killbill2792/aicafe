-- The owner can forget a saved fact from the chat (a change card's "Forget this").
-- Nothing is deleted: the current row is closed (superseded_at) like any change,
-- and forgotten_by records who did it, so history stays complete.
-- Facts that were also copied to a screen (monthly bills, payroll extras, card
-- fees) are refused: forgetting only the chat copy would make chat and screens
-- disagree. Those are changed, not forgotten.

alter table public.owner_facts
  add column if not exists forgotten_by uuid references auth.users(id);

create or replace function public.forget_owner_fact(
 p_business_id uuid, p_fact_key text
) returns boolean language plpgsql security definer set search_path = public as $$
declare
 v_uid uuid := auth.uid();
 v_count integer;
begin
 if v_uid is null or not exists (
   select 1 from public.memberships m where m.business_id=p_business_id
    and m.user_id=v_uid and m.role in ('owner','manager')
 ) then raise exception 'owner_fact_forbidden' using errcode='42501'; end if;
 if p_fact_key is null or p_fact_key !~ '^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$'
 then raise exception 'invalid_owner_fact'; end if;
 if p_fact_key in ('monthly_bills_cents','payroll_extras_monthly_cents') or p_fact_key like 'card\_%'
 then raise exception 'owner_fact_on_screen'; end if;
 update public.owner_facts set superseded_at=now(),updated_at=now(),forgotten_by=v_uid
  where business_id=p_business_id and fact_key=p_fact_key and superseded_at is null;
 get diagnostics v_count = row_count;
 return v_count>0;
end $$;
revoke all on function public.forget_owner_fact(uuid,text) from public,anon;
grant execute on function public.forget_owner_fact(uuid,text) to authenticated;

-- One change card is applied whole or not at all: its forgets and its new values
-- commit together, so a refused value (for example a card fee above 50%) never
-- leaves a fact forgotten while the owner sees "couldn't save".
create or replace function public.change_owner_facts(
 p_business_id uuid, p_answers jsonb, p_forget text[]
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
 v_key text;
 v_forgotten integer := 0;
 v_saved jsonb := '[]'::jsonb;
begin
 if p_forget is null or cardinality(p_forget) not between 1 and 6
    or cardinality(p_forget)<>(select count(distinct k) from unnest(p_forget) k)
    or p_answers is null or jsonb_typeof(p_answers)<>'array'
    or exists(select 1 from jsonb_array_elements(p_answers) a where a->>'factKey' = any(p_forget))
 then raise exception 'invalid_owner_answers'; end if;
 foreach v_key in array p_forget loop
   if public.forget_owner_fact(p_business_id,v_key) then v_forgotten := v_forgotten+1; end if;
 end loop;
 if jsonb_array_length(p_answers)>0 then
   v_saved := public.save_owner_fact_answers(p_business_id,p_answers);
 end if;
 return jsonb_build_object('saved',v_saved,'forgotten',v_forgotten);
end $$;
revoke all on function public.change_owner_facts(uuid,jsonb,text[]) from public,anon;
grant execute on function public.change_owner_facts(uuid,jsonb,text[]) to authenticated;
