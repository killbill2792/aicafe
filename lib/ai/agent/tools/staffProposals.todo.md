# Staff approvals — PR #163 Step 1

Seven `propose_*` tools now use the **existing** `supervisor_proposals` /
`supervisor_approvals` ledger. Cards are localized (en/es/ar) and show
before/after values; owner click is required for any staff write.

The service-role function `supervisor_commit_staff_proposal` added to the
existing 088 migration checks owner/business/thread, approval hash, immutable
effect, current source CAS, and commits all staff rows and the final ledger
transition **in one transaction**. A stale effect becomes `stale`; failed
writes roll back. The endpoint reconciles unknown HTTP outcomes by rereading
the ledger. Concurrent approvals cannot double-commit.

Availability proposals work without a published schedule. `propose_send_schedule`
commits **preparation only** (and only consented phone recipients are recorded
in the delivery ledger); nothing is transmitted via WhatsApp in Step 1.

Later steps (out of scope for Step 1): Meta send after explicit approval,
a consent-setting UI, webhook status handling and recipient-specific delivery
acknowledgments. Do not conflate `prepared` with `sent` or `delivered`.

Only `20261023000088_staff_approval_prep_delivery.sql` is added for this PR.
Do not apply it to production before review/merge.
