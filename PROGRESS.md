## Now
- [ ] Review PR M0: team_updates storage/writer/owner reads, including PostgreSQL RLS and full CI; migration not deployed.
- [ ] Run one live owner agent smoke test before production deployment of #146.

## Next
- [ ] Add grounded quick-reply chips and proposal/approval flows.
- [ ] Add rolling conversation summaries and remove unused legacy routes.
- [ ] Reconcile the AI usage ledger's per-increment limits with the agent's budget before general release.

## Done (last 10)
- PR #146 merged: streaming agent is the default chat path; signed-currency and usage-attempt fixes included.
- New streaming agent SSE endpoint, without /progress polling.
- Strict three-tool schema, tool-call pairing, six-call total budget, error recovery and logical retry status.
- Locale-aware money/percent checks, validated multi-block persistence and database-compatible grounding statuses.
- Added recorded fixture and reply-writer tests; retired the supervisor-gap regression workflow.
- AGENTS.md includes review blockers for retired designs and invalid tests.
