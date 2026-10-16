# Olivia PR4B-A — Scheduling command capability layer

Tracks #74. This is **domain implementation**, not owner chat integration.

## Supported Olivia domain paths (version 1)

- \`prepareOliviaAvailabilityCommand\`: typed list of 1–40 employee/date-period changes, identified by existing UUID or unique exact display name. It authenticates the tenant owner; reads every saved employee's records through PR4A; detects ambiguous/unknown/inactive identities and stale record revisions; reconciles add/replace/remove without deleting unrelated recurring windows or exceptions. Every new/changed window requires an explicit source and is only owner-confirmed after a separate human action. Scope-by-scope expected manifests, tenant and SQL source token are bound in the returned proposal. **No writes.**
- \`commitOliviaConfirmedAvailability\`: requires the separately issued \`OliviaOwnerActionProof\` for the exact proposal digest, authenticated owner and request key. The proof is non-serializable, process-local, five-minute and single-use. It rejects model-authored boolean \`confirmed\`. A new SQL transaction rechecks ownership, source token, exact expected revisions and existing PR1B batch receipts, and writes **all** requested employee scopes or none, with existing PR1B audit triggers and independently verified record readback. SQL changes remain behind existing scheduling opt-in flags (none enabled by this PR).
- \`createOliviaScheduleDraftCommand\`: versioned week/objective/request key plus expected PR4A source digest and draft revision. Uses PR4A preview and existing PR3 trusted loader, optimizer, insert and **independent persisted revision + assignment readback**. Returns exact persisted assignments, coverage gaps, qualifications, cash and loaded cost state, wage and policy missing inputs, warnings, source digest, draft revision, and separate \`readyForOwnerApproval\` and \`readyForPublication=false\` dispositions. No approval/publishing/attendance mutations. Unconfirmed or insufficient labor policies are not represented as publication-ready.

The initial proposed intent must specify exact dates (business/local civil dates), start/end wall-clock minutes, overnight status, employee identity and source. Olivia does **not** parse chat, guess a person or hours, reconstruct dates from vague text, infer staff wages, or require a POS feed.

## Security and ownership boundary

The owner-action proof **issuer is intended solely for a future audited first-party owner-confirm handler** after the human has seen exact affected names, dates, sources and proposal digest. **No owner-facing confirmation UI is wired here** and the issuer must never be called by Supervisor, a model tool or a general public request handler. This prevents the command adapter from treating a model-supplied flag as approval. A successful draft remains only an inert revision until the existing separate PR3 approval and publication transitions are invoked by their rightful owner UI.

The new SQL is additive, owner/tenant-scoped, source-token checked, atomic across employees, idempotent across retries and uses PR1B per-row audit/revision checks. The DB function is executable by authenticated owners (as are existing PR1B batch functions), and cannot be used by unauthenticated users or managers. No service-role secret, arbitrary SQL, new API endpoint or Supervisor tool is exposed.

## Manual gates still required

Review PR checks on final HEAD, especially disposable DB migrations and \`scripts/olivia-pr4b-rls.sql\` for multi-worker rollback, replay, owner/manager tenant isolation and source CAS. Review real staging workflow and worker identities. Independent reviewer/codeowner approval and owner-controlled production migration and feature-flag enablement remain separate. PR4B-A is **not** production-activated; actual Supervisor chat integration and owner-facing controls are Kilbil's later phase. Never merge or deploy from this task alone.
