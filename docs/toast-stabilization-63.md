# Toast stabilization #63 — design contract (blocked from production)

This PR is based on the completed draft #62 head; migrations 40–50 remain unchanged, migration 51 is additive.

## Audited bugs and repairs
- Clock-in-range polling missed prior-day edits. Added explicit historical attendance and modifiedStartDate/modifiedEndDate reads. Modified API results include archived entries. A bounded poll cursor advances only after all staging batches return success.
- Scheduled shifts are *not* modified-date events: GET /labor/v1/shifts filters startDate/endDate and caps at a month. Poll recent corrections, today and a configurable upcoming horizon separately, even before opening. Atomic complete-window staging marks only missing provider shifts in the strict full-window predicate deleted.
- Open/reopened/voided/deleted/refunded/ambiguous orders are retained as provider states. Completed canonical facts are never silently replaced by fabricated zero. Conditional row-version RPC prevents late poll/webhook workers overwriting a newer state.
- Signed event retries at 5/10 minutes retain body+timestamp HMAC validation while using a bounded 30-minute maximum age and durable event-ID dedupe. The receiver still needs live latency tests.
- Configuration RPC now uses a transactional mapping diff rather than tearing down unchanged IDs. Attempted removal of mappings referenced by provider facts raises an exception and rolls back all credential changes. Any credential re-save invalidates tokens/verification.
- Historic polling beyond 30 days reports requires_historical_backfill; it does NOT jump to the last 30 days. Recoverable history is processed five minutes at a time, safely resumable.
- Gross/net/refund-date/closeout report semantics remain unverified. Canonical promo and zero-day safeguards remain disabled and unchanged; owner-entered reports are not source-verified.

## Default deployment controls
Unset/false: TOAST_SETUP_ENABLED, TOAST_WEBHOOKS_ENABLED, TOAST_PILOT_IMPORT_ENABLED, TOAST_CANONICAL_PROMOTION_ENABLED, TOAST_JOBS_ENABLED, TOAST_POLLING_ENABLED. Never change vercel.json or existing Supervisor/AI Team/Square/CSV/break-even/payroll.

## Exact owner webhook registration procedure (after an authorized staging pilot)
1. In Toast Web, under **Integrations > Toast API access > Manage credentials**, create eligible read-only standard API credentials for each selected restaurant. Require RMS Essentials+ and Manage Integrations 8.4.
2. Using the secure AI CAFE owner interface, save client credentials and restaurant GUID mappings; never send secrets in chat, email or messaging.
3. Provision a new, unique URL token/subscription UUID and encrypted subscription-specific secret in a restricted deployment secret-management workflow. This provisioning step is **not yet exposed in the UI**, so do not enable a subscription yet. A UUID in the URL is not authentication.
4. In Toast Web > Manage webhooks > Add webhook, select those credentials, event category **Orders**, HTTPS webhook URL ending /api/pos/toast/webhook/{subscriptionId}, name and notification email; keep subscription **inactive** pending validation.
5. On Toast Web's subscription detail page, retrieve the unique signing secret via a password manager / secure secret-management channel (not chat). Register it encrypted via a controlled service-role server action, with read access denied to authenticated/anon clients. This codebase **does not yet provide** that action, so operator must not turn on webhooks before implementing and reviewing it.
6. In a disposable environment, test valid signature, 5 and 10-minute retry, duplicate GUID, invalid signature, delayed event, 503 retry; confirm ACK latency fits Toast's documented timeout. Only an owner can authorize a live pilot.

## Safe migration order
Stage a disposable Supabase database with the full existing migrations and seed required auth/business fixtures. Apply original migrations 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50 **in numeric order**, then 51. Run the SQL integration suite, npm test, Toast-scoped lint, tsc, build; fix any failure before discussing production. Never execute automatically on production or rewrite already applied migration files.

Unresolved: independently verified Toast daily reports incl. payment refund dates, safe legacy CSV overlap exceptions, accounting corrections and validated provenance-driven promotion to canonical wages/menu catalog and verified zero. No authorized live Toast reconciliation has occurred.

## Independent source verification boundary
Migration 52 requires a separate service-role-only independent Toast report attestation bound to the exact staged checksum. Owner-entered comparison by itself cannot promote sales. No attestation UI/action exists, so production promotion stays OFF. Service charges and selection voids remain ambiguous and cannot count as verified completed sales.

## Legacy RPC lockdown
Migration 53 revokes direct service-role EXECUTE on two obsolete canonical promotion implementations and on the former delete/recreate location-mapping RPC. Only the latest guarded promotion entrypoint remains callable, with the independent-report evidence gate. It grants service-role access to the evidence table while keeping anon/authenticated access denied. Tests verify these privileges on live disposable PostgreSQL.
