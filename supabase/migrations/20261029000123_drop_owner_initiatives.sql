-- The owner-initiatives system was replaced by goals in the Supervisor loop.
-- Its tables never held café data. Refuse to run if that ever changed, so no
-- owner record is dropped by surprise.
-- Kept: initiative_daily_order_sales_proof (the certified daily sales reader
-- that goals and the metric catalog use).
do $$
begin
  if exists(select 1 from owner_initiatives) or exists(select 1 from initiative_metrics)
     or exists(select 1 from initiative_observations) or exists(select 1 from initiative_evaluations)
     or exists(select 1 from initiative_checkin_operations) then
    raise exception 'owner_initiatives tables are not empty; export and review them before dropping'
      using errcode='P0001';
  end if;
end $$;

drop function if exists insert_monitor_team_update_fenced(uuid,uuid,bigint,jsonb);
drop function if exists write_owner_initiative_monitor_evaluation;
drop function if exists write_owner_initiative_monitor_observation;
drop function if exists release_owner_initiative_monitor;
drop function if exists claim_owner_initiative_monitor;
drop function if exists record_owner_initiative_checkin_atomic;
drop function if exists create_owner_initiative_atomic;

drop table if exists initiative_checkin_operations;
drop table if exists initiative_evaluations;
drop table if exists initiative_observations;
drop table if exists initiative_metrics;
drop table if exists owner_initiatives;
