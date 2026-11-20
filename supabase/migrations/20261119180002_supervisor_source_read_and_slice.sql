set lock_timeout = '1s';
set statement_timeout = '5s';
-- Trusted cron reads the same canonical coverage as an authenticated member.
CREATE OR REPLACE FUNCTION public.toast_unverified_sales_dates(
 p_business_id uuid,p_from date,p_to date)
RETURNS TABLE(business_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF p_business_id IS NULL OR (coalesce(auth.role(),'') <> 'service_role' AND (auth.uid() IS NULL OR NOT is_member(p_business_id)))
 OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to>p_from+interval '370 days'
 THEN RAISE EXCEPTION 'not authorized for Toast reporting coverage'; END IF;
 RETURN QUERY
 SELECT DISTINCT d.date FROM (
  SELECT o.business_date AS date FROM orders o
   WHERE o.business_id=p_business_id AND o.pos_order_id LIKE 'toast:%'
     AND o.business_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT e.event_business_date FROM toast_payment_day_events e
   WHERE e.business_id=p_business_id AND e.event_business_date BETWEEN p_from AND p_to
  UNION ALL
  SELECT p.business_date FROM toast_pilot_days p
   WHERE p.business_id=p_business_id AND p.business_date BETWEEN p_from AND p_to
    AND p.promoted_at IS NOT NULL
 ) d ORDER BY d.date;
END $$;
REVOKE ALL ON FUNCTION public.toast_unverified_sales_dates(uuid,date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.toast_unverified_sales_dates(uuid,date,date) TO authenticated,service_role;
