# Unrestricted research and resumable execution

Owner decision: Luna chooses its authorized SQL, calculation, research duration and number of calls, and presentation. Remove application-imposed research deadlines, forced synthesis, output and cumulative model/tool/token allowances. Provider context constraints and physical platform execution windows cannot be removed by application code.

The existing owner-run lease and routine/incident leases own continuation; a physical slice yields, saves the admitted transcript and pending calls, and resumes the same objective. Source permissions are checked again before restoration. No second planner or independent research job is created. Provider usage remains measured, and explicit commercial policy or disposable acceptance controls are separate from research behavior.

## Database deployment

Apply `20261127001000_luna_research_continuation.sql` through the normal migration workflow. The existing SQL function has statement_timeout=0; all other database roles retain their normal timeout. Supabase's HTTP API has its own hosting deadline. To use a direct or session-pooler connection in production, provision a dedicated login granted the migration's `supervisor_research_transport` role, with no other table privileges, and set its secret server-only connection URI as `SUPERVISOR_RESEARCH_DATABASE_URL` on Vercel. Use TLS and verify database server identity. Do not put credentials in GitHub, a browser, or model context. The same scoped research RPC remains the sole executor. Without that secret, the existing RPC transport remains available but its gateway deadline still applies.

The item/day view uses order and item facts directly, eliminating unnecessary JSON reconstruction and the typed Toast join for this aggregate. Screen business definitions remain unchanged.

## Evidence

Read-only production comparison over three dates: 110 original and 110 revised aggregate rows; no differences in either direction. Revised four-month top-item query executed in about 5.05 seconds via EXPLAIN ANALYZE. This is query evidence, not proof of deployed application behavior. Unit cases exercise 42 SQL calls, more than five minutes of simulated elapsed time, resumed presentation evidence, and estimated/derived UI. Exact-head CI and real-model deployed acceptance must be recorded separately. No paid provider test, production migration or merge is implied.

## Events scope separation

Owner decision (2026-11-26): Events is a separate redesign, tracked in draft #587. The existing three event research callers use the shared research engine but do not persist an interrupted event transcript. Durable event-specific continuation is deferred to that redesign, not claimed as implemented here. Owner explicitly approved `big-ok` for #585 and #586 and delegated merge after verification. No production migration or deployment is authorized by this decision.

## Owner-reported accounting answer and signup regression (November 26)

Read-only production message metadata showed a recent accounting reply timed out after a rejected visual section (two decoded patches, zero accepted/persisted views). The exact rejected patch payload is not available in this evidence. In the shared research loop, return actual render delivery failures to Luna for repair or Markdown fallback while retaining admitted prose, valid views and SQL results. Persist repair state with existing continuation; a repeated identical rejected section surfaces a technical notice instead of an unbounded identical retry. This is technical delivery feedback, not confidence scoring or a new research budget. Deterministic regression exercises the accounting-shaped failure and repaired ledger/Markdown; live model behavior remains unverified.

A recurrent private-signup E2 failure exposed the existing non-atomic check-then-create. Replace that existing writer with one service-role-only, security-invoker SQL function using a per-authenticated-owner transaction lock and atomic business/membership/recovery-order writes. No cleanup of existing businesses, changes to signup policy or production DB execution. Add concurrent disposable PostgreSQL regression and retain the existing Playwright assertion.
