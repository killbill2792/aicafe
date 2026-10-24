# Toast operations (PR 1 groundwork)

In Toast Web: **Integrations → Toast API access → Manage credentials**. Standard API requires \`orders:read\` and \`restaurants:read\`. Menus and labor are optional; Analytics is a separate RMS Pro credential. Keep \`TOAST_AUTO_IMPORT_ENABLED\` and every legacy polling/promotion flag OFF while PR 1 is unverified.

Apply migration \`20261024000093_toast_day_import.sql\` only after migration-history checks and SQL integration testing. No production migration is performed by this PR. If a controlled day import is authorized, create a \`toast_sync_runs\` row for its verified business/location, then invoke \`importToastBusinessDay\` with the same run ID. Monitor \`toast_day_status\`, \`toast_unparsed_orders\`, and \`toast_order_revisions\`.

**Do not enable autonomous imports yet.** PR 2 adds cron, complete re-pull, reconciliation, and the void-coverage certification criteria; PR 3 adds owner-facing health and the first-import nonblocking check. A rate-limited page checkpoints the cursor and resumes at the identical page. Imported facts are retained on rollback; switching flags OFF stops new imports but does not erase facts.

No API tokens, full payloads, or secrets should appear in logs. Unparsed records hold a redacted payload checksum and schema error paths only.
