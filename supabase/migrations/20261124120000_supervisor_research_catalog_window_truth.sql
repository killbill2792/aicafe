-- Reflect the already migrated wide-window and durable-owner read semantics.
-- This changes discovery metadata only, not #564's operational Toast reader.
set lock_timeout='3s';
set statement_timeout='45s';
GRANT aicafe_research_view_owner TO postgres WITH SET TRUE;
COMMENT ON VIEW u3_research.toast_records IS
 'Retained operational Toast records through the canonical scrubbed reader, not diagnostic samples. Distinct order, check, item, modifier, discount, payment and current-provider objects retain source grain. Verified owner and leased durable-owner research can read reviewed fields; unattended modes mask private fields. Supply an explicit valid business-date pair, with no artificial interval-length ceiling. Source coverage, status, counts_in_sales and identity determine eligibility; never infer complete history or multiply revenue across a join.';
COMMENT ON VIEW u3_research.toast_changes IS
 'Operational Toast change log, one reviewed scalar change per field and event, within an explicit valid business-date pair and verified café scope. No artificial interval-length ceiling. Observed before/after values are not complete all-time history. Verified owner and leased durable-owner research can read reviewed scalar values; unattended modes receive masked values. Credentials, arbitrary nested objects and free-text notes are not exposed.';
COMMENT ON VIEW u3_research.employee_sales_rollup IS
 'One recorded employee-attributed business-day sales rollup. Join employees by employee_id in verified owner/durable research. The recorded attribution is not total café sales, productivity or profit. For Toast-connected historical windows compare dates and relevant location/register coverage against toast_day_status and daily_rollups; report missing/partial/flagged days rather than interpreting absent employee rows as zero.';

REVOKE aicafe_research_view_owner FROM postgres;
