-- Existing POS rollup policies were implicitly TO PUBLIC, while their
-- owner-check function is authenticated-only. PostgreSQL can evaluate
-- that policy even alongside the signed U3 policy, causing 42501.
-- Keep the original owner predicate and write checks, without granting
-- research roles the application identity function or any write access.
set lock_timeout='3s';
set statement_timeout='45s';
ALTER POLICY "owners read" ON public.hourly_sales_rollup TO authenticated;
ALTER POLICY "owners write" ON public.hourly_sales_rollup TO authenticated;
ALTER POLICY "owners read" ON public.employee_sales_rollup TO authenticated;
ALTER POLICY "owners write" ON public.employee_sales_rollup TO authenticated;
ALTER POLICY "owners read" ON public.employee_pay_period_facts TO authenticated;
ALTER POLICY "owners write" ON public.employee_pay_period_facts TO authenticated;
