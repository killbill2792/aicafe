# Luna rebuild

Luna is the operator an owner can delegate a shift to. An owner or employee should be able to return to the same conversation after closing a browser, see what actually happened, correct the assignment, and retrieve its output. A reminder is complete when its delivery has a receipt. A research request can complete in the current conversation without creating a routine.

## Execution and ownership

Base for the initial design is main at 28622880. PR #593 at 2367d651 owns external ingestion, archive keys, source grants and research data discovery. Its resource identity is business, provider, source account and resource. An unknown grant, an empty result and an unsuccessful collection are distinct observations. Luna should consume the scoped research functions and their coverage metadata. Recheck the merged contract, permission revocation and two-business isolation before integration. This branch can independently develop conversation, scheduling and presentation behavior. Do not bring the archive migrations into this branch.

Owner or employee message → authenticate actor and tenant → admit one logical run → claim a due step → select authorized tools → persist the result → deliver and record a receipt.

| Source | Durable identity and fields | Readers and constraints |
| --- | --- | --- |
| Existing owner chat | Business, owner, thread and original message ID; original receipt time, attachments and answers | Conversation service, worker and browser resume from stored IDs. Employee conversations keep their own permission scope. |
| Time, routine or business event | Business, schedule ID and occurrence; due instant in UTC, IANA zone, recurrence or source event identity, delivery destination | Existing one-minute worker claims due occurrences independently of POS refresh. Preserve original occurrence through retries and DST. |
| Execution | Existing run/step, engine version pinned at admission, lease token, retry time, effect checkpoint and attempt receipt | Worker renews the lease and checks current authority before dispatch. Browser stop and retry address a persisted run. An uncertain external send requires reconciliation. |
| Business knowledge | Source grant, observation version, tenant notes, corrections and provenance | Tenant-scoped tools resolve records on demand through the business layer. A revoked permission invalidates evidence on resume. |
| Document | Stable document ID, business, authorized thread, immutable version, predecessor and private Storage object | Save before reporting success. Readers verify permission on every read. Concurrent edits compare expected predecessor and retain both authors' work. |
| Owner decisions and staff messages | Existing proposal, recipient identity, approved revision, effect hash and receipt | Recheck authority at delivery. A correction to a document or chat message cannot authorize a business action. |

Assign one engine to each admitted run, including work created by a routine. Rollback changes future admissions. Drain already claimed work under its recorded engine and reconcile uncertain effects before enabling a successor. Keep legacy identifiers, access rules and readable content throughout. An environment flag alone cannot fence workers.

## Research and validation

The capability matrix will distinguish physical application behavior, deterministic checks and authorized provider acceptance. Live provider execution, production migration, deployment and destructive retirement require separate authorization. The new route stays opt-in until that evidence exists.
