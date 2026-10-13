# Dependent Toast adapter PR

The adapter implements authenticated, read-only Toast V2 orders/menu and labor GET endpoints using the previously reviewed client. Importing into canonical facts remains disabled until the full reconciliation-safe coordinator is built.

The OrdersBulk modified-time endpoint is NOT a closed-time coverage query; fetchOrders must not be taken as proof of zero sales. Explicit business-day fetching is exposed separately. Money is converted from Toast dollar amounts to integer cents, including discount and refund exclusions. Ambiguous payment refunds or missing wages fail rather than being replaced with zero; processing fees are missing, never actual.

Menu V2 nested catalog is flattened with null for context-specific pricing. Scheduled shifts are returned independently from actual time entries and given a separate RLS-covered table. The table is not automatically populated yet.

Not implemented: canonical upsert isolation, CSV overlap controls, historical void handling, verified closeout/date coverage, missing-wage nullable provenance, webhook signatures, polling, job resumability, localization, or an authorized live reconciliation. Never activate automatic Toast syncing based on this PR.
