# Admin dashboard and access-code review contract

Keep this file aligned with PR #165 and future modifications. It supplements AGENTS.md, which takes precedence.

## Merge-blocking invariants

- Every API or server action that invokes a paid provider, an AI tool, or an owner approval **must** verify authenticated owner/business scope and active café entitlement on the **server** before calling the provider or committing. UI disablement is not authorization. Keep read-only history, data and existing attachments available after expiry.
- Inventory all affected endpoints, including transcription, background agent turns, legacy proposals/experiments, memory-rule drafts/reviews, supplier research, and uploads. The Vitest endpoint-coverage test is a guardrail, not a substitute for manual endpoint discovery.
- Owner code redemption and admin pause/extend must share database row locks. Concurrent redemptions cannot exceed max cafés. A paused café cannot self-reactivate. **Grandfathered cafés remain unlimited until admin explicitly changes their status.** Invalid codes must consume the rate-limit allowance.
- Count all historical redemptions in the database; **never** derive capacity, totals or user eligibility from a paginated/truncated ledger. Give admins navigable history for older codes and owners.
- Expiry dates are inclusive café-local civil dates, including the 7-day warning; test across UTC midnight and daylight-saving transitions.
- Never persist raw prompts, answers, receipts, bank transactions, PII, or free-form diagnostic output into logs. Audit steps contain fixed, allowlisted labels. Existing legacy telemetry requires a documented scrub before new deployment.
- All service-role database queries and mutations live in `lib/data`, with independent authorization in the caller or helper. Register new `lib/data` exports in `lib/metrics/p1SourceManifest.ts`. Service-role secrets never reach client components.
- Owner text is localized in `messages/en.json`, `messages/es.json`, and `messages/ar.json`; do not show database enum/status tokens. Check RTL. Targets are at least 48px and body text at least 17px.
- Store pricing as integer cents. Do not enable checkout; café price examples require product-owner verification.

## Verification sequence

1. Reconcile the PR with current origin/main and inspect each overlapping file. Do not drop upstream changes; particularly keep current agent-loop evidence, P1 source inventory, Home enhancements and all translations.
2. Review all changed endpoints against the authorization matrix, including HTTP methods and indirect aliases.
3. Verify rate limiting, pause/extension concurrency, fixed-date and duration-code behavior, token/cost unknown status, tenant isolation, audit privacy and idempotent migrations.
4. Run strict TypeScript, full lint, all Vitest tests, production build, disposable Supabase migration replay, accessibility smoke checks and authenticated staging checks.
5. Request an independent Codex review **after** the final code is pushed. Resolve new findings and rerun checks before seeking a human-approved merge. Never auto-merge.
