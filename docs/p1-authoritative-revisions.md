# P1 authoritative source snapshots — integration contract

Tracking: Issue #74, foundational draft PR #93, consumer PR #87.

This is **not** the product's second data store. PostgreSQL canonical
business tables remain the only data source. The `p1_business_source_epochs`
row is a transactional invalidation token; it never stores projected prices,
recipes, wages, daily facts or completion assertions.

## Transaction invariants

- Reviewed **AFTER STATEMENT transition-table triggers**, installed by migration
  70, advance the appropriate business epoch in the **same transaction** as
  each tracked canonical write. Multirow CSV/Toast promotions cost one epoch
  advance per statement/business, not one per row.
- The shared business epoch serializes concurrent writes to tracked sources
  within each business. The snapshot RPC's **single SQL STABLE statement**
  reads the epoch, menu, ingredients/prices, recipes, wages, payroll settings,
  daily rollups, expenses, recurring costs and import states from **one
  MVCC snapshot**. Multiple independent PostgREST calls are never one snapshot.
- `p1_authoritative_source_snapshot(uuid)` is owner-only and requires the
  authenticated selected café to be passed by the server, never by the model.
  The function returns no data for manager, demo or foreign tenants.
  It does not grant clients write access to epochs.
- `revision` is a database commit-state marker, not a timestamp, content
  hash, estimated source confidence or proof that POS coverage is complete.
  Revisions from different businesses are incomparable. The snapshot result
  explicitly says `coverage: "not_proven_by_revision"`; source arrays that
  reach caps have corresponding `truncated` flags.

## Consumer integration rule for PR #87 (after approved merge)

One P1 adapter call must select the complete set of source facts used by a
cross-domain calculation from **one RPC result**. Project approved sources
through existing strict P1 domain schemas and canonical lib/calc functions.
Give every source-backed operand the same exact authenticated business and
revision, *but only when it originated within that same RPC result*, not via
independently executed queries. Preserve record-specific evidence status,
actuality, unit/currency, coverage, missing/stale/estimated input lists and
selector/purpose contract versions. A database epoch does **not** upgrade a
partial/estimated slice to verified or prove absence; a 501-row bound or
missing import/date coverage must remain partial/unavailable.

P3 must reject mixing epochs in one expression. For data that cannot be
projected from the atomic snapshot (e.g., a legacy independently fetched
source, unverified external quote or unsupported variant mix), preserve
`sourceRevision: null` and explicit conditional/unavailable behavior.
A read performed later at a different epoch is a different snapshot;
re-run the entire read/plan or give an honest conflict, never borrow it.

The provenance contract cannot be switched to non-null solely because
migration 70 exists in a repository. Deployment is separate, owner-controlled,
and absence of the RPC/epoch must fail closed.

## Source changes and import futures

The installed table list lives in migration 70. This includes direct
owner/manual writes, committed CSV job and canonical promotion tables,
connected POS canonical orders and line items, payroll, expense and recipe
tables. The same triggers apply regardless of writer (owner API, CSV staging,
future Toast integration); they do not rely on provider-specific callbacks.

A CSV job with status `done` says that *that import job* completed, not
that every day, product, modifier, wage or historical transaction is covered.
Data sources without tested full source-selection/absence/coverage contracts
remain partial even with real epochs. Do not infer zero from missing rows.

Any **new canonical source table or material write path** must extend the
trigger inventory and disposable integration tests in the same PR before
it can provide revision-backed P3 evidence. Schema migrations that
bulk-rewrite source tables also advance epochs through the triggers.
Do not use TRUNCATE on revision-tracked business tables as an application
write method.

## Validation and release

`.github/workflows/p1-source-revision-db.yml` replays every migration
against disposable local Supabase and tests concurrent transactions,
rollback, tenant isolation, source absent status and revisions.
The test suite does not touch a production database or customer records.

Owner approval is required before merging this foundation, running
migration 70 in production, changing P1/P3 provenance contracts or
enabling Supervisor P3 feature flags. Never count a draft migration or
green CI as proof of an applied production schema.


## P3 source consumer — PR #94 (read-only, review pending)

The P3 consumer reads the authorized PostgreSQL snapshot through
`readAuthorizedAtomicP1SourceSnapshot()`; source-backed operands are projected
from the *same* response, with exact tenant, timezone, selector, purpose,
registered reader and epoch. Legacy P1 shadow calls still establish model-
selected **selectors**, not an authoritative snapshot or numerical source for
revision-backed operands. For successful atomic projection the observation
content hash is deliberately null; the epoch belongs to PostgreSQL.

The allowlisted P3 snapshot adapters currently cover active menu item price,
available recipe-line/ingredient prices, hourly wages (not inferred salary
conversions), recorded payroll burden, selected-day daily rollups, and
compatible per-mL ingredient prices converted to US gallon cost with the pure
calculation library. They do not prove historical POS completeness, option-mix,
substitution entitlement, overtime rates, full staffing requirements, supplier
freshness, expense categorization completeness, or net profit. Those remain
unavailable/partial/conditional, even if an epoch is present. Estimated burden
and price freshness are not upgraded to verified.

The expression engine rejects mixed epochs. The Supervisor rechecks an epoch
before returning a result and discards an answer after a concurrent source
update. If the owner-only RPC is missing or inaccessible, P3 retains only the
legacy **explicitly partial and unversioned** conditional path; it never
assigns a fabricated revision or borrows the epoch for an independent read.
This is not evidence that migration 70 has been deployed to production.

Executable gates: `lib/ai/supervisor/p3/snapshotOperandSources.test.ts`,
`lib/ai/conversations/runSupervisorP3.test.ts` and real, disposable
PostgreSQL verification of the P3 adapters via
`lib/metrics/p1AtomicSourceSnapshot.db.test.ts`. P3 changes now trigger
`.github/workflows/p1-source-revision-db.yml`. Separate owner-controlled
migration, staged café rollout and browser acceptance remain release gates.

**Status-preserving safety gate (Codex P1):** The current SQL snapshot contract
does not include `daily_rollups.card_fees_status`. P3 therefore does **not**
project `cardFeesCents` as an atomic daily source operand, even when the
numeric field is zero. It must remain unavailable until a separately reviewed
and deployed status-preserving source contract exists. A successful `NULL`
snapshot response is an invalid/absent authoritative ledger and fails
closed; only an actual unavailable-RPC error may use the explicitly
unversioned legacy conditional route. Neither case fabricates an epoch.
