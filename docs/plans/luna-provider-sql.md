# Luna read-only provider SQL and external-data review

## First delivery

Give each replacement workforce assignment the existing `describe_database`, `run_sql` and `calculate` contracts. The server takes café and owner from the claimed run, passes the single model-authored statement through the existing restricted PostgreSQL connection, and records the returned rows or error under the existing run and tool-call receipt. A recovered worker uses the stored result. The publication transaction remains the authority on whether newer owner input requires another model response.

The model can inspect original provider fields in `external_records.payload`. The archive identifies the café, provider, account, resource and stable provider key. Source metadata supplies the observation date, origin and coverage. Revisions record changes and, for new deltas, whether a key was present before and after. Verified relationships and authority metadata help identify overlapping records. Missing permission, a failed collection, absent fields, explicit null and a recorded zero have distinct meanings. The audit will check those distinctions before any data-path retirement.

## Acceptance

Use original Toast order and payment payloads from a disposable two-café fixture. Ask the replacement to discover the sources, reconcile accepted net sales with available processing fees, and identify an order whose fees remain unknown. Independently check the cents, source identities and coverage. Verify that the scoped executor returns no rows for the foreign café and rejects writes, and that neither request changes persistent data. Interrupt the worker after a SQL result is saved, recover with a new lease, and confirm the result is reused. Add a late owner correction after a draft response is saved and verify the only published answer reflects it.

Employee chat and scheduled admission need the same run and rollback semantics. Test engine pins, independent due dispatch, existing history, and two-café isolation before fresh live acceptance and first-café activation.

## External-data review

[PR #593](https://github.com/killbill2792/aicafe/pull/593) introduced the shared archive and retired several duplicate stores. [PR #601](https://github.com/killbill2792/aicafe/pull/601) attributed historical evidence while preserving original payloads and revisions. [PR #602](https://github.com/killbill2792/aicafe/pull/602) moved historical fee estimation to the existing orders projection already used by daily rollups. It added no database object. The review will verify direct and transitive application consumers, provider coverage, owner-managed state, financial selection rules, and historical fallbacks before proposing changes to those paths. The SQL integration can proceed independently of the remaining Toast and CSV writer migration.
