## Now
- [ ] Review draft PR #146 and verify TypeScript, lint, Vitest, production build, and one live owner smoke test before merge.
- [ ] Remove remaining legacy investigation/reviewer modules only after import dependents and old route tests can be retired without orphaned references.

## Next
- [ ] Add grounded quick-reply chips and proposal/approval flows.
- [ ] Add rolling conversation summaries and remove unused legacy routes.
- [ ] Reconcile the AI usage ledger's per-increment limits with the agent's budget before general release.

## Done (last 10)
- New streaming agent SSE endpoint is the default home chat send path, without /progress polling.
- Strict three-tool schema, tool-call pairing, six-call total budget, error recovery and logical retry status.
- Locale-aware money/percent checks, plus validated multi-block persistence and database-compatible grounding statuses.
- Added recorded fixture and reply-writer tests; retired the supervisor-gap regression workflow.
- AGENTS.md now includes code-review blockers for retired designs and invalid tests.
