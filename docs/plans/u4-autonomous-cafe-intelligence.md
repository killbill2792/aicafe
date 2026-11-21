# U4 — Self-directed café intelligence and owner routines

Status: approved for full development by the owner, November 20, 2026. This document is a binding implementation and verification contract, not proof of delivery.

## Outcomes

The existing **single Luna Supervisor** investigates meaningful café risks and opportunities unprompted, using model-selected registered tools and independently verified source facts; it follows owner-defined natural-language routines as real recurring objectives, and keeps owner chat uncluttered. No developer-written per-issue procedure, fixed tool sequence, separate AI, scheduler, reader, calculator or effect gateway.

## Data and lifecycle

- Input sources: verified café/owner/thread context and current source changes on the existing derived refresh; existing POS, sales, staff, stock, finance, events, supplier and Gmail tool registry and canonical calculation, and optional U3 signed SQL research when separately configured. Source payloads are untrusted data.
- Authoritative tables and keys: `supervisor_routines` (business_id,id), `supervisor_routine_occurrences` (business_id,routine_id,local_date) with stable run_id, `supervisor_investigations` per owner/source, `supervisor_runs` with request_key and run steps, proposals/effect receipts, existing owner message and Work ledger.
- Owner-created routine stores full objective text and original authenticated owner message identity, local schedule, timezone, revision, and active/paused/revoked status. Legacy priority-check routines retain their former behavior until explicitly changed.
- Due full-objective occurrences actually invoke Luna's existing model execution with a distinct verified system-initiated origin, not a fabricated owner message, and create durable checkpoints/verified report before successful completion.
- Normal proactive monitoring may trigger bounded cross-domain research without matching a developer-created anomaly; Luna chooses hypotheses and tools, not business rules. Verify current source/owner/tenant and reject stale, absent, contradictory and untrusted evidence.
- Separate research strategy from optional U3 SQL configuration; approved registered tools remain usable without it.
- Keep existing owner approval and independently verified effect gateway: no email, supplier order, staffing change, price publication or business effect without authority. Revocation and uncertain receipts fail safely.
- One scheduler, one agent, one work lifecycle. Cross-job cost/latency fairness, deadlines, retries, DST, re-edit revisions and crash recovery must be measured, not assumed.

## Owner experience

- Chat natural-language create/list/edit/pause/resume/delete. The owner can edit the objective without supplying a programmer-defined procedure. Use exact routine ID and revision under original owner/tenant/thread.
- One compact saved acknowledgement. Routines live in the existing sidebar/chat with local next time, state, edit/pause/delete actions; no standalone dashboard, large cards, recurrent event popup or flood of step/status notices.
- Routine deletion removes it from active navigation, preserves audit history and securely stops future executions. Show real current status and independent run receipts.
- Autonomous Luna Watch is separate from owner-created named routines and should not fill the routine list with every observation.

## Approved file ownership

- `lib/ai/supervisor/routines/**`, `lib/ai/agent/tools/routines.ts`, minimal tool registry and existing worker/agent integration.
- `lib/ai/supervisor/runs/**` or `app/api/cron/refresh-derived/route.ts` only as necessary to reuse verified durable origin and current wakeup.
- `app/api/ai/supervisor/routines/route.ts`, `components/home/SupervisorMandatePanel.tsx`, existing chat/presentation code only as strictly needed, `messages/en.json`, related tests.
- Additive `supabase/migrations/*_u4_*.sql` and DB security tests, `evals/acceptance` registrations/independent oracles, relevant docs. Never edit `PROGRESS.md` in a coding PR.

## Independent acceptance matrix

| ID | Required executable evidence |
| --- | --- |
| U4-01 | Owner routine executes original cross-domain objective with no existing alert and stores real read/report receipt |
| U4-02 | Unattended verified wakeup identifies a novel business issue without owner prompt or prewritten detector |
| U4-03 | Changing evidence changes model hypothesis and tool plan and prevents duplicate/inappropriate notices |
| U4-04 | Model-led general investigation works with optional U3 SQL disabled and signed SQL scope when enabled |
| U4-05 | Precise money, grain, coverage, dates, source freshness and missing state independently match original canonical records |
| U4-06 | Real process killed and resumed retains one original work ID, checkpoint, budget and no duplicated effect |
| U4-07 | Due-once owner/tenant isolation, edits, revokes, pause, concurrent cron, timezone/DST and retries |
| U4-08 | Approval revision/expiry/revocation, hostile source prompt, uncertain effect, independent readback and cross-tenant denial |
| U4-09 | Chat/cron/POS/incident contention, measured resource use, budget and fairness |
| U4-10 | Authenticated mobile/desktop browser routine create/manage/reload and uncluttered accessible chat |
| U4-11 | Executable independent oracles fail closed on missing, skipped or unrelated scenarios; no self-reported model success |
| U4-12 | Final-head TypeScript, lint, build, all unit/DB/security/browser tests and clean authentic Codex; reconcile Task17B/C/D and #542 |

## Release boundary

Owner approval covers full U4 implementation, safe migration **development**, no-provider testing, CI, Codex and eligible development merge. Real paid Luna execution, production **U4** migration/feature activation and business/external effects remain separately controlled. No claim of integrated or released proof before the applicable actual execution.

## Traceability

Implementation PR must carry an item-by-item requirement -> runtime path -> persisted evidence -> independent test -> browser result matrix. Green CI alone is insufficient. Report every unverified acceptance item truthfully; do not quietly redefine planned behavior as completed.
