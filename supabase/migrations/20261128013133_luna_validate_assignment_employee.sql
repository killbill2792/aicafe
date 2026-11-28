set lock_timeout = '3s';
set statement_timeout = '30s';

alter table public.supervisor_runs validate constraint supervisor_runs_employee_key_check;
