-- A priority notice is an owner-inbox/notification item, never a chat message. The chat copy carried only a
-- generic reason ("Actionable café alert needs review") with no detail, so it only added noise. The inbox item
-- now says what the alert is about. Real investigation reports (which carry findings and questions) are unchanged.
set lock_timeout='3s';
set statement_timeout='60s';

create or replace function public.supervisor_alert_notice_title(p_kind text,p_payload jsonb)
returns text language sql immutable set search_path='' as $title$
 select case
  when p_kind='meal_break' then 'A shift ran without a recorded meal break'
  when p_kind<>'business_anomaly' then 'A café alert needs your attention'
  else case p_payload->>'family'
   when 'sales_decline' then 'Sales are down compared with the previous period'
   when 'sales_growth' then 'Sales are up compared with the previous period'
   when 'live_sales_decline' then 'Sales today are running below normal'
   when 'live_sales_growth' then 'Sales today are running above normal'
   when 'labor_cost' then 'Labor cost changed noticeably'
   when 'recorded_expense_rise' then 'Recorded expenses rose'
   when 'recorded_refund_rise' then 'Recorded refunds rose'
   when 'order_refund_rise' then 'Refunded orders rose'
   when 'operating_margin' then 'Operating margin changed'
   when 'cost_recovery_lag' then 'You are behind on covering your fixed costs'
   when 'cost_recovery_ahead' then 'You are ahead on covering your fixed costs'
   when 'overstaffed_hour' then 'More staff than sales needed at a regular hour'
   when 'customer_trend' then 'A customer pattern changed'
   when 'high_contribution' then 'One item brings in a large share of your margin'
   when 'product_contribution' then 'An item''s margin changed'
   when 'stockout_risk' then 'An ingredient may run out'
   when 'stock_shortage' then 'An ingredient is low or out'
   when 'missed_clock_evidence' then 'Clock-in records look incomplete'
   when 'data_gap' then case p_payload->>'subject'
     when 'stock_counts' then 'Stock counts are missing'
     when 'expense_coverage' then 'Expenses are missing for part of the period'
     when 'ingredient_prices' then 'Ingredient prices are missing'
     when 'actual_wage_coverage' then 'Actual wages are missing for part of the period'
     else 'Some information is missing' end
   else 'A café alert needs your attention' end
 end
$title$;
revoke all on function public.supervisor_alert_notice_title(text,jsonb) from public,anon,authenticated;
grant execute on function public.supervisor_alert_notice_title(text,jsonb) to service_role;

do $patch$
declare d text; n text; a int; b int;
begin
 select pg_get_functiondef('public.post_supervisor_priority_notice(uuid,uuid,uuid,text,text,text,text,text,timestamptz,uuid,uuid,uuid)'::regprocedure) into d;
 a:=position('  v_hash:=md5(''priority-notice:''' in d);
 b:=position('  return v_inserted_task_id is not null;' in d);
 if a=0 or b=0 or b<a then raise exception 'notice chat block not found'; end if;
 n:=substr(d,1,a-1)||substr(d,b);
 d:=n;
 n:=replace(d,'jsonb_build_object(''title'',p_reason,''threadId'',p_thread_id::text,',
  'jsonb_build_object(''title'',case when p_source_type=''alert'' then coalesce((select public.supervisor_alert_notice_title(al.kind,al.payload) from public.alerts al where al.business_id=p_business_id and al.id::text=p_source_id),p_reason) else p_reason end,''threadId'',p_thread_id::text,');
 if n=d then raise exception 'notice title anchor not found'; end if;
 execute n;
end $patch$;

-- The existing contentless chat copies are removed (system-written, no information, no owner content).
delete from public.ai_messages
where role='supervisor' and grounding->>'intent'='priority_notice'
  and structured_content->0->>'text' in ('Overdue item needs review','Actionable café alert needs review',
   'Owner task needs review','Task response needs review');
