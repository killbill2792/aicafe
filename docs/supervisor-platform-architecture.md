# AI CAFE — Universal Supervisor Platform Architecture

**Status:** Proposed architecture contract only; review required before implementation. **No runtime behavior, migrations, feature flags, deployments or permissions change in this PR.**  
**Repository baseline inspected:** killbill2792/aicafe, main at commit 2d69b49f844fd9d91815fb39ab4d8280b251435c (2026-10-14). PR #72 remains separate and open.  
**Owner-facing product:** ONE Supervisor conversation, ONE operating-task inbox; Olivia (scheduling), Alex (pricing), Maya (supplies/waste), Leo (money/operations) are domain specialists, not separate owner chats.  
**Review packet reconciliation (2026-10-14):** The attached *AI CAFE — Universal AI Supervisor Architecture: Independent Architecture Review Packet* dated October 14, 2026 has now been read in full and compared with this contract (§15). It is an RFC and a questionnaire requesting an independent A–H review, **not a completed outside reviewer verdict**. Compatible proposals are integrated below; open choices and evidence gaps remain stated. Earlier absence-of-attachment statements are superseded.

## 1. Product decision and non-negotiable boundaries

The Supervisor is the stable owner interaction, goal decomposition, authorization and verification surface. Specialists own domain capabilities, source adapters, domain decisions and deterministic calculation calls. Registering the next specialist should require a new capability/metric module and optional presentation, **not** adding new intent branches to a central Supervisor router, tool schema, planner, approval gate or event loop.

The owner should be able to ask about every **supported canonical business metric** with explicit provenance, freshness, units and data-quality status. “Can access every metric” means every registered **authorized and supported** metric can be discovered, resolved and queried through typed server-side interfaces; it does **not** mean bypassing RLS, reading arbitrary tables, exposing other tenants, declaring nonexistent fields supported or making the model a SQL interpreter. A supported metric can validly return unavailable.

Keep the deterministic business architecture in docs/09-ai-native-operating-system.md:

1. Authorized operational records and imported evidence.
2. Pure, tested calculations in lib/calc/.
3. Source-aware state/metric projections.
4. Signals and explicit decisions.
5. Specialist capabilities and shared orchestration.
6. Verified, localized owner explanations.
7. Separately authorized owner actions and durable outcome tracking.

**Hard invariants:** money is integer cents; no invented sales, wages, worker acceptance, inventory, notifications or integrations; actual versus estimated never implicit; zero is distinct from absent; never count a planned shift as worked attendance; POS is read-only; no duplicated labor/profit/pricing calculations outside lib/calc/; no second task inbox; no cross-tenant access; no arbitrary autonomous writes; owner-written AI Team rules are guidance, **not** execution consent. Preserve existing financial history, Staff records, tenant RLS, private conversations, auth flow and owner-visible EN/ES/AR behavior.

### Intended architecture (logical modules, not mandatory new services)

~~~text
Owner → existing Supervisor thread / voice-as-editable-text / action cards
      → authenticated OwnerContext (owner + selected café + roles + locale + timezone)
      → goal decomposition & capability discovery (bounded model or safe fallback)
      → typed, authorized, budgeted multi-domain plan
      → capability dispatcher ─┬─ metric catalog → canonical server readers → lib/calc/
                              ├─ Olivia scheduling adapters → lib/scheduling/ → lib/calc/scheduling/
                              ├─ Alex pricing adapters → canonical pricing engine in lib/calc/
                              ├─ Maya supply/evidence adapters → existing audited records
                              └─ Leo money/operations adapters → canonical financial readers
      → verified result/evidence merger → existing grounded reply writer → owner
                              └─ inert proposal bound to source + context + policy revisions
                                   → typed approve transition (server-validated actor/revision)
                                   → one-time proposal consumption + effect-specific policy recheck
                                   → durable workflow + domain executor + audit/outbox
                                   → actual domain effect + reread → verified completion
Events / scheduled evaluator → same capability contracts → existing operating_tasks
                             → opt-in, rate-limited owner notification delivery
~~~

The diagram names conceptual seams. Start **in-process, in the existing Next.js app**. Do not invent agent microservices, agent-to-agent free-form chats, generalized autonomous loops or separate per-agent databases.

## 2. Verified current architecture and concrete limits

This table distinguishes observed repository behavior from desired future behavior; production deployment state was **not** verified.

| Existing paths / contracts | What exists on main | Limit / safe extension |
| --- | --- | --- |
| lib/ai/conversations/supervisorRequest.mjs, supervisorFunctions.mjs, requestScope.ts | One semantic scope taxonomy, hard-coded goal domains/function schemas and bounded Responses API requests; can seek multiple read goals | Each new intent/metric currently tends to change shared enumerations, prompts, tool schemas or mapping. Replace incrementally with capability-provided descriptors while retaining legacy semantics |
| lib/ai/conversations/toolRegistry.server.ts | Strict zod tool argument validation, per-tool read implementations, source refs, status/coverage and safe task projections | A central read switch / finite schemas, **not** a universal extension registry; avoid injecting arbitrary model-created tool names |
| lib/ai/conversations/runSupervisorTurn.server.ts | Read-only multi-tool flow, grounding and goal-completeness checks, limited to MAX_ROUNDS=3 and MAX_TOOLS=5; final model chooses only server-issued fact/task/insight IDs | Existing multi-read composition is a useful baseline, **not** durable multi-specialist workflow execution; budget exhaustion must become explicit per-goal unavailable/partial, never silent omission |
| lib/ai/conversations/contracts.ts, replyValidation.ts, replyWriter.server.ts | GroundedSupervisorReply with verified/estimated/partial/unavailable/insufficient_evidence, exact evidence references, restricted metric/task blocks and idempotent reply ID from owner message | Extend via versioned adapters and separately trusted action cards; never loosen current validation, model numeric claims or links |
| lib/ai/conversations/auth.server.ts, service.ts, app/api/ai/threads/* | Owner + active café selected by trusted server; private owner-scoped threads; same-origin validation, immutable messages, retry keys | No user-supplied business/owner identity and no direct model database access; preserve co-owner conversation privacy |
| lib/ai/cafeTools.server.ts, lib/ai/tools.ts, lib/operating/cafeState.ts | Authenticated business-scoped allowlisted read facade and CafeState/KnownSlice projections, no raw Supabase client exposed to model | Valuable metric adapters exist, but no discoverable metric catalog with stable dimension/period/granularity/lineage contract |
| lib/ai/conversations/domainProjections.ts, lib/ai/supervisorReads.server.ts, lib/ai/supervisorFacts.server.ts | Staff now/schedule, break-even and period-sensitive sales/menu/bills/expenses evidence; recurring staff schedule is **not** accepted shift/actual attendance | Preserve menu versus purchased-item and day versus hour distinctions, current schedule truncation, timecard provenance and historical completeness checks |
| lib/calc/*, docs/05-calculations.md | Pure financial, pricing, labor and cost functions, fixtures and tests | Sole authority for deterministic cents/math. Metric adapters supply inputs/outputs, not duplicate formulas |
| lib/ai/policies/contracts.ts, docs/supervisor-phase5-owner-rules.md | Read allowlist and default deny for all generic business writes; versioned owner-approved natural language team rules with audit | A rule approval **never** authorizes a schedule publish, price change, purchase, POS write or staff contact |
| lib/operating/tasks.ts, reconcileTasks.ts, lib/data/operatingTasks.ts | Persisted Needs You/Handled/Watching task system, agent attribution (Alex/Olivia/Maya/Leo), owner responses and reconciliation | Not a generic durable executor; existing page reconciliation is not a reliable background scheduler. Extend this inbox instead of creating another |
| lib/operating/events.ts, docs/09-ai-native-operating-system.md | In-process publish/subscribe event abstraction, typed operating signals and decisions | In-process notifications are not a durable job queue or at-least-once post-commit delivery |
| lib/ai/conversations/usage.server.ts | Persistent token/call counts and nullable model-price cost estimates | Basis for shared limits, not evidence that every domain has latency/tool/scan limits |
| app/api/cron/team-alerts/route.ts, lib/ai/notifications/whatsapp.server.ts | Opted-in, provider-dependent owner WhatsApp category alert; pre-send reservation / deduped delivery attempt, currently UTC-day behavior | Not a universal event evaluator, business-local quiet-hour scheduler or employee messaging service |
| docs/supervisor-phase6-voice-attachments.md | Editable voice transcription and private PDF/image/text storage, unanalysed | Upload does **not** prove extracted employee availability, inventory counts or sales; currently no trusted CSV intake through Supervisor |
| docs/supervisor-phase8-supplier-intelligence.md | Owner-reported supplier quotations and optional unverified public search snippets | Supplier quote != inventory, verified stock, invoice payment or supplier order |
| docs/scheduling-architecture.md and **open PR #72** | Scheduling design and a separate proposed, default-off manual foundation for availability/preferences/qualifications/coverage/compensation provenance | Not a published roster, feasibility optimizer, worker identity verification, staffing cost certainty or Supervisor action interface. Do not modify #72 here |

**Verification scope:** repository code/docs and PR metadata, not production DB migrations, live Toast/Square credentials, WhatsApp provider activation, import completeness, real worker communications or production end-to-end results. Existing statements in older architecture docs can describe planned or historical phases; current code and released capabilities must be checked at integration time.

## 3. Stable module boundaries and ownership

Proposed logical layout (names are recommendations; do not create empty scaffolding during this PR):

| Owner | Contract / proposed location | Owns | Must not own |
| --- | --- | --- | --- |
| Platform | lib/ai/supervisor/platform/{contracts,registry,planner,dispatcher,verifier,policy,budgets}.ts | Registries, typed protocol, auth context, dependency plan, policy, budget, verified result aggregation, one reply surface | Any pricing, payroll, labor-optimization, inventory or profit formula |
| Metrics platform | lib/metrics/{catalog,query,quality,precedence}.ts | Discovery, authorization, period/dimension/granularity validation, read lifecycle, quality/lineage normalization | Raw SQL from model or a new parallel finance ledger |
| Specialist adapter | lib/supervisor/capabilities/{olivia,alex,maya,leo}/* (or local domain registration exports) | Capability metadata, schemas, source adapters, previews and effect handler delegation | Direct generic service-role SQL or duplicated approval engine |
| Domain services | Existing lib/scheduling/, pricing/menu, supplier and finance/data services | Versioned domain reads/commands, domain transaction invariants and persistence | New global Supervisor intents or provider-specific prompt orchestration |
| Calculation | Existing lib/calc/; scheduling in lib/calc/scheduling/ | All deterministic feasibility, forecasting/what-if, pricing, cost and profit math with independent tests | Model prompting, DB writes, tenant authorization |
| Execution and events | Small audited domain command adapter + shared durable workflow state; existing operating_tasks and notification transport | Transactional effects, dedupe, reconciliation and verified outcomes | Unbounded background agents, unreviewed third-party sends |
| Presentation | Existing Supervisor component/chat and Staff/Operations screens | Grounded text/cards with appropriate localized follow-ups | Financial math or authority decisions |

The platform controls **who may ask, plan, approve and observe**; each specialist controls **what a bounded domain operation means**. Domain functions remain callable without an LLM and must be independently testable. Register data/commands as module exports at build time; use a server-owned, reviewed manifest, not plugins dynamically supplied by owners or prompts. Version each public capability and result contract; reject unknown major versions.

## 4. Universal typed capability registry

Define a typed, server-owned registry whose descriptors are safe to expose as discoverable metadata, while implementations remain server-only. Example of a design target, **not code in this PR**:

~~~ts
type CapabilityId = string;            // e.g. "olivia.schedule.preview.v1"
type AgentId = "olivia" | "alex" | "maya" | "leo" | (string & {});
type Mode = "read" | "simulate" | "propose" | "approve" | "commit" | "evaluate";
type ResultStatus =
  | "verified" | "estimated" | "partial" | "unavailable"
  | "insufficient_evidence" | "requires_approval"
  | "conflict" | "failed";
type AuthorizedContext = {
  businessId: string; ownerUserId: string; role: "owner";
  timezone: string; locale: "en" | "es" | "ar";
  requestId: string; traceId: string;
}; // trusted server construction ONLY

type CapabilityDescriptor<I, O> = {
  id: CapabilityId; version: 1; agent: AgentId;
  descriptionKey: string; inputSchema: ZodSchema<I>; outputSchema: ZodSchema<O>;
  mode: Mode;
  discoverableGoals: readonly string[]; producesMetrics: readonly string[];
  requiresMetrics: readonly string[]; dependsOn?: readonly CapabilityId[];
  requiredRole: "owner"; sensitivity: "normal" | "staff" | "financial";
  approvalPolicyKey: string | null; // per-action server-defined policy
  budgetClass: "cheap_read" | "bounded_read" | "planning" | "external";
  preconditions: readonly string[];
  enabledFor: (ctx: AuthorizedContext) => Promise<boolean>;
  execute: (ctx: AuthorizedContext, input: I) => Promise<VerifiedCapabilityResult<O>>;
};
~~~

**Non-effectful operation invariant:** `read` returns canonical facts and `simulate` runs a **transient, read-only, deterministic what-if** using pinned source inputs and `lib/calc/`. Neither creates a scheduling draft, proposed price, approval request, task, outside message or business-domain write. Protected usage/audit telemetry is permitted but cannot imply domain mutation. Simulations state baseline, changed assumptions, feasibility/limitations and source revision; they return `proposal: null`. `propose` is a **separate explicit transition** that may persist an inert versioned draft after the owner requests it. **`approve` is a first-class typed, server-only transition** that validates an immutable proposal and records a scoped approval artifact; it does **not** invoke a domain write. **`commit` is a separate policy-gated executable capability** that must consume that approval exactly once (or use a specifically validated standing grant, if a later reviewed effect supports delegation). `evaluate` is a bounded evidence check, and any task persistence goes through its separately authorized reconciler. Dispatcher and acceptance tests must prove these distinctions even if the model requests a more powerful action.

The executable contract must separate read, simulate, propose, **approve** and commit handler types. An approval handler **accepts only a server-issued proposal ID/revision and authenticated actor decision**, produces an auditable typed ApprovalTransitionResult and never calls domain effect handlers; a commit handler accepts only a verified approved record/effect identity from the server, **never a model-issued approval flag**. Approval is a shared, registry-governed server-side action transition, not an Olivia-specific supervisor intent or a variant of `propose`/`commit`. The `mode: "approve"` descriptor has a registered authorization policy, typed input/output and a server-only transition handler; it must not be callable as a read/simulation or unvalidated free-form LLM tool. Production code should use zod generics/inferred types (the illustration omits implementation-specific TS imports). An effectful capability also declares a separately implemented **preview**, deterministic **effect type**, approval requirements, idempotency class, compensation/rollback semantics, and postcondition verifier; no effectful operation is admitted without them.

Registry startup checks: unique ID+major version; valid schema bounds; no orphan dependencies, cycles or conflicting owners of the same canonical effect; registered metric names exist; policy key exists and is default-deny; budget classification is present; effect handler is allowlisted; no changed legacy tool name without explicit compatibility adapter. Disabled or unimplemented descriptors may be discoverable **as unavailable**, never callable as if active. Registrations return structured metadata, **not** arbitrary owner-controlled function code.

Example future registration:

| Domain owner | Example capability IDs | Inputs from | Result/action semantics |
| --- | --- | --- | --- |
| Olivia | olivia.availability.read.v1; olivia.schedule.preview.v1; later olivia.schedule.propose.v1, olivia.schedule.approve.v1, olivia.schedule.publish.v1 | Staff canonicals + #72 availability/coverage, location, law/time and cost metadata | Feasibility/gaps; separate immutable proposal, typed approval, one-time consumed commit; publish is not worker acceptance |
| Alex | alex.pricing.review.v1; later alex.pricing.propose.v1 | Canonical pricing engine, recipe costs, product/menu and reliable sales | Review/KEEP/recommendation with evidence; no price write/POS mutation by default |
| Maya | maya.supplies.quote_compare.v1; later maya.inventory.read.v1 **only if integration exists** | Owner-reported quotes, recipe/ingredient input; optional explicitly supported inventory provider | Unit-matched quote comparison; inventory unavailable without actual inventory data |
| Leo | leo.money.profit.v1; leo.money.costs.v1 | Canonical period profitability, bills, labor and fee data | Verified/estimated/partial profit or cost explanation; no invented bank feed/payment action |

**Registration proof:** A new capability/goal from an existing or fifth specialist changes only its domain registry module, optional metric definitions, localization/presentation and its own tests. Platform discovery/planning/authorization/result aggregation code remains unchanged **for an existing contract version**. An explicit protocol-breaking contract version upgrade is permitted through a separately reviewed platform PR; do not promise literally zero future platform work.

## 5. Universal business metric catalog and secure access

### 5.0 Complete canonical business surface inventory — required implementation gate

**“Universal” requires full auditable coverage, not the illustrative starter metric list in §5.2.** P1 must inventory every **currently supported canonical business metric, typed entity/record reader and analytical capability**, including manual-only paths and explicit unsupported states. Review every source of public business facts: `lib/ai/tools.ts` / `cafeTools.server.ts`; `CafeState`/snapshot slices; `lib/ai/conversations/toolRegistry.server.ts`; Menu, Staff, Money, Bills, Operations, pricing viewmodels; canonical exposed `lib/calc/` functionality; suppliers and external connectors; and `operating_tasks`, decisions, signals and owner rules. This is **not** a mandate to make every private database column queryable.

The required checked-in machine-readable inventory entry has `id`, `kind: metric | entity_read | analysis | restricted | unsupported`, domain owner, canonical reader/source path, public business meaning and purpose, strict schema, permitted role/sensitivity, supported period/dimension/granularity/unit (if a metric), source/preference policy, integration prerequisites, freshness/completeness and registered capability/handler or explicit unavailable reason. Every supported public business fact is mapped to an authorized reader; sensitive/restricted items record a justified no-exposure or aggregate-only contract; unsupported items must return a truthful reason, never zero. Ownership is not assigned by one generic Supervisor “data” tool.

**Initial evidence-backed inventory map (to be made exhaustive against actual exported surfaces in P1):**

| Domain area | Current canonical support / records | Required outcome |
| --- | --- | --- |
| Business and locations | Authenticated active café, business timezone, configured locations | Bounded scoped business/location **entity reads**; no other-café membership exposure |
| Menu/catalog/recipes | Active/all products, product and recipe facts, ingredients, prices and cost inputs | Typed product/recipe/ingredient entities; cost/count metrics use supported dimensions and exact units |
| Sales | Net sales, orders, item units, distinct purchased products, covered date trends/item facts | Registered sales metrics and bounded order/item records where actually supported; **no hourly inference from daily records** |
| Profit/financial | Owner profit, operating margin, total and component business costs, break-even and period comparisons | Metric/analysis access backed by canonical `lib/calc/`, quality and matching periods |
| Recurring bills and spending | Monthly recurring bill obligation, recorded actual expense lines/summaries | Separate bill/expense entity reads and money metrics; bills not synonymous with all actual costs |
| Employees and labor | Staff roster, current staffing, attendance/timecards, legacy recurring assignments, labor cost/day | Staff-sensitive entity reads, shift/hour/cost metrics, provenance marking **observed vs predicted** |
| Pricing | Canonical pricing review/keep/new/blocked results and evaluated product recommendations | Registered price analysis, count and cost metrics; no applied change assumed |
| AI operations | Persisted owner tasks, statuses, signals, decision history, active approved team rules | Bounded typed task/signal/decision/rule record reads; counts and lifecycle not mistaken for operational attendance |
| Supplier evidence | Owner-reported supplier quotes and unit-comparable comparisons | Typed quotation entity read and deterministic comparison; snippets remain unverified |
| Olivia planning | Current legacy schedules; #72 proposed availability/skills/coverage/wage provenance | Existing Staff read supported; #72-specific future capabilities **unavailable until independently shipped** |
| Inventory, waste and ordering | No verified general inventory integration or ordering flow established | Explicit unsupported/read unavailable; supplier quotes are **not stock on hand** |
| Bank/cashflow | No connected bank feed established by this review | Explicit unsupported unless a consented, implemented canonical source is verified |
| Notifications and files | Opt-in owner delivery attempts, private unanalysed chat attachments | Audit/status metadata only when authorized; extraction, worker delivery/acceptance unsupported |

**Automated coverage tests are compulsory, bidirectional and CI-blocking.** Maintain a source-surface manifest checked against independently enumerated exported public readers, model-visible Supervisor readers, canonical analytics/viewmodels and domain capability exports. CI must fail when a supported field/metric/entity/analysis/export is introduced, renamed or removed without a registered authorized path or a reviewed restricted/unsupported mapping. Reverse tests fail stale catalog entries, dangling handler IDs, missing schemas/policies and “available” capabilities with no real implementation. Check declared granularity/dimensions/periods and no raw SQL/automatic database introspection. Test discover → role/tenant authorization → bounded read → evidence validation → denial/unavailable with synthetic no-POS, incomplete-sales, cross-café and sensitive-staff fixtures. **The P1 comprehensive inventory and tests are future work; this documentation does not claim they have run.**

### 5.1 Catalog contract

Each metric is a first-class server-owned definition; metric IDs are stable and versioned independently of display names. Exact fields:

~~~ts
type MetricDefinition = {
  id: string; version: 1;
  owner: "money" | "sales" | "staff" | "pricing" | "supplies" | string;
  localizedLabelKey: string; descriptionKey: string;
  valueKind: "money_cents" | "integer" | "decimal_ratio" | "duration_minutes" | "boolean" | "series";
  unit: "USD_cents" | "count" | "ratio" | "minutes" | "unit_count" | string;
  allowedDimensions: readonly string[]; // e.g. location, item, channel, employee
  allowedGranularities: readonly ("instant" | "hour" | "day" | "week" | "month")[];
  supportedPeriods: "instant" | "bounded_date_range" | "all_time";
  temporalBasis: "business_local" | "location_local" | "utc_instant";
  availabilityRequires: readonly string[]; // provenance, coverage or provider prerequisites
  sensitivity: "normal" | "staff" | "financial";
  accessPolicy: string; sourcePurpose: string; canonicalReader: string;
  sourceSelectionPolicy: string; maxRangeDays: number | null;
  expectedFreshnessSeconds: number | null;
  aggregationPolicy: "from_canonical_calc" | "sum_validated_parts" | "not_aggregatable";
};
type MetricQuery = {
  metricId: string; period?: {from: string; to: string};
  granularity: "instant" | "hour" | "day" | "week" | "month";
  dimensions: Record<string, string[]>; // validated against catalog, entity authorization
  filters: Record<string, unknown>;     // metric-specific bounded schema
  purpose: string; // e.g. payroll_actual, schedule_forecast, price_review
};
type MetricResult = {
  metricId: string; definitionVersion: 1; query: MetricQuery;
  status: ResultStatus;
  value: number | boolean | null | readonly unknown[]; // null NEVER means zero
  unit: string; actuality: "actual" | "estimated" | "forecast" | "planned" | "unknown";
  completeness: {state:"complete"|"partial"|"unknown"; observed:number|null; expected:number|null;
    missingKeys: string[]; truncated:boolean};
  freshness: {asOf:string|null; capturedAt:string|null; stale:boolean|null};
  provenance: readonly SourceRef[]; assumptions: readonly string[];
  conflicts: readonly SourceConflict[]; unavailableReason: string|null;
};
~~~

Use **explicit result variants** in production (e.g. a discriminated union requiring null for unavailable and requiring a valid typed value/unit for available) rather than interpreting this abbreviated sample's nullable value at the UI. Currency and every money total use safe integer cents. Ratios cannot be averaged naively across groups or time; recompute from canonical numerators and denominators in lib/calc/. Do not sum overlapping sources or treat a calculated derived metric as a raw imported fact. Timezone, DST, inclusive café dates, source effective range and location scope are part of the query fingerprint.

Catalog discovery is two operations: **list permitted definitions** (small metadata only) and **query selected metric IDs with bounded arguments**. The server builds the catalog from reviewed modules; owner can learn what is available while missing integrations return explicit unavailable. No schema exploration, free-form table names, REST endpoint composition or SQL issued by an LLM. Apply authenticated café selection, source RLS, row/column sensitivity, bounded pagination and server-enforced dimension filters **before** data is exposed. Where staff detail is sensitive, provide only an authorized aggregate unless a separate named-person read is justified by role and purpose.

### 5.2 Canonical starter catalog / ownership

The first catalog is an **adapter over existing functions**, not a new set of financial equations.

| Metric family / illustrative IDs | Canonical source & calculation | Evidence / caveat |
| --- | --- | --- |
| money.owner_profit_cents; money.total_business_costs_cents | Existing getProfitability / getBusinessCostSummary and lib/calc/profit.ts | Same period and modeled components; complete net sales/ingredients/labor/fees/bills needed for a verified total |
| money.recurring_monthly_bills_cents; money.recorded_spending_cents | Existing monthly bills/recorded-expense readers and lib/calc/runningCosts.ts | Never substitute recurring bill obligation for all spending or all operating costs |
| sales.net_sales_cents; sales.orders_count; sales.item_units | getSalesTrend, verified order facts, period item sales and existing item-sales coverage | Daily totals do not imply hourly granularity; distinct menu products != distinct actually purchased products |
| staff.loaded_labor_cost_cents; staff.actual_minutes | Existing labor, timecards, provenance-aware Staff readers and lib/calc/staff.ts | Actual attendance distinct from owner_schedule prediction; partial days, wages and tax assumptions must be labeled |
| staff.scheduled_coverage; staff.proposed_labor_cost_cents (future) | Olivia versioned planner in lib/calc/scheduling/ after reviewed stages | Planned/forecast, not worked labor; absent wage or known eligible zero requires provenance; no calculation before supporting implementation |
| menu.active_products; pricing.review_count | Existing menu control center / canonical pricing results | Verification of an empty review set requires complete evaluated coverage; missing prices not "all clear" |
| supplies.supplier_quoted_unit_cost_cents | Reviewed quotation records + lib/calc/supplierQuotes.ts | Owner-reported quote is not invoice/purchase/verified supplier stock |
| inventory.stock_on_hand (future only) | No current canonical inventory integration | Return unavailable; registering a name never manufactures inventory |

Business dimensions are **allowed only if canonical readers can faithfully produce them**. For example, no hourly sales if only daily rollups; no item-level totals without covered order lines; no employee cost split if cached predicted/actual overlap cannot be reconciled. Derived ratios and period comparisons require matched source coverage, identical business/location boundaries and the shared pure engine; otherwise return partial/unavailable, not a convenient estimate disguised as actual.

### 5.2a Metric queries are not typed domain record reads

A **metric query** returns typed measures/series with unit, period, time zone, dimensionality, actual/estimated status and safe aggregation. An **entity read** returns a strictly selected, bounded projection of existing business records/relationships/revisions: people, recipes, bills, quotes, tasks, source details or plans. A registered **analysis** evaluates source-specific scenarios or recommendations using those readers and canonical pure functions. The shared registry discovers **three distinct typed access contracts**, not an unrestricted “ask the database” query:

~~~ts
type EntityReadDefinition<TInput,TOutput> = {
  id: string; version: 1; entityType: string; domainOwner: string;
  inputSchema: ZodSchema<TInput>; outputSchema: ZodSchema<TOutput>;
  policyKey: string; sensitivity: "normal"|"staff"|"financial";
  allowedFields: readonly string[]; allowedRelations: readonly string[];
  maxRows: number; maxDepth: number; purpose: string; handlerId: string;
};
type EntityReadResult<T> = {
  status: "verified"|"partial"|"unavailable"|"insufficient_evidence";
  records: readonly T[]; truncated: boolean; nextCursor: string|null;
  evidence: readonly SourceRef[]; missingInputs: readonly string[];
};
~~~

Server-only handlers bind café/user/location/purpose, validate filters and resource caps, apply RLS and allowlist fields and relationships. Never expose a generic SQL editor, unrestricted SELECT, arbitrary joins, free-form table names, schema exploration or all-employees/all-records dumping to the model. Record permissions do **not** follow automatically from metric read permission; e.g., labor total does not authorize reading every staff wage. Unknown/restricted record types are explicit in the same coverage manifest.

### 5.3 Source precedence is by purpose, not by provider rank

**Purpose-specific authority matrix (proposal to implement with regression tests):**

| Purpose | Primary | Secondary / conditional | Never silently substitute |
| --- | --- | --- | --- |
| Observed sale/order | Validated canonical POS transactions, deduplicated provider identity | Explicitly confirmed owner import for its covered period | Menu listing, rollup from another period, incomplete daily ingest |
| Actual staff attendance/payroll | Verified observed timecard with source/period precedence in existing canonical pipeline | Explicitly owner-confirmed manual actual time, subject to reconciliation | Draft/published shifts, external planned Toast shift, predicted timecard as actual |
| Future scheduling commitment | Current owner-approved/published local plan revision after explicit opt-in | Reviewed external schedule as a **discrepancy/advisory input** | AI proposal or worker-reported intent as published acceptance |
| Worker availability | Verified worker submission (when available) or owner-confirmed reported availability with attribution, date and revision | Tentative report only as labeled unconfirmed | Recurring assigned shift as availability |
| Wage/cash cost | Canonical recorded positive paid wage/contract and effective-period provenance | Explicit permitted zero-cost attestation only if consistent; salary conversion with verified denominator | Unknown/null as zero, stale zero attestation after positive wage update |
| Menu selling price | Canonical product price/revision | Reviewed snapshot or historical POS price where relevant | AI recommended price as applied |
| Ingredient price | Canonical dated verified/entered ingredient costs with source status | Owner quote as a separately labeled scenario | Search snippet or unit-incomparable quote as realized cost |
| Supplier inventory | Supported authorized inventory system after integration | Owner-confirmed stock count if explicitly modeled | Supplier quote, menu item existence or recipe quantity |
| Banking/payments | Only consented, supported provider records if actually connected | Owner-recorded entry labeled with status | Assuming QuickBooks/Toast/CSV equals a live bank connection |

Implement selection as a **registered policy per metric/purpose and temporal window**. Resolve duplicate identities, overlapping dates and measurement definitions before aggregation. Source conflicts retain both references and a conflict code; disagreements affecting material accuracy block verified answers/actions until reconciliation. A higher-priority source with missing coverage is not magically complete; lower-priority supporting evidence may fill a gap only where the policy explicitly permits it and disjointness can be proven. All source merges must preserve stable evidence identities, source status, capture/effective times, revision and the authority decision. No global "Toast beats owner" or "newest wins" switch.

### 5.4 Unknown, zero, freshness and quality lattice

- **Verified zero** requires a complete, applicable evidence window and a canonical explicit result of zero (e.g. zero reviewed price changes among **all** eligible products).
- **Unknown/unavailable** arises from missing provider, absent data, unsupported dimension or required granular evidence, denied scope, inconsistent wage, pending salary conversion, incomplete period or failed trusted reader. Never format null as $0 / 0 workers.
- **Partial** yields only observed subtotals, known numerator/denominator coverage and missing components; it cannot claim complete café profit or safe scheduling publication.
- **Estimated/forecast/planned** are distinct time/status axes. A source can be actual but stale or actual but partial. Never flatten these to "verified" by picking the highest confidence input.
- **Freshness** is metric/source-specific. Unknown refresh timestamp is not fresh; stale data can support a historical statement but not an unqualified "right now" action.
- Empty provider data, temporary provider outage and access denied produce different internal reason codes, owner-safe localized outcomes, and the same no-invention policy.

## 6. Stable Supervisor orchestration and multi-domain planning

### 6.0 Shared, versioned business context (no free-form model memory)

Use a server-composed, versioned **`BusinessContext.v1`** to supply the same vetted input references to any participating specialist. It is a permission-filtered *view* of existing canonical data, not a second authoritative staff/preferences database and not an unconstrained LLM memory store.

~~~ts
type BusinessContextV1 = {
  version: 1;
  scope: {businessId:string; ownerUserId:string; role:"owner";
    locale:"en"|"es"|"ar"; timezone:string; locationIds:readonly string[]};
  snapshot: {asOf:string; fingerprint:string; sourceRefs:readonly SourceRef[]};
  contextFingerprint: string; // separate from snapshot.fingerprint; server-canonical hash
  contextRevisionRefs: readonly {kind:"preference"|"objective"|"guidance"|"workflow";
    id:string; revision:number; scope:string; state:"present"|"absent"|"revoked"}[];
  preferences: readonly ConfirmedPreference[]; // validated per registered key/version
  objectives: readonly {id:string; revision:number; target:string; unit:string;
    period:string; priority:number; confirmedBy:string; source:SourceRef}[];
  activeGuidance: readonly {ruleId:string; version:number; agentId:string;
    approvedBy:string; instructionAsUntrustedText:string}[];
  workflow: {id:string|null; revision:number; completedStepIds:readonly string[];
    pendingDecisionIds:readonly string[]; policyVersions:readonly string[];
    evidenceRefs:readonly SourceRef[]; expiresAt:string|null};
  activePolicyRefs: readonly {policyId:string; policyRevision:number;
    grantId:string|null; grantRevision:number|null}[]; // policy authority is NOT context guidance
};
~~~

#### Registered, per-key typed preferences (P2 contract; implementation later)

Each usable preference ID has a **code-reviewed definition in a small build-time registry**: `id` (stable namespaced key), `schemaVersion`, per-key `zod` value schema (strict bounds/enums, no arbitrary object/string fallback), `scope` (`owner_private` or `cafe_shared`), `sensitivity`, allowed consuming domains, effective-date semantics, defaults/absence rules and migration policy. Illustrative *future*, not implemented settings: `supervisor.digest_cadence.v1: z.enum(["daily","weekly","off"])` and `olivia.owner_preferred_weekly_minutes.v1: z.number().int().min(0).max(10080)`. A typed record is a discriminated mapping `ConfirmedPreference<K extends RegisteredPreferenceKey> = { key:K; schemaVersion:RegisteredDefinition<K>["schemaVersion"]; recordRevision:number; value:z.infer<RegisteredDefinition<K>["schema"]>; scope; confirmedBy; confirmedAt; effectiveUntil; source }`; the `BusinessContextV1.preferences` array holds **only** successfully validated known-key records. Any value loaded from persisted JSON starts as **untrusted unknown input**, must pass exact key+schema version validation and role/sensitivity projection before use, and is `unavailable/needs_review` rather than forwarded when unknown, invalid or needing migration. Do not silently coerce legacy free text into a typed enum/number, silently use defaults as owner confirmation, or downgrade incompatible schema versions. Registry extensions add a definition/test in the domain, not a Supervisor-core branch.

**Intentional free-text owner/AI Team instructions are `untrusted_guidance`**, stored/retrieved separately from typed preferences, clearly labeled source and owner, bounded/sanitized and treated as *data* with prompt-injection defenses. They cannot change priority of canonical records, approval gates, permissions, workflow checks or the type registry. Owner confirmation establishes provenance, **not safety of arbitrary prose**. Strictly typed objectives also require reviewed metric/target/unit/period validation and revisions; unknown targets remain unsupported, not operator commands.

**Fingerprint semantics:** `snapshot.fingerprint` hashes only canonical source-data snapshot/revisions used by the query; the separate `contextFingerprint` hashes the **canonical ordered, scope-bound material projection actually used for the proposed effect** (business, location, relevant owner scope, each referenced preference ID+definition version+record revision+validated value hash or explicit absence/revocation, objective revision/value hash, guidance rule ID/version+content hash, workflow ID/revision/decision state, and all applied policy/delegation IDs+revisions/expiry/constraints). Include a complete `contextRevisionRefs` manifest of *material* inputs used so additions/revocations/changed defaults cannot evade stale checks; if complete dependency tracking cannot be proved, conservatively fingerprint the full authorized active projection for that action. Context and policy fingerprints are **server-generated from trusted stores** with deterministic canonical serialization, not LLM text, and never expose sensitive raw values in logs/owner-visible tokens. Persist the exact fingerprint and references with every proposal/approval. At approval and immediately before commit, rebuild and validate both the source snapshot and the context/policy projection; **any material changed, missing, revoked, expired or schema-invalid revision means conflict/repropose/reapprove**, not silent refresh or stale execution. Irrelevant context changes can be excluded only with an auditable dependency manifest verified by the domain. Revoked authority always blocks effect.

Owner-confirmed personal working preferences, business operating objectives and active approved rules have **distinct provenance and authority**. Confirm/update/revoke owner preferences and business objectives explicitly with actor/version/effective dates; unconfirmed chat or inferred “memory” cannot silently become a fact. Keep an individual's private preferences and threads inaccessible to co-owners, while café-shared objectives require their separately reviewed update/override semantics. Approved Team guidance is *quoted data*, **never** business-effect consent, an authorization rule or precedence over actual evidence. Domain adapters request only the least context needed. Resolve conflicting values through source-purpose rules and targeted confirmation; pin source and context revisions to proposals, revalidate before execution, and reject stale authority. Do not persist broad raw model transcripts, sensitive employee records or third-party tokens in shared context.

### 6.1 Bounded multi-domain delegation

The Supervisor is a **bounded coordinator**, not the universal owner of every domain calculation or intent parser.

1. **Resolve trusted scope:** existing authenticated owner + selected café, locale, timezone; never read the business ID, user role, approver or allowed capabilities from model arguments.
2. **Capture goals:** semantically parse one or more requested outcomes (read, compare, simulate, propose, approve, commit); approve must resolve a **previously persisted exact server-side proposal**, not an LLM-created generic goal. Preserve all independent clauses and dates. Preserve existing Phase 4–later semantic request goals through a compatibility adapter. Reject unsupported commands rather than hallucinate a tool.
3. **Discover and match:** select only enabled, role-allowed capability descriptors and metric definitions. Source availability is evaluated at execution; a known capability may still be unavailable. Return explicit unhandled goals for every unsupported clause.
4. **Build a constrained DAG:** prerequisites from registry, max depth, fanout and duplicate canonical reads. Plan two-domain requests using stable dependency IDs. Never let a specialist directly invoke an unregistered sibling, mutate another domain or change shared Supervisor instructions.
5. **Run read/preview steps:** bounded parallel read-only operations, caching only within the authorized request/snapshot. Domain read failures are isolated; budget oversubscription produces per-goal budget-exhausted/unavailable outcomes, not silent dropped intents.
6. **Aggregate verified results:** the server validates each capability schema, source coverage, value provenance, period and consistency; any cross-domain conclusion must call a reviewed deterministic function or offer separate facts without claiming a calculated causal relationship.
7. **Choose action path:** `read` and `simulate` supply no-effect facts/what-ifs; simulation is **not** a draft or approval. Persist an inert `propose` artifact only on explicit request, binding source+BusinessContext+policy revisions; a separate **typed `approve` transition** checks authenticated actor, immutable exact proposal/effect/context/policy revisions and produces a durable approval record **without executing**. The `commit` path atomically consumes that approval/proposal once and invokes the distinct authorized domain executor (§§8–9). NEVER execute a mutation by selecting an LLM tool.
8. **Present:** adapt verified results to existing strict grounded reply blocks. Preserve current finance/sales/staff/pricing semantics and stable task links, and show attributed Olivia/Alex/Maya/Leo content inside the **same** Supervisor conversation.

**Snapshot coherence:** Cross-domain what-if comparisons use a referenced immutable input set or captured source revisions/as-of times. If one teammate sees a changed price/wage/schedule revision mid-plan, show a conflict/recompute instead of mixing stale numbers. Dependencies may degrade independently: "labor unavailable; observed sales available" is better than a false combined profit answer.

**Model trust boundary:** prompts and owner rules are untrusted interpretation hints, never data readers or grants. Any free-form attachment/search snippet/supplier quote may contain prompt injection; sanitize display and ignore embedded instructions. Parse model tool arguments through strict schemas; resolve entity IDs server-side with ambiguity checks. The model selects among server-issued IDs/approved phrases; it does not author business math, arbitrary URLs or final proof of completion. Provider absence, timeout or malformed JSON triggers deterministic safe fallback where available.

**Migration strategy:** keep the current supervisorRequest / supervisorFunctions / requestScope / toolRegistry / runSupervisorTurn path as a legacy adapter first. Feature-flag new discovery **in shadow mode for tests only**, compare supported intents/answers and budgets, then switch read routing behind a reviewed tenant-level rollout. Do **not** replace the existing read router in one PR. Existing MAX_TOOLS=5/MAX_ROUNDS=3 are baseline constraints to preserve initially; expansion must be bounded, cost-reviewed and explicitly tested.

## 7. Universal verified result and owner-facing action contract

Every specialist result must be machine-readable and server-validated; a textual explanation is derivative.

~~~ts
type SourceRef = {
  sourceType: string; sourceId: string; sourceRevision: string | null;
  capturedAt: string | null; effectiveFrom: string | null; effectiveTo: string | null;
  status: "actual"|"estimated"|"reported"|"planned"|"unverified";
};
type SourceConflict = { code:string; left:SourceRef; right:SourceRef; affectedMetrics:string[] };
type VerifiedCapabilityResult<T> = {
  capabilityId:string; contractVersion:1; status:ResultStatus;
  payload:T|null; evidence:SourceRef[]; metricIds:string[];
  period:{from:string;to:string;timezone:string}|null;
  completeness:"complete"|"partial"|"unknown";
  warnings:string[]; missingInputs:string[];
  assumptions:string[]; conflicts:SourceConflict[];
  producedAt:string; inputFingerprint:string;
  proposal:ActionProposal|null; // never effect confirmation itself
};
type ActionProposal = {
  businessId:string; proposalId:string; proposalRevision:number; // immutable revision
  actionType:string; capabilityId:string; capabilityVersion:number;
  tenantScopedTargetId:string; baseRevision:string;
  sourceSnapshotHash:string; // canonical BUSINESS DATA revisions only
  businessContextVersion:1; contextFingerprint:string; // typed context projection
  contextRevisionRefs:BusinessContextV1["contextRevisionRefs"];
  policyRevisionRefs:BusinessContextV1["activePolicyRefs"]; // authority != rule text
  proposedEffectHash:string; // canonical exact target+action+parameters+effect version
  summaryKey:string; effectPreview:unknown; missingPreconditions:string[];
  expiresAt:string; approvalPolicyKey:string; riskClass:"low"|"medium"|"high";
};
// Approval is a typed transition, never a side effect and never LLM-provided consent.
type ApprovalTransitionInput = {
  proposalId:string; proposalRevision:number; decision:"approve"|"reject";
  displayedEffectHash:string; // must match trusted persisted proposal preview
};
type ApprovalTransitionResult = {
  approvalId:string; proposalId:string; proposalRevision:number;
  state:"approved"|"rejected"|"conflict"|"expired"|"unauthorized";
  actorUserId:string; decisionAt:string; approvedEffectHash:string|null;
  approvedSourceSnapshotHash:string|null; approvedContextFingerprint:string|null;
  approvedContextRevisionRefs:BusinessContextV1["contextRevisionRefs"];
  approvedPolicyRevisionRefs:BusinessContextV1["activePolicyRefs"];
  expiresAt:string|null; auditEventId:string;
};
type VerifiedActionOutcome = {
  actionId:string; workflowId:string; actionType:string;
  status:"applied"|"rejected"|"conflict"|"failed"|"pending_reconciliation";
  effectId:string|null; persistedRevision:string|null; verifiedAt:string|null;
  verifiedEvidence:SourceRef[]; ownerActorId:string|null; auditEventId:string|null;
};
~~~

**Action-state separation:** current facts (`read`) → transient deterministic comparison (`simulate`, no proposal/effect) → separately requested persisted draft (`propose`) → **typed, auditable, no-effect approval** (`approve` result referencing exact immutable revision/hash) → **one-time approval/proposal consumption and authorized domain operation** (`commit`) → separately verified postcondition. “What if we schedule Sarah for fewer hours?” or “What if the drink price rises?” must stop at simulation unless the owner explicitly asks to propose a change. The server, not a model phrase, controls transitions. Tests verify no database/business side effects from simulation or approval, and that a valid approval is not proof of completion.

A proposal is neither permission nor an applied outcome. Owner-visible statuses map distinctly: **Suggested / Needs approval / Working or awaiting verification / Applied / Cannot complete / No data**. Show the exact employee/product/location, local schedule times, modeled costs/units, expected effects, uncertainty and proposed next action before committing. A completed badge requires durable postcondition evidence from the domain source; merely receiving an HTTP 200, an LLM completion, an external send attempt or a worker contact draft is not proof.

Preserve legacy GroundedSupervisorReply/blocks and evidenceReferenceSchema as the final write gate. Add a **separate, versioned trusted action-card renderer contract**, backed by server-issued opaque IDs and canonical internal routes; avoid relaxing the current numeric/text/link whitelist or allowing model-supplied action URLs. A detailed schedule grid or supplier/price compare can be a new typed block only after the same evidence validation, privacy, localization and backward-compatibility tests.

## 8. Capability-level authority, approval and delegated operation

### 8.1 Explicit policy dimensions

**Deny by default for every effect.** Evaluate authorization on discovery, preview, approval and execution, and again before an external call. Policy must bind: active café + authenticated actor + current role; registered capability ID/version/effect; target entity and location; sensitivity/risk class; canonical evidence freshness; business state/revision; confirmed owner choice; provider and transport availability; explicit enabled feature; and unexpired delegated grant when applicable.

| Tier | Example | Default behavior |
| --- | --- | --- |
| R0 — bounded read | Profit, menu products, scheduling inputs, Team tasks | Owner-scope checks; no business effects |
| S0 — transient what-if | Pure price/labor simulation using known evidence | No proposal, approval, domain write, notification or scheduled job |
| P1 — propose | Persist a reviewed pricing/schedule draft after explicit request | May persist inert, versioned proposal metadata; **not** apply |
| A2 — one-shot approved action | Publish specific Olivia plan revision; owner chooses pricing in canonical app | Fresh per-action, version-bound owner confirmation; transactional checks; receipt |
| D3 — tightly delegated action (future) | Repeated **allowlisted** low-risk internal action within owner-set guardrails | Separate opt-in per capability/target/limits, TTL/revocation, spend/time caps, anomaly stop, audit and owner visibility; do not turn on in baseline |
| X — forbidden/no provider | POS writes, payroll posting, staff texting without consent/transport, supplier purchasing without provider | No execution capability even if owner asks or a rule says so |

Owner guidance in ai_team_rules, a chat phrase ("always do this"), a model opinion, or prior approval of a different revision is never an authority grant. There is no universal Supervisor "full access" switch that authorizes writes. The permission to **read all supported metrics** must not imply ability to modify any record.

A future delegated grant should be persisted as tenant-scoped, capability/effect/version-scoped record with allowed targets, maximum per-run/count/spend/period, permitted hours, approval actor/time, expiry, revocation version and provenance; revocation must apply before new executions. High-risk/irreversible effects (payroll, price propagation to POS, outbound purchases, worker contact, external finance) remain forbidden absent their own security/privacy/legal review even with generic delegation. Provide owner-readable revocation, audit history and default off in every tenant.

### 8.2 Server-side approval workflow

Untrusted parse → entity resolution → deterministic preview → capability-specific feasibility and permissions → immutable proposal with source fingerprint → **specific owner approval** (authenticated, CSRF/same-origin, server-stored target/effect, optimistic version) → recheck state, tenant and permissions → durable execution → postcondition reread → audited verified outcome. If data changed or grant expired, produce conflict and require reapproval; no "best effort" substitution of a different schedule, staff member, product or price.

Olivia **approve** and **publish** remain distinct milestones according to docs/scheduling-architecture.md until an explicit later UX/security review authorizes combining them. Publishing is not worker acceptance, delivery or clock-in. Keep existing owner task response APIs separate from universal action grant policy.

## 9. Durable, idempotent execution and workflow state

Use a **small, additive tenant-scoped workflow ledger only when the first effectful capability is approved**; no migration in this documentation PR. Logical records: workflow (business, owner, originating conversation/message, goals/plan hash, state, version, created/expiry); steps (capability+version, input hash, dependency IDs, attempt count, lease, state, immutable result refs); approvals (proposal ID/hash/revision, actor, decision, policy/grant revision, expiry); effects (unique business/actionType/idempotency key, target/effect ID, requested payload hash, domain outcome); append-only audit events; transactional outbox where needed.

States: requested → planned → awaiting_approval → approved → executing → applied / pending_reconciliation / failed / rejected / canceled / superseded. Each state transition is compare-and-swap with authorized actor and full audit. A retry with the **same idempotency key and identical payload fingerprint** returns the prior result; reuse with a different payload returns conflict. Uniqueness must be enforced in the database, not only in process memory. Resume skips committed steps and revalidates current data/authority for uncommitted ones. Concurrent owner sessions cannot publish the same shift twice or approve different effects under the same proposal ID.

**Effect ownership:** Let each canonical domain repository own its atomic transaction and overlap/version constraints (e.g. Olivia published plan and shifts). Where an outbox/event must be emitted, write it **in the same transaction** as the domain change; then retry dispatch with lease + unique consumer key. Avoid distributed transactions and fake exactly-once external messaging. For a provider with uncertain timeout, mark pending_reconciliation and query its receipt/remote idempotency status rather than blindly replay a potentially charged or delivered action. Irreversible effects require explicit compensating **new action**, never history deletion.

Store minimal sanitized context, immutable input hashes and source IDs, not copied full conversations, bank statements, private uploads or bearer tokens in audit/job payloads. Provider secrets stay server-side encrypted. Support safe cancellation/expiry, administrator kill switch, and per-tenant quota without losing already-persisted records.

## 10. Shared business events, proactive evaluation and notifications

Adopt typed versioned **business events** with businessId, domain/entity ID, revision, event type, occurredAt, source reference, correlation/causation IDs and idempotency key. Keep the existing lib/operating/events.ts as an optional in-process notification adapter, **not** the durable transport. Start the durable transactional outbox and a small cron/in-process lease consumer **only for real approved use cases**, rather than a speculative event bus.

Registered domain evaluators subscribe to a **bounded allowlist** (e.g. confirmed availability changed, approved schedule version published, canonical price cost changed, invoice due status supported) and to time-based café-local checks. Evaluator produces a typed finding fingerprint (tenant + capability + entity + source revision + period + rule version), evidence, severity, lifecycle and proposed owner action. Before creating a new task it atomically upserts/reconciles with existing **operating_tasks** statuses. Reevaluate/reopen when material evidence changes, do not recreate on page view or mark gaps "handled" until proven resolved. Existing Alex/Maya/Leo tasks and owner snoozes/resolutions must not be overwritten by a new general reconciler.

Notification routing is downstream of verified persisted tasks/events: owner opted in, channel configured, confirmed destination, role still authorized, frequency/quiet hours checked in **business-local time**, privacy-safe template, rate cap, per-task and per-owner dedupe, actual provider receipt and audit. Current WhatsApp cron is UTC-day and is not yet a general event router; it must remain unchanged until a separately approved PR. Never notify employees or claim their acceptance via the existing owner WhatsApp path. Provider absent → in-app task, outbound result unavailable; "remind me tomorrow" requires a real persisted approved job, not just chat text.

### 10.1 Owner interruption policy: fewer interruptions, not more notifications

A domain evaluator produces **evidence-grounded findings**; a separate shared versioned owner-interruption policy decides what actually interrupts the owner. Classification must be `critical | time_sensitive | routine | informational`, carrying verifiable affected entity, urgency rationale, material impact, next required owner decision, true deadline (if any) and confidence. Prioritize safety/real uncovered coverage, deadlines and irreversible effects ahead of routine changes. Do **not** invent urgency from unknown labor laws or incomplete coverage.

- **Consolidate:** merge related/repeated findings by root cause/source fingerprint; batch routine items into café-local daily/weekly digest or existing Operations inbox. Suppress repeated notifications, **not** the underlying unresolved task. Apply configurable per-owner interruption budget, cooldown, snooze/acknowledgement and task-state persistence.
- **Respect quiet hours:** use chosen owner/business IANA timezone including midnight/DST edges, opted-in channel permissions, holidays and configurable do-not-disturb. Even critical bypass requires a **distinct owner-authorized emergency escalation policy**; otherwise preserve/queue the exception for the next allowed interval. No unsolicited employee messages.
- **Make exceptions actionable:** every urgent interruption contains “what happened”, source/quality/freshness, why now, what needs a decision, an actual deadline or “no deadline recorded”, the consequence of inaction and a scoped trusted action link. Do not page for actions the system safely finished and verified.
- **Report precise lifecycle:** evaluated → consolidated/suppressed/queued → provider-delivered → owner-acknowledged → issue-resolved/reopened. Sent ≠ read; read ≠ resolution; provider unavailable means in-app task, not “notified”. Reevaluate on relevant evidence revisions; consent revocation/quiet-hours changes invalidate pending sends.

**Do not change** the current UTC-day owner WhatsApp cron in this PR. Require evaluated policies, permission, routing and notification regression tests before any later transport change.

### 10.2 Measured owner-time outcomes and safety scorecard

Collect a **2–4 week pilot baseline** of comparable manual tasks using sampled owner-confirmed handling durations (not fabricated AI estimates) plus existing auditable task, approval, execution and alert events. Report 7/30-day periods with visible data coverage/unknowns; compare same task types, location and workload. Do not award “time saved” for creating suggestions that take the owner longer to review.

| Measure | Definition and denominator | Guardrail |
| --- | --- | --- |
| **Owner time saved** | Per task type: owner-confirmed manual baseline active minutes minus measured/confirmed owner-active minutes to complete equivalent work, including review/rework; show hours and confidence/coverage | No unverified time credit for background jobs, drafts or unsupported worker contact |
| **Required manual interventions** | Owner inputs/decisions actually needed to resolve operations per café-week, split by urgency/capability and repeat contacts | Capture off-chat Staff and task corrections, not only chat clicks |
| **Routine work handled without owner involvement** | Verified completed eligible routine workflows with no owner action / all eligible routine workflows under valid scoped grants | Proposal, simulation, scheduled-but-not-run and unconfirmed external effects do not count |
| **False alerts** | Evidence-confirmed stale, duplicate, wrongly urgent, ungrounded or already-resolved interrupts / all adjudicated interrupts; also show unreviewed alerts | Owner dismissal alone is **not** proof of falsity; separately track missed serious alerts |
| **Unresolved operational issues** | Open verified needs-owner issues by severity and age, including overdue decision windows/reopened tasks | Muting/deleting tasks cannot make issues disappear |
| **Verified execution failures** | Failed or still-indeterminate postcondition after reconciliation / all effects attempted, with cause, absolute count and time to recovery | Distinguish permission-denied, not-attempted, pending receipt and confirmed applied |
| **Interruption load** | Immediate alerts, digests and unique owner-required decisions per owner-week, with quiet-hour violations | A lower count must not hide critical exceptions |

Owner must approve measurable pilot targets for time savings, intervention reductions and false-alert/failure ceilings **after observing the baseline**; avoid fabricated fixed success percentages. Product success requires fewer interruptions and real hours returned, **without increasing unresolved critical gaps or unsafe effects**. Hands-on/assisted/delegated involvement settings express preferences, **not** permission grants.

## 11. Shared cost, latency, quality and failure controls

Each capability declares resource class, max input size/range/row count, expected source reads and permissible external calls. A **per-turn controller** enforces limits for model calls, tool calls, unique canonical reads, dependency fanout, wall-clock deadline, concurrency, response size, tenant quota and external spend. Keep the existing MAX_ROUNDS=3/MAX_TOOLS=5 budget during compatibility migration; no unbounded chain of specialist prompts. Deduplicate the same underlying metric read across Alex/Leo/Olivia and cache only inside the authorized scope/time snapshot; do not leak caches across business/owner/privacy boundaries.

Priority: execute safety/authorization and required evidence reads first, then cheap deterministic metrics; expensive optional enrichments last. A partially completed composite request returns each goal's exact status and asks only for material missing inputs. Timeout/provider down returns a safe structured failure, never a fabricated last-known success. Currency estimates of **LLM inference cost** live separately from café financial calculations and remain unknown if token rates are missing. Keep token/call/cost metrics server-only, not in the owner's business facts.

Mandatory observability without secrets: trace/request/workflow IDs, capability version, tenant pseudonymous correlation, per-step status/latency/read counts/budget consumption, failure category, evidence IDs, approval/audit chain and provider receipt status. No raw bank lines, tokens, user message bodies, uploaded staff documents or private employee details in logs. Audit storage/access retention is a separate privacy review.

## 12. Tenant security, provenance and error containment

- Authenticate at every server entry; owner/café resolved from selected business and session. For staff-sensitive data restrict columns, aggregates and location as authorized. Never trust model/client-supplied role, businessId, staffId ownership or capability name.
- Enforce **both** RLS/composite tenant foreign keys and server-side checks for every read and effect. Generic privileged admin/service-role clients are forbidden as a shortcut to permissions; any narrow internal privileged writer must have validated owner/message provenance and scoped selectors like existing replyWriter.server.ts.
- Apply zod strict input/output schemas; reject extra keys, oversized payloads, invalid dates, DST ambiguity, URL injection and unknown metric dimensions. Canonical entity resolution detects duplicate employee names, inaccessible IDs, stale revisions and confused owner identity.
- Permission policy is a mandatory server gate immediately before executing the domain effect, not merely a UI-disabled button. Separate evidence-read credentials from effect-writing credentials.
- Model-generated text, approved Team rules, source search snippets, imported POS payloads and uploaded files are **data**, not instructions with higher privileges. No arbitrary SQL, SSRF via user-supplied URLs, external action dispatch from prompts or dynamic code loading.
- Append-only audit with consistent actor/capability/revision/source identity; redact owner display without deleting historical accountability. Supabase owner A, co-owner B, manager, outsider and other-café tests required.
- Failure categories: unsupported, unavailable source, insufficient evidence, stale/conflicting evidence, denied, invalid request, provider unavailable, timeout, budget exhausted, domain conflict, indeterminate external effect. Map each to localized, non-sensitive owner guidance. Disallow cross-domain success when one step failed a required postcondition.

## 13. Exact Olivia scheduling relationship and PR #72 isolation

**No changes to #72 in this PR.** Its proposed owner-only, default-off availability/preferences/qualifications/coverage/compensation source records are a **domain data foundation**. Its server action and input schemas remain under lib/scheduling/, while pure availability/precedence helpers and all future optimizer/feasibility/cost calculations belong solely under lib/calc/scheduling/ as prescribed by docs/scheduling-architecture.md. This Supervisor platform is a **consumer and policy wrapper**, not a replacement.

Binding integration points:

1. **Read adapters:** olivia.availability.read.v1 and future coverage/cost metrics call a reviewed owner-scoped scheduling read service. Register after #72's migration/activation is separately verified; otherwise return unavailable. The platform never reads the scheduling tables via raw model SQL.
2. **Preview adapter:** olivia.schedule.preview.v1 accepts only resolved employees/locations, business-local calendar horizon and verified input revision. It delegates entirely to the pure domain planner and exposes feasible assignments, exact uncovered intervals, constraints, wage provenance/quality and owner-hour costs. No POS needed: owner-entered coverage is valid input. **No claim of a working optimizer until a later implementation PR passes tests.**
3. **Action adapter:** olivia.schedule.approve.v1 / publish.v1 arrive only when the later versioned domain plan/revision/transaction exists; approval and publication are policy-gated, idempotent and recheck DST/legal/rest/wage/qualification/snapshot. Platform stores action workflow links; the domain owns immutable assignments and publishing effects. A Supervisor "yes" without bound plan revision is not publication.
4. **Tasks/events:** future Olivia evaluator creates/reconciles existing staff_coverage operating_tasks based on verified gaps, and optional owner alerts through shared routing after consent/quiet-hour review. Current #72 has neither optimizer nor notifier and must not be described as one.
5. **Timecards and compatibility:** legacy staff_schedules and materializeSchedule.ts can create source-marked predicted timecards (including historical recalculation risks); new draft/published assignments **must not** become actual timecards. Keep an explicitly reviewed, opt-in bridge to avoid double labor counts, preserving existing staff/payroll/history and external Toast planned shifts as advisory. Required tests cover single/multiple shifts, overnight/DST, co-owner races, read precedence and recovery.
6. **Compensation invariant:** recorded **positive** wage always defeats a stale known_eligible_zero attestation; unknown is not free, salary conversion pending is not zero, owner opportunity costs are separate. The ongoing #72 review concerns this precise invariant; Supervisor action/metric confidence must fail closed until the domain behavior is corrected and verified on that PR.
7. **Conversations:** "Ahmed can't Friday" must resolve the employee or clarify duplicate names, create a reviewed proposed change, and display actual/possible uncovered coverage. No unverified worker message, confirmed acceptance, published plan or loaded savings. Preserve all existing ordinary finance/Team/pricing/sales response paths unchanged.

Scheduling's earlier phase numbering is a **domain delivery sequence**, not a reason to implement a bespoke central Supervisor scheduling router first. Platform PRs can be independently staged while #72 continues; the actual Olivia adapter cannot be activated before domain prerequisites and explicit owner authority pass their gates.

## 14. Minimal ordered implementation PRs (AFTER architecture approval)

This PR is **P0 — architecture only**: reconcile the now-received RFC/review packet with the existing contract and request fresh independent review; no application code, migration, test fixture or environment change. Do not merge automatically.

| Order / prerequisite | Minimal PR and targeted files | Acceptance / stop gate |
| --- | --- | --- |
| **P1 — full surface inventory + metric/entity/analysis access** | Inventory current canonical facts/records/analytics and intentional unsupported states; small lib/metrics/* catalog plus bounded domain entity-read descriptors and CI coverage tests; wrap existing lib/ai/tools.ts / domain readers without behavior change | Two-way surface inventory enforced in CI; every supported surface resolves via authorized metric/entity/analysis reader or documented restriction/unavailable; no model SQL, no financial math changes; legacy finance/sales/staff/menu/pricing intact |
| **P2 — capability protocol + read/simulate shadow registry** | Small typed manifest/dispatcher with existing read descriptors and a pure transient simulation adapter, plus source-pinned read-only BusinessContext.v1 using existing approved source records | Fifth domain read/simulation registers without core edits; simulation produces no business writes; contexts are privacy-scoped/versioned and rules cannot grant execution; strict schemas/default deny; no owner-visible change |
| **P3 — bounded multi-domain read/simulation orchestration** | Refactor existing scope/request/tool registry/turn loop behind compatibility flag, preserving strict grounded reply writer; use authorized versioned context, snapshot-aware read dedupe and per-goal results | Existing semantic fixtures + EN/ES/AR and finance/sales/staff/Team/pricing behavior equivalent; Alex+Leo read and Olivia+Leo what-if safely compose, without implicit proposals/actions; rollback flag works |
| **P4 — audited proposal/approval/execution primitive** | First targeted additive workflow/approval/idempotency/audit migration and server-only domain action gateway; **no generic action enabled** by default | RLS/co-owner/race/retry/crash tests; one reversible test effect with exact approval/version and reverified outcome; unapproved/revoked/unknown capability cannot execute |
| **P5 — Olivia scheduling adapter when domain ready** | Separate PR integrating reviewed lib/scheduling/ preview/publish domain services with platform registry, trusted grounded schedule card and Staff link, plus flags/localizations/tests | No change to #72 or activation by this docs PR; no POS required, no fake timecard/payroll, hard constraint and missing-data gates, specific plan owner approval and idempotent publish |
| **P6 — evaluators, interruption budget and owner-outcome verification** | Add transactional outbox/lease and task reconcile only for approved uses; enforce urgency/digest/quiet-hour/owner consent before extending provider routing; outcome scorecard instrumentation with coverage | Retry-safe existing task lifecycle, quiet hours and opt-in, consolidated routine alerts, actionable urgent exceptions, no false delivered states; measured owner time and false-alert/failure guardrails |
| **Domain follow-ons (parallel where safe)** | Alex pricing capability, Maya evidenced supply/optional inventory, Leo money actions only after supported integration; each domain supplies contracts/tests, not new central intents | One or two new module registrations, no new Supervisor core branching or LLM SQL; unsupported integrations visibly unavailable |

P1 and P2 may be divided by test and migration risks; P4 and P6 must remain default off until separately approved. **No broad "agent framework first" rewrite.** PR #72/Olivia domain PRs continue on their own branch/sequence and must not be rebased into this architecture PR merely to satisfy the platform plan. Every application PR requires diff review, unit and DB integration tests where relevant, npx tsc --noEmit, npm run test, npm run lint, npm run build, git diff --check, and pilot/staging verification before production activation. Report actual results/skips; no implicit auto-merge or production migration.

### Required executable acceptance tests (architecture specification)

These are **future tests**, not tests executed by this documentation change.

| Test ID | Fixture / operation | Must prove |
| --- | --- | --- |
| EXT-01 | Register Olivia read/preview implementation with domain descriptors; ask about staffing | No changes to core planner, tool schema enum, permission engine or global intent switch; one validated, attributable result |
| EXT-02 | Register Alex pricing review+proposal using same contract | No Olivia-specific exception in core; canonical lib/calc pricing engine and evidence, no POS price write |
| EXT-03 | Register Maya supply quote read and Leo period cost read | No new central intent-specific branches; proper source estimates, matching units, distinct canonical domain ownership |
| EXT-04 | Register hypothetical fifth domain / new metric fixture | Only registry export, metadata/adapter, localized display and tests change; existing core source diff stays empty |
| COVER-01 | Inventory every current business metric, entity and analytical reader, add/rename a public domain projection | CI fails on any unmapped new/renamed/removed supported surface; every surface is registered or explicitly restricted/unsupported, and every catalog entry has a real source or unavailable result |
| COVER-02 | Test catalog with staff-private records, missing inventory, no POS, source-incomplete sales and unsupported hourly/dimension query | Distinct metric/entity/analysis contracts, strict field limits, no SQL, no unauthorized access, no invented totals/stock/coverage; unsupported returned explicitly |
| SIM-01 | Compare a proposed staff-hour scenario and an Alex price what-if without asking to save | Pure reproducible calculation from pinned evidence; zero draft, price, schedule, timecard, notification or external effects; proposal ID absent |
| CONTEXT-01 | Two owners with private preferences and shared confirmed objectives, approved natural-language team rule and stale snapshot | Each domain sees minimum authorized context; version changes invalidate proposal; rule cannot execute; no cross-owner memory leak |
| INTERRUPT-01 | Ten duplicate routine findings, one verified urgent shift exception, café-local quiet hours and provider disabled | Single digest/operating task for routine findings; only explicitly authorized emergency override bypasses quiet hours; pending urgent task remains actionable; no false delivery |
| OUTCOME-01 | Workflow has simulation, proposal, verified completion, unverified external attempt, owner intervention and confirmed false alert | Scorecard uses only verified effects and audited owner time; correctly counts interventions, false alerts, unresolved issues and failures without inflating savings |
| MULTI-01 | "Plan next week and show what it would cost vs this month's profit" with no POS | Olivia planned labor/coverage if domain ready; Leo period profit explicitly unavailable when unsupported; never add incompatible periods or forecast to actual profit |
| MULTI-02 | "Which drinks need a pricing review and how much did we sell yesterday?" | Alex+sales scopes independently fulfilled; missing item sales produces partial/unavailable while verified pricing remains valid |
| MULTI-03 | Conflicting source versions or a changed wage after read plan | Shared snapshot fingerprint mismatch → conflict/replan, not mixed-period math or stale zero wages |
| BACK-01 | Exact current semantic request fixtures, ordinary finance/sales/staff/pricing/Team, EN/ES/AR | Stable canonical numbers, period meaning, task links, evidence blocks, currently supported goal coverage and safe unknown responses |
| BACK-02 | No POS, no bank, no inventory, no sales history, provider offline | Explicit unavailable with missing inputs; zero only if verified; no invented hourly demand or external connection |
| BACK-03 | Unknown dimension, unsupported hour/day rollup or unauthorized person | Reject/return unavailable with correct reason; never extrapolate daily sales to hourly |
| SEC-01 | Owner A, second owner same café, manager, outsider, other business, tampered business/employee/plan IDs | Server auth + RLS + composite FKs enforced; private owner conversations isolated; no cross-tenant leak, including from cache or tool output |
| AUTH-01 | LLM attempts commit/read->write escalation, approved natural-language Team rule, forged confirmation | No effect; rules are not grants; action must be registered, policy-allowed, exact proposal approved |
| AUTH-02 | Approved plan revision then change source/wage/revoke grant/expire proposal | Execution blocked, conflict or reapproval; no stale change applied |
| IDEMP-01 | Same request ID/action key 10 retries and 2 concurrent owners | One resulting domain effect and one provenance chain; mismatched payload key conflicts |
| IDEMP-02 | Process crashes after effect commit, before reply or after provider timeout | Resume reconciles durable state; does not reapply effect/send again blindly |
| EVENT-01 | Replay event and cron simultaneously; change/reopen source evidence | One task lifecycle per fingerprint; meaningful new evidence reopens; previous resolved/snoozed tasks not resurrected spuriously |
| NOTIF-01 | Opt-out, quiet hours, no provider, uncertain provider receipt | No message delivered or claimed; only provider-confirmed sends count; provider absent keeps in-app task |
| MONEY-01 | Verified zero vs absent wage; 0/unknown/estimated sales, duplicate imported order/timecard, DST shift | Exact integer cents and coverage, no double labor counts; positive wage invalidates stale zero provenance |
| QUALITY-01 | Fresh/partial/stale, conflicting purpose-specific sources, estimated burden | Accurate status lattice and provenance, no misleading verified totals |
| COST-01 | 5 tools/3 model rounds baseline, slow third-party adapter, budget exhausted, model down | Deadline/fanout enforced; each owner goal receives verified result or explicit safe failure; no runaway expense |

Additional integration cases: unsupported attachment as evidence, worker acceptance absent, scheduling legal profile unknown, report/snapshot replay, two same-name employees, location and timezone/DST mismatches, idempotent action card review, price/schedule simultaneous requests, source conflicts that require owner confirmation, transaction audit failure, notification consent revocation between reservation and send. Use synthetic tenant fixtures, no production customer/worker PII.

## 15. Risk register, tradeoffs and avoided overengineering

**R1 — Review packet reconciled; external verdict not yet provided:** the attachment has been read and reconciled. It contains the architecture proposal and instructions **requesting** an independent critical A–H verdict, not that verdict. Its availability is resolved; fresh reviewer sign-off and owner product/policy decisions remain necessary before implementation.

**R2 — Regressions from replacing today's central router:** keep legacy read adapter and strict grounded final writer, test existing semantic fixtures first, shadow run before switching. Do not replace all existing tools in one commit.

**R3 — Catalog gives illusion of data coverage:** metric metadata is not data. Implement quality, coverage and unsupported granularity as first-class result states; "every metric" must mean every **supported** metric, never database-wide universal facts. No POS/bank/inventory assumption.

**R4 — Approval and rules conflated:** natural-language owner rules remain text. Specific, expiring, version-bound approval and later separately reviewed delegation are mandatory for effects.

**R5 — Scheduling provenance/payroll double counts:** #72 stale zero attestation, legacy materialized predicted timecards, external planned shifts and legal rules are separate hard gates. No planner publication without source/role/time/wage tests and explicit owner action.

**R6 — Durable workflows increase schema/operational complexity:** do not add a job store until first approved effect or proactive evaluator needs it; keep atomic domain transactions and minimal outbox, not distributed workers.

**R7 — Cost/latency explosion from multi-agent prompting:** one Supervisor reasoning boundary with shared deterministic tools; specialist is a typed responsibility, not four sequential expensive LLM conversations.

**R8 — "universal" routing becomes lowest-common-denominator domain logic:** registry protocol stays narrow; domain validation, solvers, financial formulas and source precedence remain specialist-owned/canonical.

**R9 — Notifications and legal/privacy:** WhatsApp owner messages are opt-in and current UTC cron; avoid reusing as employee messaging or asserting location quiet hours without additional tests. Staging / counsel or compliance review as appropriate.

**R10 — Source freshness, legal and data reliability:** unsupported worker opt-in, hourly sales, tax/benefits and supplier quantities must not be generated by a model. Unknown data preserves unknown consequences.

**R11 — Catalog coverage drift:** the starter list is not an exhaustive inventory. Without P1 audit and bidirectional CI tests, a new metric/record can become silently unqueryable (or, worse, erroneously claimed available). Do not claim universal coverage complete until the audited manifest passes.

**R12 — Context and interruption creep:** owner preference/LLM memory and growing proactive alerts can worsen privacy, overwhelm owners or silently confer authority unless explicit confirmation/versioning, digest/quiet hours and workload measures constrain them.

**Do not build:** unrestricted SQL/GraphQL model query, autonomous four-agent chat room, generalized distributed microservices, arbitrary plugin execution, all-purpose rules DSL, customer-facing agent marketplace, duplicated business data lake, new finance/payout formulas, second owner task inbox, a fake "0 data" fallback, automatic external POS writes, or speculative vendor connectors. Choose small in-process interfaces, canonical read adapters and meaningful verifiable domain tests instead.

### 15.1 Critical reconciliation with the attached Independent Architecture Review Packet

**Source interpretation:** The attached October 14 packet contains a proposed RFC, ten critical reviewer questions, a request for an A–H independent assessment, and an eight-question checklist. It **does not include an actual external reviewer verdict or issue-severity ranking**. This document is a critical reconciliation of that proposal, not a claim that an independent reviewer approved it.

| Packet proposal / concern | Decision and rationale | Remaining open matter |
| --- | --- | --- |
| One universal registry vs simple domain-service router (§§1–4) | **Accept a phased hybrid:** a small build-time typed registry and in-process adapters atop canonical services; no four autonomous model agents or microservices | Contract-breaking/new rendering types can still require reviewed platform changes |
| Shared authorization, results, metrics and cross-domain workflows (§§3–6) | **Accept/refine:** shared governance, scoped metric+record+analysis discovery, strict evidence validation and DAG coordination with legacy read compatibility | Future evidence UI types need a separately tested protocol migration, not unconstrained model text |
| Packet classifies `simulate`, `draft`, `read` and effects (§§4–5) | **Strengthen:** simulation is transient/pure; a draft is an independently requested persisted proposal, owner approval and commit are separate; no silent promotion | Exact UX to convert simulation into a draft and proposal expiry needs product review |
| Universal access to all business facts (§§3,9) | **Strengthen:** complete inventory, two-way CI coverage, metric access **distinct** from tenant-safe entity reads; restricted data stays restricted | P1 is required to identify every current field; inventory completeness **not verified today** |
| Owner choice, shared context and rules (§§7,9) | **Accept with boundary:** BusinessContext.v1 from owner-confirmed preferences, objectives, active rules as *untrusted guidance*, source and workflow revisions; no arbitrary model memory | Permission granularity, co-owner preference conflicts, owner correction UX, retention rules |
| Proactivity and notifications (§§7–8) | **Accept/refine:** shared urgency, actionable exceptions, quiet hours, rate/digest controls, existing operating_tasks and owner opt-in; no premature event microservice | Emergency bypass consent/quiet hour policy, measurable pilot targets, real provider availability |
| PR #72 and Staff/timecards (§§10–11) | **Preserve:** separate scheduling-domain delivery, `lib/calc/`, no-POS manual input, staff/cost provenance, no Supervisor changes in #72 | PR #72's wage-state and overnight availability P2 concerns must be rechecked at **current** PR head; no assumption fixed or still open from this packet |
| Packet examples: Maya inventory and Leo bank/cashflow (§4) | **Disagree if described as present:** supported supplier quotes are not stock counts, and no connected bank feed is verified; advertise unavailable until connectors and canonical sources actually exist | Future integration requirements remain independently reviewable, not reasons to expand PR #73 |
| Success measured by reduced owner workload (§§1,7,12) | **Accept:** owner hours saved, manual decisions, routine completed effects, false alerts, unresolved issues and verified failures with baseline/quality guardrails (§10.2) | Owner and pilot must select valid denominators, baseline sampling and success thresholds |

**Alternative considered:** A purely modular Supervisor adding new hand-coded tool branches per domain is smaller at first but keeps the demonstrated central schema/permission/response churn and eventually duplicates metrics, workflows and interruption policies. A fully generic autonomous agent framework is substantially more costly and increases security/latency risks without owner-value evidence. **Recommended middle course:** typed in-process registry, canonical reads and verifier immediately; durable effect ledger and outbox only after a safe business case is implemented. This is an architectural preference needing review, **not a measured performance result**.

**Remaining explicit owner/security approvals:** choose initial involvement mode (hands-on/assisted/delegated preferences are never grants); action/delegation effect allowlist and risk thresholds; co-owner private/shared preference and rule correction rights; staff-sensitive field visibility vs aggregate reads; quiet-hour and true urgent exception policies; approved pilot targets and measurement/privacy retention; proposal-to-action UX; eventual provider-independent effect reconciliation; compatible grounded card renderer extension. None authorizes an immediate POS write, salary change, schedule publish or worker message.

**Packet checklist disposition:** future specialist extensibility **specified but untested**; deterministic approval veto **specified but not implemented**; durable crash-safe execution **specified but not implemented**; cross-domain grounded result **specified but not implemented**; no-POS manual mode and independent Olivia track **preserved as binding requirements**; proposed/approved/applied visibility **contracted, not deployed**; simpler alternatives **considered with hybrid choice**. The architecture is **ready for a new critical architecture review**, not yet independently approved or ready for feature implementation.

## 16. Proposed targeted documentation alignment AFTER approval

Do **not** edit these in this architecture PR. Once this contract and the reconciliation in §15 receive explicit approval:

1. **docs/09-ai-native-operating-system.md:** add an explicit link to this platform contract and replace any now-obsolete "no shared structured tool surface" state with historical context; retain lib/calc/ and source-aware state as binding.
2. **docs/scheduling-architecture.md:** insert a brief "universal Supervisor capability adapter" integration cross-reference; keep domain constraints, Olivia PR sequence, split timecard/worker semantics and no-POS guarantee unchanged. Note that its old PR 4 scheduling-specific Supervisor router should instead register into the common platform after P1–P3 and reviewed domain readiness.
3. **docs/supervisor-phase4-grounded-chat.md / phase5-owner-rules.md:** explain that legacy read-only tools are compatibility adapters and owner rule approval still cannot grant action authority. Do not rewrite their history.
4. **docs/01-product.md / 03-screens.md:** maintain the explicit owner-approved *Olivia* scheduling exception (already proposed in #72) and single Supervisor/Staff/Operations journey, rather than introducing separate specialist chat screens.
5. **docs/04-data-model.md, 06-integrations.md and 07-build-plan.md:** add only reviewed workflow/outbox/metric provenance dependencies and opt-in rollout steps **when** matching implementation PRs exist, not speculative tables at P0.
6. **AGENTS.md / PROGRESS.md:** minimal pointers to the newly approved architecture and per-PR implementation plan only after the contract is accepted; no Next.js rules or financial invariant edits.

### P0 verification and exit criteria

Before merging this **documentation-only** PR, check: (a) its sole changed file is docs/supervisor-platform-architecture.md; (b) no change to main or PR #72 from this branch; (c) the attached RFC/review packet was compared without falsely treating its *requested* external verdict as delivered and a **fresh Codex/architecture review** has been requested and addressed; (d) owner and reviewers decide open privacy, delegation, context, metric coverage and interruption contracts and validate P1–P3 backward-compatibility and Olivia gates; (e) no production DB migration, POS connection, env flag, Vercel change or deployment was made. P0 is a design contract, **not** test-passing application code or a claim that future integrations already exist.
