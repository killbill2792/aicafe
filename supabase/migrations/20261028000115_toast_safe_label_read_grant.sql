-- Additive privilege fix for 114's invoker-RLS dining option view.
-- Migration 113 intentionally revokes public execution of its safe label helper.
-- Authenticated café owners need EXECUTE to evaluate that helper in cv_dining_options.
-- The function is immutable, read-only, and returns only a redacted merchant label.
grant execute on function public.toast_safe_business_label(text) to authenticated,service_role;
