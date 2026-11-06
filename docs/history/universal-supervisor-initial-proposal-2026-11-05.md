# Historical first proposal — November 5, 2026

> Preserved for architectural context. Superseded by [the compact current plan](../plans/universal-supervisor-delivery-queue-2026-11.md), [task briefs](../plans/universal-supervisor-task-briefs.md) and [queue](../plans/universal-supervisor-queue.json). These notes are not authorization or a current dispatch state. AGENTS.md wins.

---

# Universal Supervisor — executable delivery queue (proposal, November 5 2026)

**Status: PROPOSED. Planning document, not permission to implement, merge product changes, deploy, send real messages, or apply production migrations.** The owner approves architecture and production effects explicitly. `AGENTS.md` and its linked rules win on any conflict.

**Finish line:** milestone **PR17**, a fully integrated, owner-authorized, continuously operating café Supervisor, not merely 17 merged GitHub PRs. PR13–PR17 below are **milestones / workstreams**; split them into small single-concern implementation PRs (ideally <400 behavioral lines) as the file inventory proves necessary. Never disguise a multi-domain system as one huge PR. Each sub-PR has one accountable agent/chat, one file owner, tests, proof and review. This keeps the owner's milestone numbering without violating repo review rules.

## 0. Source-of-truth reconciliation — do not guess

1. `AGENTS.md` defines one universal AI café operator; `docs/rules/ai-architecture.md` requires one streaming model/tool loop, no persona agents/router/reviewer; `docs/rules/product-and-autonomy.md` currently requires owner-click approval for effects and prohibits POS writes and direct staff/supplier sends. Those prohibitions remain until a **separate owner-approved rule change**. An owner's stated long-term desire is not authorization for a concrete external effect.
2. `PROGRESS.md` includes historical priorities and older work. Use current code and actual PR status to resolve conflicts. `docs/supervisor-platform-architecture.md` is marked **RETIRED**; do not implement it.
3. Grok's six-page `AI Cafe owner queue` is a November 4 snapshot. Its PR6+ briefs are said to live in **Grok-local** `/workspace/pipeline/briefs/` and `/workspace/universal/reply1.txt`; their full contents were **not supplied**. Do not falsely claim PR6–PR12's exact scope or acceptance tests are verified from those files. Before dispatching each of PR6–PR12, retrieve the owner-approved brief or obtain owner's explicit agreement to the replacement proposal. This queue extends, does not overwrite, Grok's work.
4. Verified merged PRs as of this proposal: Toast #361, saved facts #362; universal query #375 (PR1), data coverage #379 (PR2), commitments #377 (PR3), notices #376 (PR4), durable runs #378 (PR5); E1 #369, DB CI B2 #374, skills #371/#381, Squawk #382, café-delete fix #383. Verify again before use; merge is not proof of deployment/live acceptance.
5. The PR baseline currently has TypeScript, lint, full Vitest, build, guarded SQL tests via disposable local Supabase and recorded Supervisor evals. A **required Playwright E2E job is not demonstrated** by `.github/workflows/ai-cafe-pr-baseline.yml`; E2 in Grok's queue is still a separate verification/implementation gate. Existing `.claude/skills/playwright-cli/SKILL.md` is not itself an executing CI job.
6. The existing phone flow in `components/operations/OwnerWhatsAppAlerts.tsx` uses Supabase `updateUser({phone})` plus `verifyOtp(type:"phone_change")`; this establishes phone verification, **not** a scoped standing mandate. Existing `components/LoginForm.tsx` uses email OTP for login. Step-up authorization must verify the server's challenge-to-permission binding; do not treat arbitrary OTP success as grant consent.

## 1. Non-negotiable final product contract

Supervisor itself runs the café's supported digital and delegated workflows continuously: **observe → prioritize → plan → authorize → execute → verify → learn**, whether or not the owner asked anything today. Same single agent/loop for conversations and durable work; use bounded steps for long jobs rather than globally lifting the per-turn limits. It discovers usable data and tools, reads canonical sources, works with authorized files/connectors/browser, coordinates employees and suppliers, and maintains owner-visible records of outcomes and exceptions. New scenarios should usually compose existing capabilities, not require a new intent branch or separate automation agent.

**Authorization progression:** all consequential effects default to individual owner approval; later an authenticated owner can grant a **specific revocable standing authorization for repeat actions**, e.g. draft + publish weekly staff schedules and send messages to approved employees, each a distinct permitted effect. Broader delegation is an explicit bundle of permissions, **never an uncontrolled "full access" flag**. Server checks approved action/scope/tenant/café/channel/recipient/budget/time/revision at every effect. The model cannot grant or expand its own authority. Changes outside a mandate pause just that effect and request approval; unrelated authorized work proceeds. Emergency/regulated/irreversible operations must respect applicable human/legal obligations.

**Business source of truth:** money from `lib/metrics/core`; data through the existing RLS-scoped `lib/data/` readers and canonical views; one inbox (`operating_tasks`), one experiments lifecycle, one run executor, one approval path, one notices path and transport outbox. Browser screens, spreadsheets and email must not silently replace authoritative Toast or finance records.

**Outcome requirement:** a proposal is not executed; an API-accepted request is not necessarily delivered; a schedule sent is not necessarily accepted; an order placed is not received; an invoice issued is not paid. Each effect has state and independently verified receipt or an honest uncertain state with reconciliation.

**No permanent future bucket:** PR17 release is blocked unless the target capabilities below have passed integrated acceptance. If a capability proves impossible without third-party support, document its supported boundary and obtain a product decision, not fake a pass.

## 2. First-wave prerequisites: PR6–PR12 (reconcile existing Grok briefs)

| Milestone | Minimum architecture contract / acceptance | Existing reusable surface | Hard dependency |
|---|---|---|---|
| PR6 Durable work executor | Scoped worker claims leased steps; executes same existing AI loop in bounded sessions; saved checkpoints, idempotent retries, uncertain effect reconciliation, cancel/pause, per-run/per-café budgets, starvation prevention, work resumed after worker death; worker doesn't itself grant authority | `lib/ai/agent/loop.server.ts`; `lib/ai/supervisor/runs/repository.server.ts`; `supervisor_runs`, `supervisor_run_steps`; `lib/ai/conversations/usage.server.ts` | PR5 merged + owner-approved permission/worker contract |
| PR7 Self-managed work | Owner-defined and AI-proposed recurring tasks; time zone/DST, quiet hours, dedup, event triggers, owner-visible pause/revoke, prioritization and full observe→learn cycle; one due occurrence produces at most one run; no duplicate AI agents or crons | `lib/operating/commitments.server.ts`; `lib/attention/`; `lib/ai/supervisor/loop/` | PR6 worker contract |
| PR8a/8b/8c Domain cutovers | Experiments, Events and morning brief migrate only after old/new parity; retain POS ingestion, essential transport and health crons independently; exactly one authoritative writer and safe rollback per cutover | `lib/ai/supervisor/loop/engine.ts`; `lib/events/eventsLookahead.server.ts`; `lib/operating/briefSchedule.ts`; `lib/whatsapp/morningBriefDelivery.server.ts` | PR7 + each domain's live acceptance |
| PR9 Operational memory | Compact rolling thread summary, owner preferences/decisions/goals/open work with provenance; no cached current money; facts update/supersede/forget; no duplicate truth; correct owner and café isolation | `ai_threads`, `ai_messages`, owner facts, `lib/ai/agent/history.ts` | Existing memory/facts + run identity |
| PR10 Unified effect gateway | **Implement individual approval and standing mandates together**, action registry and verified receipts, server-enforced permissions, scoped phone step-up flow, revocation and queued/in-flight behavior, budgets and audit; no generic POS write | Existing proposals/approve/commit paths in `lib/ai/supervisor/loop/`; Supabase Auth | Final approved effect taxonomy and mandate schema |
| PR11 Connectors | Secure account linkage/revocation, capability metadata, Gmail read/draft/send under the same gateway, secrets never model-visible, provider reconciliation when send times out; externally sourced prompt text not trusted instructions | Existing WhatsApp and web adapters; `lib/ai/agent/tools/index.ts` | PR10 authorization/effects |
| PR12 General files + computer use | Authorized Excel/CSV/PDF parsing, provenance and bounded summaries; browser sessions for supported sites with least privilege, navigation research, step verification and write effects through PR10; authenticated-site limits and consent; no raw POS credentials | Existing file/attachment paths, read tools, `docs/rules/skills.md` | PR6 + PR10 + connector security contract |

**Required architecture sheet before *each* code PR:** trigger; data source with provider fields and drift cases; one record/key/save/update/retention/PII exclusions; existing path and file owner; execution sequence; permission and identity; failure/retry/uncertain-effect handling; collisions with other PRs; tests and rollback. Owner approves it once; later implementation PRs may implement the approved contract without asking repeatedly unless scope/security/production effects change.

## 3. PR13–PR17: mandatory completion milestones

Each milestone has independent **small implementation PRs** indicated by suffix. Numeric labels are queue IDs, not existing GitHub PR numbers. Small sub-PRs may open simultaneously against a prerequisite's branch; they merge only in dependency order. Never let two active implementers modify the same file.

### PR13 — End-to-end people operations (staffing and delegated workforce coordination)

**Owner outcome:** Supervisor autonomously forecasts coverage, drafts a legally/settings-constrained schedule, gets individual approval OR applies the owner's existing standing scheduling mandate, publishes through the *existing* schedule authority, notifies permitted workers, tracks delivery/acceptance/declines, handles shift gaps and escalates permitted exceptions. Maintain worker availability, leave, timecards and labor cost provenance. For recruitment: request/job posting, applicant communications, interviews and documented qualification evidence; require human/legal review wherever needed. No unverified employment decision.

**Implementation slices (scope proposed, confirm exact paths on main):**
- `13a` capability and authoritative data parity: `lib/scheduling/`, `lib/data/staff*`, `lib/ai/agent/tools/draftSchedule.ts`, Staff reads/tests; no new scheduling table without design.
- `13b` authorized schedule publish + notification adapters: reuse `lib/actions/staffDraftInPlace.ts`, existing approval/proposal and PR10 receipts, staff recipient binding and existing transport; do not send on draft.
- `13c` worker responses, delivery reconciliation, shift-change/coverage follow-up and absence simulation; reuse current timecard/scheduling records.
- `13d` recruitment/leave/onboarding support through general connector and business-action adapters; no automatic hiring/firing or sensitive personnel decisions without separately granted/legal authority.

**Prerequisites:** PR6, PR7, PR9 (continuity), PR10 (mandates), PR11 (outbound channels), PR12 for unconnected portals only.

**Proof:** seeded two-café data; independent schedule/cost parity with Staff screen, holidays/DST, no available staff, wage/budget cap, approval vs mandate, declined schedule, message failure/duplicate, revoked mandate between planning and send, OTP step-up binding, privacy/RLS, end-to-end mobile/desktop screenshots, evidence that a schedule was published and receipt verified (not merely drafted). No production staff contact in CI.

**Do not touch:** Toast financial definitions, unrelated Events experiment paths, direct POS write. Split any overlapping `tools/index.ts` edit into an assigned shared registration PR.

### PR14 — End-to-end procurement, inventory, financial administration and vendor workflows

**Owner outcome:** Supervisor observes stock and expected usage, assesses purchasing need, obtains item/vendor evidence from canonical records, owner-authorized sheet/email/browser sources, compares units/currencies/tax/terms/lead times, prepares PO/communications, uses specific permission or matching standing mandate to send/place, tracks vendor acknowledgement/delivery and reconciles invoice/received goods. It can also track bills, reconcile expense/payment evidence, forecast cash and prepare authorized financial operations without inventing transaction completion. Never move funds without a separate specifically approved lawful integration and mandate.

**Slices:**
- `14a` inventory and recipe/quantity evidence adapter, source-quality and missing-stock contract; owner-supplied/manual counts can be recorded with provenance, not equated to physical counts.
- `14b` supplier identity, quote and PO lifecycle against existing purchasing records, evidence/retention; if no authoritative record exists, approve a minimal domain record before coding.
- `14c` email/browser vendor execution via PR10/PR11/PR12, duplicate-order guard, uncertain result reconciliation.
- `14d` receipt/invoice match, partial deliveries, currency and unit conversion via code, duplicate invoices, exception handling; reuse money engine.
- `14e` finance administration read/reconcile/payable preparation and cash forecast; money-moving effect separately authorized and only if legally/provider supported.

**Prerequisites:** PR6, PR7, PR9–PR12; `14c` depends on `14b`; `14d` on `14c`.

**Proof:** price-sheet parsing, mismatched package sizes, missing currency, stale quote, duplicate vendor invoice, split delivery, failed email, timeout after provider accepts PO, forced retry, revoked purchase permission, spend cap, owner approvals, no double counting in `lib/metrics/core`, canonical vs screen equality, RLS/PII; executable Playwright test using fake vendor inbox/portal; real source pilot only after explicit consent.

**Do not touch:** duplicate finance definitions; write directly to POS or bank; store raw third-party credentials, real purchase in disposable tests.

### PR15 — End-to-end operating resilience, maintenance and escalation

**Owner outcome:** Supervisor maintains a live operating picture, independently detects and investigates anomalies, prioritizes risk, coordinates delegated staff/vendor work, tracks maintenance/equipment and operational incidents to evidence-backed completion, and runs within caps without getting stuck on a single task. It never confuses a reminder with completed work.

**Slices:**
- `15a` unified operating priority and exception adjudication using existing `lib/attention/`, `operating_tasks`, `lib/operating/notifyOwner.server.ts`; no second inbox, no duplicate detector.
- `15b` maintenance/incident intake, staff/vendor dispatch under approvals, work orders/receipts and follow-up; reuse task record when appropriate.
- `15c` service resilience: queues, per-café fairness, provider timeout recovery, budget/lease/clock checks, missed routine catch-up, backlog visibility, cancellation and kill switch; complete in PR6/7 shared infrastructure rather than duplicate executors.
- `15d` security/prompt-injection, external-content trust boundary, least privilege, role loss and source-access revocation; incident escalation for safety-sensitive situations.

**Prerequisites:** PR6–PR12 and shared notice/attention storage; some tests independent and can open immediately against shared branches.

**Proof:** multi-café overnight simulation, owner offline, staff sick, fridge malfunction report, missing inventory feed, broken supplier browser, revoked OAuth, outdated stock, DST, duplicate webhook/cron, 429/retries, stuck lease, partial delivery, no notifications storm, no false completion; two-tenant isolation; audit/health panel evidence and rollback.

**Do not touch:** second operating system, unsupported physical confirmation, uncontrolled alert sending.

### PR16 — One owner experience: mandate control, work status and accessible chat

**Owner outcome:** Single chat remains the front door. Owner can ask anything, observe proactive findings, inspect why a step is pending, approve once or grant standing permission via verified owner action, see exactly what authority is active, revoke it, check what Supervisor did and why, and understand failures. No separate mandatory dashboard. Mobile-first and browser desktop.

**Slices:**
- `16a` approval/mandate preview+OTP step-up+revoke/pause UI using existing auth; distinguish once vs ongoing and show exact permitted effects/limits. Explicit check that mandate is NOT granted merely by writing "yes" in chat.
- `16b` live run status and interruption/recovery, meaningful source/receipt/result cards in Supervisor; reuse `ai_threads` and `operating_tasks`.
- `16c` connector/file/browser permission prompts, disconnect and evidence, authorized account clarity, privacy controls.
- `16d` mobile and desktop accessibility, responsive UI, preview screenshots, older records compatibility and no involuntary duplicate approval cards.

**Prerequisites:** PR6, PR9–PR12 and owner-approved mandate UX; slices may run in parallel with PR13/14 if shared files have single owner.

**Proof:** real UI Playwright on seeded cafés in 390px mobile + desktop, every approval transition/OTP validity/expiry/replay, mandate reauthorization, revocation mid-flight, run tracking, offline/reconnect, browser back, accessible names/focus, no cross-owner data, no live message or payment; screenshots and traces as CI artifacts. Existing language rule: EN new strings only.

### PR17 — Integrated autonomous café operator and release certification

**Owner outcome:** In a test/pilot café Supervisor continuously observes → prioritizes → plans → requests authorization only when needed → executes within mandate → verifies outcomes → learns and improves prioritization, even if owner is not chatting. This milestone is NOT a feature-demo-only PR; it is the final evidence-producing integration/release gate. Any failing core scenario blocks completion.

**Slices:**
- `17a` E2/Playwright and seeded test environment made mandatory in branch protection (if not already done), with action-safe fake third-party systems and screenshot/trace retention.
- `17b` independent scenario assertions across money, staff, stock, suppliers, finance administration, Events, experiments, brief, owner memory and web research; deterministic numeric and action receipts, no AI-as-sole-grader for facts.
- `17c` multi-day/unattended simulation with cron retries, worker restarts, concurrency, per-café budgets, owner offline, alternate worker access, revocation and escalation; no effects until approvals.
- `17d` preview deployment and permission-safe smoke tests. Separate disposable DB fixtures from real production; preview must never share live credentials or post messages/spend funds.
- `17e` controlled live pilot **only after owner explicitly authorizes deploy/migrations/provider access**. Verify actual café data and business time zones, consent, external effect receipts, rollbacks and support health; record evidence. Finish only when all release gates pass.

**Prerequisites:** PR6–PR16 and required E2 infrastructure; owner-approved production rollout.

**Hard pass criteria:** one agent brain; no scenario-specific hacks; exact screen/chat parity; query accuracy including distinct student discounts/voids/today provisional; reliable own initiative; short-and-long runs; approval-once and valid mandated effects; cross-café isolation; email/file/browser inputs and verified permitted actions; staffed and procurement lifecycles; health/maintenance escalation; notification dedup; owner visibility; recovery after crash; cost limits; repeatability. All tests proven by CI links, captured preview screenshots and pilot logs where permitted. Unsupported real external systems are explicit limitations and must be resolved before claiming the owner's unqualified "complete" target.

## 4. Independent infrastructure track — E2 / previews / branch protection

**E2 is not part of Grok's universal numbered PRs.** Its E1 #369 and B2 #374 prerequisites are merged. Before coding agents interpret a green baseline as full E2E readiness, verify:
- a runnable seeded multi-tenant auth fixture, locally isolated test Postgres;
- Playwright tests of chat, approval, WhatsApp mock, operations, mobile and desktop and screenshot artifacts;
- explicit CI job that **actually executes** tests on qualifying PRs, not a skip disguised as success; recorded job URL;
- Vercel preview deploy with isolated/nonproduction secrets and an explicit policy for smoke tests; preview URL and screenshots in PR body;
- required checks, review protections and up-to-date branch setting verified via GitHub API by the operator, not inferred from docs;
- mock all money-moving, staff/supplier send and other external effects in CI; no production credentials or live supplier portals.
- Production migration/deploy authorization stays separate even when PRs automatically merge.

## 5. Automation dispatcher contract (up to 4 ChatGPT + 2 Claude)

The **orchestrator** is not a second business Supervisor. It is an external engineering dispatcher reading GitHub and this plan. It must never grant product permissions or silently change approved product architecture.

**Queue state per small PR:** `proposed → architecture-approved → ready → assigned → coding → draft-open → CI/review-fixing → ready-to-merge → merged → integrated → released`; `blocked-needs-owner` for secret, legal decision, unapproved architecture or production change. Merged does not imply integrated, deployed or released.

**Selection:** refresh main SHA and PR/CI/review status first; select smallest ready task whose required foundations are on main **or open a stacked PR now** against active dependency branch as allowed by `AGENTS.md`. Reserve an exclusive file-ownership lock (tracked by task/PR) before assignment; if shared file is needed by two tasks, choose foundation owner or stack on owning branch; never have two PR agents mutate it. Assign up to four ChatGPT coding tasks and two Claude coding tasks; choose Claude only for explicitly identified complex domain/UX work, otherwise capacity-based. Reserve slots until final-head checks and review are clean and PR merged or explicitly blocked. Never duplicate dispatch on webhook retries: use task ID + head SHA + worker lease.

**Each agent gets:** current main SHA, AGENTS.md and relevant rules/skills paths, this task's approved architecture sheet, exact owned paths (must first check on main), source-of-truth and excluded paths, dependency base branch, acceptance scenarios, seeded fixtures, E2E/preview requirements, known review comments, existing related PRs, allowed costs/services. An agent must not infer approvals.

**PR lifecycle:** branch from latest main if independent; if dependent PR, from predecessor branch and PR base that branch; open draft early; write plain-words how-it-works/data-flow and evidence in body; execute deterministic unit/integration/DB/Playwright/preview checks as relevant; fix CI/review findings in same PR/chat; keep current main merge status; after prerequisite merges rebase/retarget to main, check migration numbers and ownership; re-run checks and fresh Codex; only then undraft and merge under `AGENTS.md` auto-merge rules. If CI/preview/approval proof unavailable, remain open and report exactly what failed.

**Merge webhook:** verify merged state and SHA (not just PR closed), update task record atomically, unlock owned files, inspect dependent branches, dispatch next available task up to capacity, rerun full final-head proof. Do not blindly trigger based only on PR title, label or a comment saying "done".

**Human decisions:** The owner approves architecture (including field-level source/storage/retention, authority classes, monetary bounds and phone step-up design); production deploy/migrations, actual purchases/messages, and legally sensitive grants remain explicit. These cannot be pre-authorized by automation merely because a PR is green. If the owner chooses, approval may be captured once per *fully specified* common contract; sub-PRs within that contract proceed without repeated architecture discussion. Any contract deviation reopens approval.

**Stop conditions:** secrets missing, real-provider authorization absent, disputed canonical data, unreconciled external effect, PR scope conflict, failure of required CI/visual/DB/preview gate, unresolved Codex P1, security violation or production rollout lacking explicit owner go. Mark precise reason and retain all completed work; unrelated tasks continue.

## 6. Required evidence in every PR body

- **Objective / owner journey** (plain language) and approved architecture sheet version/link.
- **Data flow**: source → authority → saved key and history → tool → permission → effect → receipt → report; identify no-write or no-data cases.
- **Owned/excluded files**, migrations and interactions with current parallel PRs.
- **Dependencies**, previous merged PRs and base/head SHA at merge.
- **Tests**: each acceptance scenario mapped to test file, actually executed command and CI job URL; not just intended tests. SQL on migrated disposable DB. Deterministic numbers/source receipts. Code typecheck, lint, full Vitest and build.
- **Preview**: isolated deploy URL, browser scenario and mobile/desktop screenshot or explained non-UI exemption; no live effects.
- **Review**: Codex P1 resolved, final-head checks green, current main updated; rollback and production consequences noted.
- **Cutover**: single authoritative path, old paths removed or named deletion PR, feature flag/rollback, no duplicate writer.
- **Honest release status**: merged, preview-verified, pilot-verified and production-live are separate states.

## 7. Approval checklist before dispatch

- [ ] Owner accepts that PR13–PR17 are **delivery milestones with small child PRs**, not necessarily five monolithic code PRs.
- [ ] Recover/approve exact PR6–PR12 Grok briefs; don't fabricate missing details.
- [ ] Owner approves one shared effect/mandate contract and Supabase OTP step-up behavior **before PR6 code uses it**.
- [ ] Owner approves field-level designs for newly stored run/routine/mandate/provider/work-order data, including PII, dedup and retention.
- [ ] Owner specifies/caps staffing, spending, channels, personnel authority and high-risk actions.
- [ ] Verify E2 CI/Playwright/preview protections are implemented and required.
- [ ] Verify seeded pilot/test credentials isolated and explicit owner-approved release path.
- [ ] Publish task dependency DAG and exclusive file owners; then coding agents may proceed on approved work independently.

**Explicit non-guarantee:** No system can guarantee 100% success on unknown sites, outages or physical tasks. The contractual completion goal is broad end-to-end capability with reliable proofs, bounded escalation and stated unsupported cases—not invented success. 

## 8. Agent-ready task table (machine queue is authoritative)

**Use alongside [agent operations](universal-supervisor-agent-operations.md)**. This table answers *what can start, what depends on what, and what must be proven*. `PR13`–`PR17` are milestones; suffixed IDs are small code PRs. Every row remains a **proposal** until architecture and exact file ownership are approved. A merge alone does not fulfill a dependency: verify real executed tests and integrated behavior as the runbook explains. `PR1`–`PR5` are merged foundations, but still require capability-level regression audit if upstream code changed.

| Task | Deliverable | Dependencies that must be fixed/proven | Mandatory test categories | Preview |
|---|---|---|---|---|
| `E2` | Required Playwright CI job + isolated seeded preview; verify browser scenarios really run | None | db, e2e, preview, security | Yes |
| `6` | Leased worker resumes one AI loop safely under budgets and authorization | `5` | unit, db, failure | As applicable |
| `7` | Self-managed schedules and proactive priority decisions with due-once triggers | `6` | unit, db, failure | As applicable |
| `8a` | Experiments cutover with parity and single writer | `7` | unit, db, acceptance | As applicable |
| `8b` | Events cutover with parity and single writer | `7` | unit, db, acceptance | As applicable |
| `8c` | Brief cutover with timezone/delivery parity and single writer | `7` | unit, db, acceptance | As applicable |
| `9` | Rolling thread memory with provenance and no cached financial facts | `5` | unit, db, security | As applicable |
| `10` | One effect gateway supporting individual approval and OTP-backed standing authorization | `5` | unit, db, security, e2e | Yes |
| `11` | Secure connector registry and Gmail end-to-end | `10` | unit, security, e2e | Yes |
| `12` | Files/spreadsheets/PDF/browser use with controlled external effects | `6`, `10` | unit, security, e2e | Yes |
| `13a` | Canonical scheduling reads and labor parity | `6`, `7` | unit, db, parity | As applicable |
| `13b` | Mandate-controlled schedule publishing and messaging receipts | `13a`, `10`, `11` | unit, db, e2e, receipt | Yes |
| `13c` | Staff response, absences and shift coverage lifecycle | `13b` | unit, db, e2e | Yes |
| `13d` | Recruitment, leave, onboarding and human decision gates | `13a`, `10`, `11` | unit, security, e2e | Yes |
| `14a` | Stock/recipe/consumption sources and uncertainty | `6`, `9` | unit, db, parity | As applicable |
| `14b` | Vendor quotes and purchase order lifecycle | `14a`, `10` | unit, db, security | As applicable |
| `14c` | Vendor communications/order execution and receipts | `14b`, `11`, `12` | unit, e2e, receipt | Yes |
| `14d` | Deliveries and invoice reconciliation | `14c` | unit, db, e2e | Yes |
| `14e` | Cash flow, bills and payable preparation with payment boundary | `14d`, `10` | unit, db, security | As applicable |
| `15a` | Prioritization and alert escalation using one inbox | `7`, `9` | unit, db, failure | As applicable |
| `15b` | Maintenance and equipment coordination | `15a`, `10`, `11` | unit, e2e, receipt | Yes |
| `15c` | System outages, concurrency, queue fairness and catch-up | `6`, `7`, `10` | unit, db, failure | As applicable |
| `15d` | Prompt-injection and provider/cafe access revocation | `10`, `11`, `12` | unit, security, e2e | Yes |
| `16a` | Owner approval and OTP mandate grant/revoke UI | `10` | e2e, security, preview | Yes |
| `16b` | Chat progress, retries and receipts | `6`, `9` | e2e, preview | Yes |
| `16c` | Account, connector and browser permission controls | `11`, `12` | e2e, security, preview | Yes |
| `16d` | Responsive accessible final owner UX | `16a`, `16b`, `16c` | e2e, visual, preview | Yes |
| `17a` | Required E2E gate evidence and branch protection | `E2`, `16d` | e2e, ci, security | Yes |
| `17b` | Cross-domain deterministic acceptance suite | `8a`, `8b`, `8c`, `13c`, `13d`, `14e`, `15b`, `16d` | db, e2e, receipt, parity | Yes |
| `17c` | Multi-day autonomous failure simulation | `17b`, `15c`, `15d` | failure, db, e2e | Yes |
| `17d` | Safe preview smoke and artifacts | `17c` | preview, e2e, security | Yes |
| `17e` | Owner-authorized live pilot and certified release | `17d` | pilot, release | As applicable |

### Candidate parallel wave (not yet dispatched)

| Slot | Proposed work | Branch/base | What must be checked before coding |
|---|---|---|---|
| ChatGPT 1 | E2 required Playwright CI and protected preview | latest `main` | Existing E1/B2 #369/#374 actual integrated acceptance, E2 design, CI file lock |
| ChatGPT 2 | PR6 durable worker | latest `main` | PR5 #378 actual integrated acceptance, authorization interface design and worker file lock |
| ChatGPT 3 | PR9 rolling memory | latest `main` | Owner-facts #362 + chat history state, no overlap with PR6/10, memory data design |
| ChatGPT 4 | PR10 effect gateway/mandates | latest `main` | Existing approval/OTP contract, owner-approved standing mandate design, no overlap with PR6/9 |
| Claude 1 | PR7 stacked draft, **if** its architecture/ownership is approved | PR6 live branch; PR base = PR6 branch | PR6 API stable; **do not merge** until PR6 merged and proven; no shared file edits |
| Claude 2 | PR16a stacked draft, **if** approved | PR10 live branch; PR base = PR10 branch | PR10 exact OTP/mandate interface, no shared file edits, browser test plan |

The table is a **conditional scheduling illustration**, not a claim that these six tasks are already approved, have no file collisions, or have working preview accounts. If PR7/16a cannot safely stack, the dispatcher must select other independent work or leave a slot free. Do not open an implementation PR solely to fill capacity.

### Mandatory pre-dispatch questions

1. Is there an **owner-approved architecture contract** for this exact task and all new stored records/effects? If not, the dispatcher produces the short design sheet and waits for approval; it never substitutes model confidence for permission.
2. Did each predecessor **actually deliver** its promised owner journey? Inspect the diff, final head jobs, test cases and integration, not its merged label or checkbox. If incomplete, add a repair task and block only dependent work.
3. Are the task's **exact file paths, shared interface and migration number** reserved, with no other active owner? If no, resolve ownership or stack on the owning branch before dispatch.
4. Does every listed **mandatory acceptance test run** on the exact head, including local migrated DB and Playwright/preview when applicable, rather than skip? If not, do not merge.
5. Was the final head independently Codex-reviewed and the actual merge SHA confirmed? If not, remain in same PR/chat and fix.
6. Is the milestone's post-merge integrated proof green on current `main`? If not, do not unlock dependent merges. If production release is needed, obtain separate owner authorization and verify live evidence before marking it released.

**Minimal prompt to copy-paste** is in [the agent runbook](universal-supervisor-agent-operations.md#4-copy-paste-coding-agent-prompt-short-substitute-task_id); replace only `TASK_ID`. The dispatcher prompt in section 3 selects the task and reserves paths. Every coding chat must read the repository's `AGENTS.md`, `PROGRESS.md` and applicable `.claude/skills/*/SKILL.md`, not rely on a skimming summary.
