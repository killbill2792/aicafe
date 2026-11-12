# POS0e retained-credential query-boundary repair

Owner approval: the 2026-11-11 instruction to complete the Task 10 release preparation and fix the unresolved POS0e reusable-credential security risk. Original Codex P1 in merged #404: inline review `PRRT_kwDOU2R9WM61n-ec` / database comment `4522949784`.

## Existing source and precise security path
- **Producer:** Toast Standard GET under each café's existing authenticated mapping, through the existing `redactToastRaw` and `toast_raw_records` writer; one object per (business_id,restaurant_guid,true source object key). The already-open **bridge PR #444** owns the ingest-side snake/kebab credential redaction and its new migration `20261112000302`. This PR DOES NOT edit any #444 files or add another producer or ledger.
- **Retained legacy risk:** existing `toast_raw_records` might already contain unknown nested keys under `payload`. Even when ingest redaction is repaired, an existing stored object can still be accessed through `ai_toast_fields` (discovery) and the existing `ai_query_path`/ `ai_query_view` SQL path plus `isDataField` TypeScript validation.
- **Identity and readers:** keep café membership/RLS, bounded `data.<segment>` paths and existing SQL read/aggregation. Only reject names that normalize to reusable credentials/payment secret tokens. The canonical `field.replace(/_/g,'')` normalization handles Toast snake-case without rejecting legitimate `customer.email`, employee GUID, loyalty relationships, or ordinary business fields.
- **No data deletion:** do not scan/extract live credential values or rewrite historical source payloads. Block queryable/discoverable paths in TypeScript and SQL, and separately follow up the #444 ingestion patch. No second permissions model or temporary bypass.

## Exact editable paths
1. `lib/data/canonical/dictionary.ts` — extend existing `isDataField` reusable-secret guard
2. `lib/data/canonical/dictionary.security.test.ts` — new negative and positive retained-path tests
3. `supabase/migrations/20261112000303_pos0e_query_credential_guard.sql` — new additive `ai_query_path` signature-preserving SQL replacement (after original POS0e 00156; later than #444 00302)
4. `scripts/pos0e-current-reader-sql-integration.sql` — extend existing disposable SQL fixture so discovery/query cannot retrieve token fields
5. `docs/plans/pos0e-credential-query-boundary.md` — this exact review/acceptance record.

**Read-only dependencies:** `lib/pos/toast/redact.ts`, `redact.test.ts`, `lib/ai/agent/tools/dataQuery.ts`, `supabase/migrations/20261109000156_pos0e_shared_current_reader.sql`, `AGENTS.md`, `PROGRESS.md`, all existing POS0 adoption, source/writer, and Task 10 paths. PR #444 is independent in file ownership and must not be duplicated or merged by this PR.

## Facts verified without exposing source data
Read-only production query at audit time: `ai_query_path('data.customer.access_token')`, `ai_query_path('data.customer.refresh_token')` and `ai_query_path('data.payment_token')` returned non-null text arrays. This proves the security allowlist defect, **not that any credential was actually retained or exposed**.

## Acceptance / activation (no production writes here)
- Full PR baseline and real disposable migrated PostgreSQL SQL runner, including replay/tenant checks; mixed snake/camel, nested arrays, safe names/IDs remain allowed.
- Codex exact-head clean after CI; do not mark fixed until executed SQL proves negative and harmless positive cases.
- Production release later, under owner explicit SQL authorization: confirm the correct base `ai_query_path` signature, apply after POS0e migration 00156 (or to existing verified equivalent); verify security behavior and permissions without reading any credential contents. Do NOT run bulk `supabase db push`: production migration ledger is known to be incomplete.
- #444 redaction P1 remains cross-layer until this gate and its ingest-side test both pass; do not close its review thread based on this unmerged PR.
