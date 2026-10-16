\set ON_ERROR_STOP on
-- Real database tests: execute only against disposable Supabase after migrations.
-- Everything runs inside one transaction and is rolled back; no production data is touched.
BEGIN;
SELECT gen_random_uuid() AS owner_a, gen_random_uuid() AS owner_b,
       gen_random_uuid() AS biz_a, gen_random_uuid() AS biz_b,
       gen_random_uuid() AS employee_a, gen_random_uuid() AS employee_b
\gset
INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) VALUES
 (:'owner_a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','csv-import-owner-a@example.invalid','',now(),now()),
 (:'owner_b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','csv-import-owner-b@example.invalid','',now(),now());
INSERT INTO businesses(id,name,is_demo) VALUES (:'biz_a','CSV Import Test A',false),(:'biz_b','CSV Import Test B',false);
INSERT INTO memberships(business_id,user_id,role) VALUES (:'biz_a',:'owner_a','owner'),(:'biz_b',:'owner_b','owner');
INSERT INTO employees(id,business_id,display_name,active) VALUES (:'employee_a',:'biz_a','Alex A',true),(:'employee_b',:'biz_b','Alex B',true);
SELECT set_config('test.biz_a',:'biz_a',true),set_config('test.biz_b',:'biz_b',true),
       set_config('test.employee_a',:'employee_a',true),set_config('test.employee_b',:'employee_b',true),
       set_config('test.owner_a',:'owner_a',true);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);

-- RLS is enabled with real policies, not just a bare CREATE TABLE.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['csv_import_jobs','csv_sales_import_groups','csv_labor_import_rows'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I',t)::regclass) THEN
   RAISE EXCEPTION 'RLS_NOT_ENABLED: %', t;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t) THEN
   RAISE EXCEPTION 'NO_RLS_POLICY: %', t;
  END IF;
 END LOOP;
END $$;

-- Owner A stages and finalizes a sales import; aggregation semantics are exercised by the app
-- layer (lib/pos/csv/aggregateSalesRows.test.ts) — this checks the atomic SQL promotion itself.
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count,date_from,date_to)
VALUES (gen_random_uuid(),:'biz_a','sales','processing','fp-rls-test-1',3,2,'2026-08-22','2026-08-22')
RETURNING id \gset job_
SELECT set_config('test.job_id',:'job_id',true);
INSERT INTO csv_sales_import_groups(job_id,business_id,business_date,item_name,quantity,net_sales_cents,source_row_count)
VALUES
 (:'job_id',:'biz_a','2026-08-22','Latte',3,1500,2),
 (:'job_id',:'biz_a','2026-08-22','Tea',1,400,1);
SELECT * FROM csv_finalize_sales_job(:'job_id'::uuid);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM orders WHERE business_id=current_setting('test.biz_a')::uuid
   AND pos_order_id='csv-2026-08-22-Latte' AND net_sales_cents=1500) THEN
  RAISE EXCEPTION 'SALES_GROUP_NOT_PROMOTED_WITH_SUMMED_TOTAL';
 END IF;
 IF (SELECT count(*) FROM csv_sales_import_groups WHERE job_id=(SELECT id FROM csv_import_jobs
     WHERE business_id=current_setting('test.biz_a')::uuid AND content_fingerprint='fp-rls-test-1')
     AND promoted) <> 2 THEN
  RAISE EXCEPTION 'NOT_ALL_GROUPS_MARKED_PROMOTED';
 END IF;
END $$;
-- The RPC only promotes groups; the app layer (lib/actions/csvImport.ts's finalizeSalesImportJob)
-- is what marks the job itself done — mirror that here so later sections see an accurate state.
UPDATE csv_import_jobs SET status='done' WHERE id=:'job_id';

-- A toast:-sourced order already covering the date must block a conflicting CSV group from being
-- promoted — the symmetric check to Toast's own guard against non-toast orders (migration 46).
INSERT INTO orders(business_id,pos_order_id,closed_at,business_date,gross_sales_cents,net_sales_cents)
VALUES (:'biz_a','toast:11111111-1111-1111-1111-111111111111:order-1','2026-08-23T12:00:00Z','2026-08-23',500,500);
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count,date_from,date_to)
VALUES (gen_random_uuid(),:'biz_a','sales','processing','fp-rls-test-2',1,1,'2026-08-23','2026-08-23')
RETURNING id \gset conflict_job_
SELECT set_config('test.conflict_job_id',:'conflict_job_id',true);
INSERT INTO csv_sales_import_groups(job_id,business_id,business_date,item_name,quantity,net_sales_cents,source_row_count)
VALUES (:'conflict_job_id',:'biz_a','2026-08-23','Mocha',1,500,1);
SELECT * FROM csv_finalize_sales_job(:'conflict_job_id'::uuid);
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM orders WHERE business_id=current_setting('test.biz_a')::uuid
   AND pos_order_id='csv-2026-08-23-Mocha') THEN
  RAISE EXCEPTION 'CSV_DOUBLE_COUNTED_A_TOAST_COVERED_DATE';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM csv_sales_import_groups WHERE job_id=current_setting('test.conflict_job_id')::uuid
   AND conflict_reason='toast_covers_date') THEN
  RAISE EXCEPTION 'TOAST_CONFLICT_NOT_FLAGGED';
 END IF;
END $$;
UPDATE csv_import_jobs SET status='needs_review' WHERE id=:'conflict_job_id';

-- Labor: a row with a known wage promotes; a row with no wage evidence stays staged, never a
-- fabricated $0 in canonical timecards (which keeps its NOT NULL hourly_wage_cents unchanged).
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count,date_from,date_to)
VALUES (gen_random_uuid(),:'biz_a','labor','processing','fp-rls-test-3',2,2,'2026-08-22','2026-08-22')
RETURNING id \gset labor_job_
INSERT INTO csv_labor_import_rows(job_id,business_id,employee_id,pos_timecard_id,clock_in,clock_out,hourly_wage_cents) VALUES
 (:'labor_job_id',:'biz_a',:'employee_a','csv-rls-shift-known','2026-08-22T07:00:00Z','2026-08-22T15:00:00Z',2000),
 (:'labor_job_id',:'biz_a',:'employee_a','csv-rls-shift-unknown','2026-08-22T15:00:00Z','2026-08-22T23:00:00Z',NULL);
SELECT * FROM csv_finalize_labor_job(:'labor_job_id'::uuid);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM timecards WHERE business_id=current_setting('test.biz_a')::uuid
   AND pos_timecard_id='csv-rls-shift-known' AND hourly_wage_cents=2000) THEN
  RAISE EXCEPTION 'KNOWN_WAGE_SHIFT_NOT_PROMOTED';
 END IF;
 IF EXISTS (SELECT 1 FROM timecards WHERE pos_timecard_id='csv-rls-shift-unknown') THEN
  RAISE EXCEPTION 'UNKNOWN_WAGE_SHIFT_PROMOTED_WITH_FABRICATED_RATE';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM csv_labor_import_rows WHERE pos_timecard_id='csv-rls-shift-unknown'
   AND promoted=false AND hourly_wage_cents IS NULL) THEN
  RAISE EXCEPTION 'UNKNOWN_WAGE_ROW_NOT_LEFT_STAGED';
 END IF;
END $$;
-- Owner later supplies the wage and re-finalizes; the row promotes without touching the first shift.
UPDATE csv_labor_import_rows SET hourly_wage_cents=1800
 WHERE job_id=:'labor_job_id' AND pos_timecard_id='csv-rls-shift-unknown';
SELECT * FROM csv_finalize_labor_job(:'labor_job_id'::uuid);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM timecards WHERE pos_timecard_id='csv-rls-shift-unknown' AND hourly_wage_cents=1800) THEN
  RAISE EXCEPTION 'RESOLVED_WAGE_SHIFT_NOT_PROMOTED_ON_RETRY';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM timecards WHERE pos_timecard_id='csv-rls-shift-known' AND hourly_wage_cents=2000) THEN
  RAISE EXCEPTION 'RETRY_FINALIZE_TOUCHED_ALREADY_PROMOTED_SHIFT';
 END IF;
END $$;
UPDATE csv_import_jobs SET status='done' WHERE id=:'labor_job_id';

-- Database-level concurrency guard: a second 'processing' job for the same business+kind is
-- rejected by the unique partial index, not merely discouraged by a disabled button. job_id and
-- conflict_job_id are already 'done'/'needs_review' by this point, so this section creates its
-- own currently-active job to collide against.
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES (gen_random_uuid(),:'biz_a','sales','processing','fp-rls-test-active-1',1,1)
RETURNING id \gset active_
DO $$
BEGIN
 BEGIN
  INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
  VALUES (current_setting('test.biz_a')::uuid,'sales','processing','fp-rls-test-active-2',1,1);
  RAISE EXCEPTION 'SECOND_ACTIVE_JOB_ACCEPTED';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
END $$;
-- A terminal (non-processing) job for the same kind does not block a new attempt. Immediately
-- marked done again so it doesn't itself become the lingering "active" job that later sections
-- (the category-distinct-order test, the composite-FK test) would otherwise collide with.
UPDATE csv_import_jobs SET status='done' WHERE id=:'active_id';
INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES (:'biz_a','sales','processing','fp-rls-test-after-done',1,1);
UPDATE csv_import_jobs SET status='done' WHERE business_id=:'biz_a' AND content_fingerprint='fp-rls-test-after-done';

-- Exact-duplicate content (same fingerprint) is rejected once a job exists for it, except when
-- that prior attempt failed — a genuine failure must always be retryable with the same file.
INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES (:'biz_a','labor','failed','fp-rls-test-dup',1,1);
INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES (:'biz_a','labor','processing','fp-rls-test-dup',1,1);
DO $$
BEGIN
 BEGIN
  INSERT INTO csv_import_jobs(business_id,kind,status,content_fingerprint,rows_in_file,group_count)
  VALUES (current_setting('test.biz_a')::uuid,'labor','done','fp-rls-test-dup',1,1);
  RAISE EXCEPTION 'DUPLICATE_NON_FAILED_FINGERPRINT_ACCEPTED';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
END $$;

-- Owner B cannot read or write owner A's staged jobs/groups/rows even with known IDs.
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM csv_import_jobs WHERE business_id=current_setting('test.biz_a')::uuid) THEN
  RAISE EXCEPTION 'FOREIGN_OWNER_READ_JOBS_ACCEPTED';
 END IF;
 IF EXISTS (SELECT 1 FROM csv_sales_import_groups WHERE business_id=current_setting('test.biz_a')::uuid) THEN
  RAISE EXCEPTION 'FOREIGN_OWNER_READ_GROUPS_ACCEPTED';
 END IF;
 -- RLS applies inside this security-invoker function too: as a non-member, its internal
 -- UPDATE/INSERT statements affect zero rows for business A's job — a safe no-op, not a leak.
 PERFORM public.csv_finalize_sales_job(current_setting('test.job_id')::uuid);
END $$;
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
-- Checked back as owner A (who can actually see biz_a's rows) — the foreign call above must not
-- have changed the order that owner A's own earlier finalize already correctly wrote.
DO $$
BEGIN
 IF (SELECT count(*) FROM orders WHERE business_id=current_setting('test.biz_a')::uuid
     AND pos_order_id='csv-2026-08-22-Latte' AND net_sales_cents=1500) <> 1 THEN
  RAISE EXCEPTION 'FOREIGN_OWNER_FINALIZE_CHANGED_ANOTHER_BUSINESS_DATA';
 END IF;
END $$;

-- Composite FKs: a staged row cannot claim business A's business_id while pointing at business
-- B's job/employee. A member of two cafés (or a bug in the app layer) must not be able to make the
-- security-invoker finalizer write a canonical record that cross-references another tenant.
SELECT set_config('request.jwt.claim.sub',:'owner_b',true);
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count)
VALUES (gen_random_uuid(),:'biz_b','labor','processing','fp-rls-test-biz-b',1,1)
RETURNING id \gset biz_b_job_
SELECT set_config('test.biz_b_job_id',:'biz_b_job_id',true);
SELECT set_config('request.jwt.claim.sub',:'owner_a',true);
DO $$
BEGIN
 BEGIN
  INSERT INTO csv_sales_import_groups(job_id,business_id,business_date,item_name,quantity,net_sales_cents,source_row_count)
  VALUES (current_setting('test.biz_b_job_id')::uuid,current_setting('test.biz_a')::uuid,'2026-08-24','Cross-tenant',1,100,1);
  RAISE EXCEPTION 'CROSS_TENANT_JOB_REFERENCE_ACCEPTED';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO csv_labor_import_rows(job_id,business_id,employee_id,pos_timecard_id,clock_in,hourly_wage_cents)
  VALUES (current_setting('test.job_id')::uuid,current_setting('test.biz_a')::uuid,current_setting('test.employee_b')::uuid,'csv-cross-tenant','2026-08-24T09:00:00Z',1500);
  RAISE EXCEPTION 'CROSS_TENANT_EMPLOYEE_REFERENCE_ACCEPTED';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;

-- Two groups sharing a date+item but differing only by category must land as two distinct
-- canonical orders (summing separately), not one upsert silently overwriting the other's lines.
INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count,date_from,date_to)
VALUES (gen_random_uuid(),:'biz_a','sales','processing','fp-rls-test-category',2,2,'2026-08-25','2026-08-25')
RETURNING id \gset category_job_
INSERT INTO csv_sales_import_groups(job_id,business_id,business_date,item_name,category,quantity,net_sales_cents,source_row_count)
VALUES
 (:'category_job_id',:'biz_a','2026-08-25','Chai','Hot Drinks',1,400,1),
 (:'category_job_id',:'biz_a','2026-08-25','Chai','Iced Drinks',1,450,1);
SELECT * FROM csv_finalize_sales_job(:'category_job_id'::uuid);
DO $$
BEGIN
 IF (SELECT count(*) FROM orders WHERE business_id=current_setting('test.biz_a')::uuid
     AND business_date='2026-08-25' AND pos_order_id LIKE 'csv-2026-08-25-Chai%') <> 2 THEN
  RAISE EXCEPTION 'CATEGORY_DISTINCT_GROUPS_COLLAPSED_INTO_ONE_ORDER';
 END IF;
 IF (SELECT sum(net_sales_cents) FROM orders WHERE business_id=current_setting('test.biz_a')::uuid
     AND business_date='2026-08-25' AND pos_order_id LIKE 'csv-2026-08-25-Chai%') <> 850 THEN
  RAISE EXCEPTION 'CATEGORY_DISTINCT_GROUPS_LOST_A_TOTAL';
 END IF;
END $$;

-- A completed import's status, history row and link are atomic and idempotent.
-- A malformed cross-kind request must not touch either table.
DO $$
DECLARE j uuid := gen_random_uuid(); h uuid; first_upload uuid;
BEGIN
  INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count)
    VALUES (j,current_setting('test.biz_a')::uuid,'sales','processing','fp-atomic-history',1,1);
  BEGIN
    PERFORM csv_complete_import_with_history(j,'labor_csv','done','{}'::jsonb);
    RAISE EXCEPTION 'CROSS_KIND_HISTORY_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF (SELECT status FROM csv_import_jobs WHERE id=j) <> 'processing' THEN
      RAISE EXCEPTION 'INVALID_HISTORY_CHANGED_JOB';
    END IF;
  END;
  PERFORM csv_complete_import_with_history(j,'sales_csv','needs_review','{"rejectedRows":[{"reason":"test","count":1}]}'::jsonb);
  SELECT upload_id INTO first_upload FROM csv_import_jobs WHERE id=j;
  IF first_upload IS NULL OR (SELECT status FROM csv_import_jobs WHERE id=j) <> 'needs_review'
     OR (SELECT status FROM uploads WHERE id=first_upload) <> 'needs_review' THEN
    RAISE EXCEPTION 'HISTORY_NOT_ATOMICALLY_CREATED';
  END IF;
  PERFORM csv_complete_import_with_history(j,'sales_csv','done','{"imported":1}'::jsonb);
  IF (SELECT upload_id FROM csv_import_jobs WHERE id=j) <> first_upload
     OR (SELECT status FROM csv_import_jobs WHERE id=j) <> 'done'
     OR (SELECT status FROM uploads WHERE id=first_upload) <> 'done'
     OR (SELECT count(*) FROM uploads WHERE id=first_upload) <> 1 THEN
    RAISE EXCEPTION 'HISTORY_REFINALIZE_NOT_IDEMPOTENT';
  END IF;
END $$;

-- Prevent a second overlapping import stealing an old pending wage-review row. The first
-- job's review row ID remains valid until its wage is supplied.
DO $$
DECLARE first_job uuid := gen_random_uuid(); second_job uuid := gen_random_uuid(); pending_id uuid;
BEGIN
  INSERT INTO csv_import_jobs(id,business_id,kind,status,content_fingerprint,rows_in_file,group_count)
  VALUES (first_job,current_setting('test.biz_a')::uuid,'labor','needs_wage_review','fp-pending-job-a',1,1),
         (second_job,current_setting('test.biz_a')::uuid,'labor','needs_wage_review','fp-pending-job-b',1,1);
  INSERT INTO csv_labor_import_rows(job_id,business_id,employee_id,pos_timecard_id,clock_in,hourly_wage_cents)
  VALUES (first_job,current_setting('test.biz_a')::uuid,current_setting('test.employee_a')::uuid,
          'csv-pending-collision','2026-08-26T10:00:00Z',null)
  RETURNING id INTO pending_id;
  BEGIN
    INSERT INTO csv_labor_import_rows(job_id,business_id,employee_id,pos_timecard_id,clock_in,hourly_wage_cents)
    VALUES (second_job,current_setting('test.biz_a')::uuid,current_setting('test.employee_a')::uuid,
            'csv-pending-collision','2026-08-26T10:00:00Z',1900)
    ON CONFLICT (business_id,pos_timecard_id) DO UPDATE SET
      job_id=excluded.job_id, hourly_wage_cents=excluded.hourly_wage_cents, promoted=false;
    RAISE EXCEPTION 'PENDING_REVIEW_ROW_STOLEN';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT job_id FROM csv_labor_import_rows WHERE id=pending_id) <> first_job
     OR (SELECT hourly_wage_cents FROM csv_labor_import_rows WHERE id=pending_id) IS NOT NULL THEN
    RAISE EXCEPTION 'PENDING_REVIEW_ROW_MISSING';
  END IF;
  UPDATE csv_labor_import_rows SET hourly_wage_cents=1800 WHERE id=pending_id AND job_id=first_job;
  PERFORM csv_finalize_labor_job(first_job);
  IF NOT EXISTS (SELECT 1 FROM timecards WHERE pos_timecard_id='csv-pending-collision' AND hourly_wage_cents=1800) THEN
    RAISE EXCEPTION 'ORIGINAL_PENDING_WAGE_NOT_PROMOTED';
  END IF;
END $$;

-- Even a user who belongs to BOTH cafés must not link a history record from B to a job in A.
INSERT INTO memberships(business_id,user_id,role)
VALUES (:'biz_b',:'owner_a','owner');
DO $$
DECLARE other_upload uuid;
BEGIN
  INSERT INTO uploads(business_id,kind,status,summary)
  VALUES (current_setting('test.biz_b')::uuid,'sales_csv','done','{}'::jsonb)
  RETURNING id INTO other_upload;
  BEGIN
    UPDATE csv_import_jobs SET upload_id=other_upload
    WHERE business_id=current_setting('test.biz_a')::uuid AND content_fingerprint='fp-atomic-history';
    RAISE EXCEPTION 'CROSS_BUSINESS_HISTORY_LINK_ACCEPTED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

RESET ROLE;
ROLLBACK;
\echo CSV import reliability RLS/atomicity/concurrency tests passed (rolled back)
