## 9. Tests (rules that stop regressions)
- **Do not edit or delete an existing test unless the task explicitly names that behavior change.**
  The PR must list every test changed or deleted, each with a one-line reason. Any other test change
  is treated as a regression.
- If your change makes an existing test fail, assume your change is wrong first. Fix the code, or stop
  and ask. Never loosen the assertion.
- Test behavior, not source text. Tests that grep source files are allowed only to ban retired imports.
- No vacuous assertions (`>= 0`, `toBeDefined()` alone, `length >= 0`).
- Retries in tests use a new call ID for each new call, never a reused one.
- Unit tests for every tool handler and `checkNumbers`; recorded-fixture tests for the loop.
- **Golden owner questions:** a fixed set of real owner questions on fixture data with exact expected
  numbers, checked on both the chat and screen paths. A PR that changes any golden answer must say why.

### Source-to-Supervisor acceptance and negative diagnostic tests (mandatory for POS and data-reader PRs)
- Every new/changed Toast source family must prove a real source-shaped permitted payload is retained in the one keyed current object, updated only on actual changes, independently discoverable in `describe_data`, queryable via `query_data` and answerable in a registered one-agent Supervisor turn, with applicable screen parity. Tests must exercise actual migrated disposable Postgres, not only mocks.
- **Negative authority test:** insert synthetic values into `toast_raw_samples` only, verify the live operational `cv_*` readers, `query_data` and Supervisor do **not** return them; then insert distinct values through the real current-object path and verify only those are shown. Staleness, a 403/204 or missing field must never trigger a diagnostic fallback or fabricated zero.
- Field-universe tests must include optional fields absent from 30 recent objects, fields seen >35 days ago, >200 paths, nested arrays and nullable data. Query response caps of 100 rows / ~6 KB must not limit DB-side calculations; test filtered grouping/continuation if required.
- The old `scripts/toast-db-integration.sql` and `scripts/ai-toast-records-sql-integration.sql` intentionally assert legacy diagnostic-fed operational views; their **named assertions must be updated** at the POS0e cutover. Preserve diagnostic-specific tests separately. Never keep these assertions green by leaving a forbidden source attached; never delete unrelated regression coverage.
- A passing source-code guard alone does not prove the final database lineage. POS0e/POS0f must inspect the **final definitions after all migrations** (including dependencies of `toast_records_for`, `cv_cash`, `cv_inventory`, `cv_kitchen`, `cv_dining_options`) and reject any active dependency on `toast_raw_samples` or `toast_raw_samples_latest`.
- Every PR records test name, expected value, observed value, actual executed CI job URL and final head SHA. A skipped job, mock-only test, earlier green run or test-café mirror result is NOT proof of a real-café outcome.
