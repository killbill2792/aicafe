# AI CAFE — Universal Supervisor Platform Architecture

**Status:** Proposed architecture contract only; review required before implementation. **No runtime behavior, migrations, feature flags, deployments or permissions change in this PR.**  
**Architecture review provenance:** This architecture originated in PR #73 using the historical PR #72 baseline (2026-10-14). **Current implementation update (2026-10-15):** Olivia PRs #75 (availability UI) and #77 (pure seven-day optimizer) and Universal Supervisor P1 PR #76 are merged; Supervisor P2 PR #79 is merged into `main` (shadow-only registry; no live P3 orchestration), and scheduling plan publication/Supervisor orchestration remain separate future work. Verify the latest `main` and open PRs at implementation time. A merged PR never proves production migrations were applied or flags enabled.
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
| docs/scheduling-architecture.md and **merged PRs #72/#75/#77/#84** | Owner-only, default-off manual scheduling foundation and availability UI plus merged PR #77 pure `lib/calc/scheduling/planner*` optimizer, independent assignment validator, and PR #84 default-off revisioned schedule-draft persistence (`lib/scheduling/planDrafts.server.ts`, migration `20261015000064_olivia_plan_drafts.sql`) | Code is merged into `main`, but production migration/flag activation are unverified; versioned schedule publishing, verified worker acceptance, and live Supervisor scheduling adapter remain unshipped |

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

// This is a non-executable shared metadata base; it has NO execute callback.
type CapabilitySchemaContract = {
  id:string; version:number;
  inputSchemaFingerprint:string; outputSchemaFingerprint:string;
}; // exact reviewed schema identity, stable across serialization
type CapabilityMetadata<I,R> = {
  id:CapabilityId; version:1; agent:AgentId; descriptionKey:string;
  inputSchema:ZodSchema<I>; outputSchema:ZodSchema<R>;
  schemaContract:CapabilitySchemaContract; // versioned I/O schema identity
  discoverableGoals:readonly string[]; producesMetrics:readonly string[];
  requiresMetrics:readonly string[]; dependsOn?:readonly CapabilityId[];
  requiredRole:"owner"; sensitivity:"normal"|"staff"|"financial";
  approvalPolicyKey:string|null;
  budgetClass:"cheap_read"|"bounded_read"|"planning"|"external";
  preconditions:readonly string[];
  enabledFor:(ctx:AuthorizedContext)=>Promise<boolean>;
};
type ReadCapability<I,O> =
  CapabilityMetadata<I,ReadResult<O>> & {
    mode:"read"; approvalPolicyKey:null;
    read:(ctx:AuthorizedContext,input:I)=>Promise<ReadResult<O>>;
    simulate?:never; propose?:never; evaluate?:never;
    approve?:never; commit?:never;
  };
type SimulateCapability<I,O> =
  CapabilityMetadata<I,SimulationResult<O>> & {
    mode:"simulate"; approvalPolicyKey:null;
    simulate:(ctx:AuthorizedContext,input:I)=>Promise<SimulationResult<O>>;
    read?:never; propose?:never; evaluate?:never;
    approve?:never; commit?:never;
  };
type ProposeCapability<I,O> =
  CapabilityMetadata<I,ProposalResult<O>> & {
    mode:"propose"; approvalPolicyKey:string; // may persist INERT draft only
    effectContractKey:EffectContractKey;
    propose:(ctx:AuthorizedContext,input:I)=>Promise<ProposalResult<O>>;
    read?:never; simulate?:never; evaluate?:never;
    approve?:never; commit?:never;
  };
type EvaluateCapability<I,O> =
  CapabilityMetadata<I,EvaluationResult<O>> & {
    mode:"evaluate"; approvalPolicyKey:null;
    evaluate:(ctx:AuthorizedContext,input:I)=>Promise<EvaluationResult<O>>;
    read?:never; simulate?:never; propose?:never;
    approve?:never; commit?:never;
  };
type ApprovalCapability =
  CapabilityMetadata<ApprovalTransitionInput,ApproveResult> & {
    mode:"approve"; approvalPolicyKey:string;
    approve:(ctx:AuthorizedContext,input:ApprovalTransitionInput)
      =>Promise<ApproveResult>; // never invokes a domain effect
    read?:never; simulate?:never; propose?:never;
    evaluate?:never; commit?:never;
  };
type CommitCapability =
  CapabilityMetadata<ApprovedEffectInput,CommitResult> & {
    mode:"commit"; approvalPolicyKey:string;
    effectContractKey:EffectContractKey;
    commit:(ctx:AuthorizedContext,input:ApprovedEffectInput)
      =>Promise<CommitResult>; // ONLY registered effectful entry point
    read?:never; simulate?:never; propose?:never;
    evaluate?:never; approve?:never;
  };
// The build-time manifest merges concrete domain exports without erasing
// typed mode, input or output schemas to "any" or a generic execute path.
type RegisteredCapability =
  (typeof compiledCapabilityRegistry)[keyof typeof compiledCapabilityRegistry];
// Future generated, server-owned manifest; each entry must satisfy exactly
// ONE of the six descriptor variants via strict typed registration.
type ApprovedEffectInput = {approvalId:string; proposalId:string;
  proposalRevision:number; approvedEffectHash:string};
// The input is an opaque lookup/replay reference, NOT effect parameters.
// Commit reloads exact canonicalEffectPayload from immutable trusted storage,
// validates it and never infers parameters from these IDs, preview or live state.
// Dispatch switches on descriptor.mode, validates input/output strictly and
// never exposes the commit executor to read/simulate/propose/evaluate handlers.
~~~

**Mode-level enforcement:** The compile-time registration helper accepts only the six explicitly discriminated descriptor variants (never a generic `execute` method). Before dispatch it parses each input with its declared **strict Zod schema**; after dispatch it parses output with the mode-specific **strict discriminated schema** and rejects extra or unauthorized keys. Capability handlers receive only their mode-scoped trusted service facade: read/simulate/evaluate cannot access effect/proposal persistence, propose can access *only* inert proposal storage, approve can write only version-bound approval ledger entries, and only commit receives the domain effect gateway. Both the function types and least-privilege server interfaces/DB policies must enforce this boundary; TypeScript checks alone are insufficient against runtime code paths, generated JSON or direct DB calls. Default deny and RLS apply to all six paths, and a model-supplied mode, effect or handler name cannot override the server's registry selection. Reuse the existing legacy read path until behavior parity gates pass.

**Non-effectful operation invariant:** `read` returns canonical facts and `simulate` runs a **transient, read-only, deterministic what-if** using pinned source inputs and `lib/calc/`. Neither creates a scheduling draft, proposed price, approval request, task, outside message or business-domain write. Protected usage/audit telemetry is permitted but cannot imply domain mutation. Simulations state baseline, changed assumptions, feasibility/limitations and source revision; they return `proposal: null`. `propose` is a **separate explicit transition** that may persist an inert versioned draft after the owner requests it. **`approve` is a first-class typed, server-only transition** that validates an immutable proposal and records a scoped approval artifact; it does **not** invoke a domain write. **`commit` is a separate policy-gated executable capability** that must consume that approval exactly once (or use a specifically validated standing grant, if a later reviewed effect supports delegation). `evaluate` is a bounded evidence check, and any task persistence goes through its separately authorized reconciler. Dispatcher and acceptance tests must prove these distinctions even if the model requests a more powerful action.

The executable contract separates **all six modes** as type-discriminated descriptors with distinct callbacks and runtime-validated, mode-tagged result variants (§7). `read` and `simulate` return `proposal: null` by type and strict result schema, and may never call a draft or effect repository. `evaluate` returns only bounded findings; creating or changing an Operations task requires a distinct registered reconciler and policy, not an evaluator side effect. `propose` may persist only an inert, versioned proposal with an immutable, schema-validated canonical effect payload; it has no commit callback or authority. `approve` accepts an authenticated actor's exact server-issued proposal reference/decision, returns an approved/failed transition, and cannot invoke a domain effect. **Only** the `commit` mode's authorized server gateway may call the allowlisted effect executor after tenant, approval, payload, context/source/policy and idempotency checks; it accepts no model-issued consent or executable parameters. Registering a new domain supplies its own typed schemas, mode handlers and canonical effect contract without editing the central router. Startup, dispatcher, strict Zod output and negative tests must enforce these fences (not just prompt instructions). Implementations use Zod-inferred generics; the example is a specification, not application code. Every effect contract also supplies a safe preview renderer, authorization policy, compensation/rollback classification, deterministic idempotency key and postcondition verifier.

Registry startup checks: unique ID+major version; **compiled typed union** has one of six legal descriptor/result discriminants with no erased generic executor, no cross-mode callbacks or executable proposal in read/simulate/evaluate outputs; valid strict bounded input/output Zod schemas; no orphan dependencies, cycles or conflicting owners of a canonical effect; registered metric names exist and **all allowed purposes map exhaustively to registered source reader/selector contracts, strict output schemas/unit/number validators and bounded queries**; every registered **analysis** has a matched existing typed read/simulate/evaluate capability, strict I/O schemas, scope/policy/source/coverage and finite budgets, verified registry/CI without central branches; every propose/commit effect contract resolves a known strict canonical payload schema, preview renderer and commit-only executor; approval/commit policy key exists and is default-deny; budget class is present; no changed legacy tool name without explicit compatibility adapter. Disabled or unimplemented descriptors may be discoverable **as unavailable**, never callable as if active. Registrations return structured metadata, **not** arbitrary owner-controlled function code.

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
| Olivia planning | Legacy schedules; merged PR #72 foundation, PR #75 staff availability UI, PR #77 deterministic scheduling optimizer (`lib/calc/scheduling/planner*`) with independent assignment validation, and PR #84 revisioned schedule-draft saving (`lib/scheduling/planDrafts.server.ts`, `20261015000064_olivia_plan_drafts.sql`) | Optimizer implementation is merged, **not** proof of production activation. Foundation and draft migrations/activation remain gated; draft saving is not owner approval or plan publication, and the Supervisor scheduling adapter is not shipped. Expose only authorized, actually activated surfaces and report unavailable otherwise |
| Inventory, waste and ordering | No verified general inventory integration or ordering flow established | Explicit unsupported/read unavailable; supplier quotes are **not stock on hand** |
| Bank/cashflow | No connected bank feed established by this review | Explicit unsupported unless a consented, implemented canonical source is verified |
| Notifications and files | Opt-in owner delivery attempts, private unanalysed chat attachments | Audit/status metadata only when authorized; extraction, worker delivery/acceptance unsupported |

**Automated coverage tests are compulsory, bidirectional and CI-blocking.** Maintain a source-surface manifest checked against independently enumerated exported public readers, model-visible Supervisor readers, canonical analytics/viewmodels and domain capability exports. **All registered metrics require both strict query AND value/full-output Zod schemas, units/kind and cross-field quality validators; all registered analyses require their own ID/version/I/O/policy/source-budget entry bound to an existing typed non-effectful capability.** CI must fail when a supported field/metric/entity/analysis/export is introduced, renamed or removed without a registered authorized path or a reviewed restricted/unsupported mapping. Reverse tests fail stale catalog entries, dangling handler IDs, missing schemas/policies and “available” capabilities with no real implementation. Check declared granularity/dimensions/periods and no raw SQL/automatic database introspection. Test discover → role/tenant authorization → bounded read → evidence validation → denial/unavailable with synthetic no-POS, incomplete-sales, cross-café and sensitive-staff fixtures. **The P1 comprehensive inventory and tests are future work; this documentation does not claim they have run.**

### 5.1 Catalog contract

Each metric is a first-class server-owned definition; metric IDs are stable and versioned independently of display names. Exact fields:

~~~ts
type MetricQuery<F,P extends string> = {
  metricId:string; period?:{from:string;to:string};
  granularity:"instant"|"hour"|"day"|"week"|"month";
  dimensions:Readonly<Record<string,readonly string[]>>; // validated allowlist
  filters:F; purpose:P; // strict registered per-metric purpose/filter types
};
// Trusted numeric/value validators, shared by all metric definitions:
// money: z.number().int().safe() in USD integer cents (never float dollars);
// other numeric values: finite numbers; counts/minutes must be safe integers;
// ratios: finite, with domain-specific allowed bounds; booleans are boolean.
// Series use STRICT point objects, a bounded nonempty/empty-verified array,
// ordered disjoint bucket windows and the SAME audited scalar validators.
type MetricCoverage = {
  state:"complete"|"partial"|"unknown";
  observed:number|null; expected:number|null; // finite safe nonnegative counts
  missingKeys:readonly string[]; truncated:boolean;
};
type MetricSeriesPointBase = {
  bucket:{from:string;to:string;timezone:string};
  dimensions:Readonly<Record<string,string>>;
  completeness:MetricCoverage;
  provenance:readonly SourceRef[];
};
type MetricSeriesPoint<S> = MetricSeriesPointBase & (
  | {status:"verified"|"estimated"|"partial";value:S}
  | {status:"unavailable";value:null}
); // null ONLY when unavailable, never a disguised zero
type MetricValueContract<V> =
  | {valueKind:"money_cents"; unit:"USD_cents";
     valueSchema:ZodSchema<V>; seriesPointKind?:never}
  | {valueKind:"integer"; unit:"count"|"unit_count";
     valueSchema:ZodSchema<V>; seriesPointKind?:never}
  | {valueKind:"decimal_ratio"; unit:"ratio";
     valueSchema:ZodSchema<V>; seriesPointKind?:never}
  | {valueKind:"duration_minutes"; unit:"minutes";
     valueSchema:ZodSchema<V>; seriesPointKind?:never}
  | {valueKind:"boolean"; unit:"boolean";
     valueSchema:ZodSchema<V>; seriesPointKind?:never}
  | {valueKind:"series"; unit:"USD_cents"|"count"|"unit_count"|
        "ratio"|"minutes"|"boolean";
     seriesPointKind:"money_cents"|"integer"|"decimal_ratio"|
        "duration_minutes"|"boolean";
     pointSchema:ZodSchema<MetricSeriesPoint<number|boolean>>;
     valueSchema:ZodSchema<V>};
// Each constructor additionally checks runtime scalar kind, point kind,
// exact unit agreement and audited safe numeric validation (no coercion).
type MetricResultBase<F,P extends string> = {
  metricId:string; definitionVersion:1; query:MetricQuery<F,P>;
  unit:string; actuality:"actual"|"estimated"|"forecast"|"planned"|"unknown";
  completeness:MetricCoverage;
  freshness:{asOf:string|null; capturedAt:string|null; stale:boolean|null};
  provenance:readonly SourceRef[]; assumptions:readonly string[];
  conflicts:readonly SourceConflict[];
};
type MetricResult<F,P extends string,V> =
  | (MetricResultBase<F,P> & {
      status:"verified"|"estimated"|"partial";
      value:NonNullable<V>; unavailableReason:null;
    })
  | {
      metricId:string; definitionVersion:1;
      status:"unavailable"|"insufficient_evidence"|"conflict"|
        "failed"|"requires_approval";
      value:null; unavailableReason:string; // safe error code
      // No private source refs, query, period, unit, exact coverage or amounts
      query?:never; unit?:never; actuality?:never; completeness?:never;
      freshness?:never; provenance?:never; assumptions?:never;
      conflicts?:never;
    }; // strict state-discriminated runtime schema
type MetricDefinition<F,P extends string,V> = {
  id:string; version:1;
  owner:"money"|"sales"|"staff"|"pricing"|"supplies"|string;
  localizedLabelKey:string; descriptionKey:string;
  valueContract:MetricValueContract<V>; // runtime kind+unit+value validators
  outputSchema:ZodSchema<MetricResult<F,P,V>>; // STRICT entire result envelope
  querySchema:ZodSchema<MetricQuery<F,P>>; // strict full request schema
  filterSchema:ZodSchema<F>; // strict per metric; rejects unknown keys and values
  dimensionSchema:ZodSchema<MetricQuery<F,P>["dimensions"]>;
  allowedPurposes:readonly P[];
  allowedDimensions:readonly string[];
  allowedGranularities:readonly MetricQuery<F,P>["granularity"][];
  supportedPeriods:"instant"|"bounded_date_range"|"all_time";
  temporalBasis:"business_local"|"location_local"|"utc_instant";
  availabilityRequires:readonly string[];
  sourceSelectionRequirements:Readonly<Record<P,{
    canonicalReaderId:string; readerContractVersion:number;
    selectorContractId:string; selectorContractVersion:number;
    sourcePurpose:string;
    precedencePolicyId:string; precedencePolicyRevision:number;
    minCoverage:"complete"|"partial_explicit";
    requiredSourceStatuses:readonly SourceRef["status"][];
  }>>;
  sensitivity:"normal"|"staff"|"financial";
  accessPolicy:string; // tenant+role+location+purpose+field, default deny
  queryLimits:{
    maxRangeDays:number|null; maxRows:number; maxSeriesPoints:number;
    maxDimensionCount:number; maxValuesPerDimension:number;
    maxFilterDepth:number; timeoutMs:number; maxReadCalls:number;
  };
  expectedFreshnessSeconds:number|null;
  aggregationPolicy:"from_canonical_calc"|"sum_validated_parts"|"not_aggregatable";
  canonicalReader:string; // server-owned, no model SQL
};
~~~

**Strict metric output boundary (P1 implementation gate):** Every metric's code-reviewed `valueContract` and `outputSchema` are mandatory and **validated server-side on the actual canonical reader return, before caching, result aggregation, cross-domain analysis or the grounded Supervisor writer**. The trusted registry validator cross-checks metric ID/version, original *validated* query, exact registered unit/value kind, status/actuality, period/timezone/dimensions, source purpose and source manifest, provenance references/tenant, conflicts, freshness, completeness and bounded size; rejects unknown result keys and incompatible numeric/series types. All money points and totals use `Number.isSafeInteger` integer **USD cents**, not floats or dollar-formatted strings; counts/duration use finite safe nonnegative integers where appropriate; other numeric results must satisfy `Number.isFinite`, domain-specific bounds and unit checks. For ratios never average percentages across groups/time: compute with canonical `lib/calc/` numerators and denominators. `NaN`, `Infinity`, unsafe integers, fractional cents, boolean/number swaps, unauthorized dimensions, wrong or mixed units, stale/invalid source refs, malformed ISO times or unbounded series are validation failures, **not** partial successful numbers.

**Strict series semantics:** `valueKind:"series"` declares exactly one audited `seriesPointKind`, stable compatible unit, a strict `pointSchema` and a strict full-array `valueSchema` composed from verified per-point scalar and coverage schemas; trusted schema builders reject contradictory point kind/unit combinations. Each bucket has bounded, ordered, non-overlapping and correctly time-zoned dates at the **registered granularity**, finite/typed values, authorized dimensions, coverage, actual-vs-planned status and attributable source refs; duplicate bucket+dimension identities or mixed-units fail. Per-point `null` is legal **only** for explicitly unavailable points, not treated as zero. An empty complete series is verified zero/empty **only** with complete-window evidence; no source or incomplete coverage returns unavailable/partial, never fabricated empty success. Enforce max points/dimensions/bytes plus row/range/cost limits.

**Status/provenance invariants:** `verified` requires complete applicable coverage with no material source conflict, real support for the claimed value and provenance (including verified complete-zero/absence proof); `estimated`/`planned` remain explicitly labeled in actuality and assumption fields; a `partial` numeric/series result can expose **only** the observed, proven subtotal and exact missing coverage; `unavailable`, denied, conflict, insufficient-evidence, failed and requires-approval states require `value:null` and a safe reason code. Missing provenance, unknown freshness or incomplete denominator never becomes verified by arithmetic. A reader failure or malformed output is **quarantined as a typed unavailable/invalid-result error without returning the bad value, private provenance, query selectors or sensitive records**, separately audited server-side; no fallback coercion to zero, numeric rounding, schema stripping or model repair. Authorized role/source restrictions also apply on output. TypeScript contracts and **runtime strict Zod tests** must enforce this for every registered metric and synthetic fifth domain; this documentation does not execute those tests.

Catalog discovery is two operations: **list permitted definitions** (small metadata only) and **query selected metric IDs with bounded arguments**. The dispatcher enforces **two mandatory independent validation gates**: before any reader, strict per-metric request validation; **after** a reader, strict per-metric `outputSchema` and `valueContract` validation before any owner-visible, cached, analytical or merged result. Before **any** canonical reader or source selector runs, the dispatcher must (1) resolve the authenticated business/actor/locations server-side, (2) find that exact registered metric ID+version or deny, (3) validate the *entire* query via its metric-owned **strict Zod `querySchema`, `filterSchema` and `dimensionSchema`**, (4) enforce its `allowedPurposes`, dimensions, granularity, unit/period/temporal basis, allowlisted source statuses and source-selection contract/version for that purpose, (5) enforce tenant/role/sensitivity authorization and all **range, row, cardinality, series, depth, timeout and read-call limits**, and **only then** call the trusted reader with typed parsed input. Unrecognized or extra filters, arbitrary purposes, unsupported hourly/dimension requests, unknown metric versions and privilege-sensitive dimensions are rejected, not forwarded as unknown values. The server builds the catalog from domain registration exports and tests per-metric source purpose+selector mappings; neither the dispatcher nor central goal/router requires specialist-specific conditional branches or a generic catch-all filter parser. The owner may learn which definitions are allowed while missing integrations return explicit unavailable. No schema exploration, free-form table names, REST endpoint composition, unrestricted SQL/GraphQL or raw arbitrary values from an LLM. Preserve source RLS, row/column sensitivity and bounded pagination; staff aggregates do **not** authorize named-person wage reads. On return, recheck exact result `metricId`/definition version, accepted query fingerprint, output status/provenance/coverage/period, trusted **metric-specific unit/value-kind schema** and bounded series; fail closed as an explicit invalid-result/unavailable answer instead of forwarding malformed money, totals or staff measurements.

**Metric registration and source-selection invariants (future P1 gate):** each registered metric's output is **also** a mandatory full-envelope strict schema, not an unchecked union of `number|boolean|unknown[]`; a missing/incompatible schema must make registration fail. A metric's input contract is not just a display label or generic `Record<string, unknown>`: a strict, domain-exported query schema must parse **purpose, filters, dimension values, granularity, dates and bounds** together, and its `sourceSelectionRequirements` must contain an **exhaustive purpose-keyed mapping** to the correct versioned reader, selector, precedence policy, coverage and permitted source states. The domain module owns schema, allowed purpose/source-selection table and canonical reader mapping; registry startup/CI rejects missing, unreachable, inconsistent or unbounded definitions. One metric can have a narrow purpose such as `payroll_actual` yet reject `schedule_forecast`; a second purpose must declare its source-selection and temporal/quality rules explicitly. Purpose cannot be obtained by reinterpreting an arbitrary model string. Selector versions are pinned to the returned `CanonicalSourceRevisionRef` manifest (§7). Query normalization and caching must bind metric version, validated arguments, authorized tenant/location, period/timezone and selected purpose to avoid cross-purpose or cross-tenant leakage. Every unsupported dimensionality/purpose returns a typed denial/unavailable result, never inferred data or a zero. Validate 5th-domain registration without platform core changes and exercise negative security limits in P1 CI.

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

### 5.2a Distinct registered metric, entity and analysis access

A **metric query** returns typed measures/series with unit, period, time zone, dimensionality, actual/estimated status and safe aggregation. An **entity read** returns a strictly selected, bounded projection of existing business records/relationships/revisions: people, recipes, bills, quotes, tasks, source details or plans. A registered **analysis** evaluates source-specific scenarios or recommendations using those readers and canonical pure functions. The shared registry discovers **three distinct typed access contracts**, not an unrestricted “ask the database” query:

~~~ts
type EntityReadDefinition<TInput,TOutput> = {
  id: string; version: 1; entityType: string; domainOwner: string;
  inputSchema: ZodSchema<TInput>; outputSchema: ZodSchema<TOutput>;
  policyKey: string; sensitivity: "normal"|"staff"|"financial";
  allowedFields: readonly string[]; allowedRelations: readonly string[];
  maxRows: number; maxDepth: number; purpose: string; handlerId: string;
  // Required for any entity reader exposed as a P3 composition operand.
  // A literal purpose maps to an explicit registered, versioned reader/selector
  // and precedence/coverage/actuality policy; never a model-selected source.
  sourceSelectionRequirements?: Readonly<{
    readerId:string; readerVersion:number;
    selectorId:string; selectorVersion:number;
    precedencePolicyId:string; precedencePolicyRevision:number;
    minimumCoverage:"complete"|"partial_explicit";
    allowedActualities:readonly ("actual"|"estimated"|"forecast"|"planned")[];
    allowedEvidenceStatuses:readonly ("verified"|"reported"|"unverified")[];
    // Evidence verification and temporal actuality are separate dimensions.
    // Reported quotes are usable only as explicitly conditional assumptions,
    // never as verified paid supplier costs or inventory.
  }>;
};
type EntityReadResult<T> =
  | {status:"verified"|"partial";
      records:readonly T[]; truncated:boolean; nextCursor:string|null;
      evidence:readonly SourceRef[]; missingInputs:readonly string[]}
  | {status:"unavailable"|"insufficient_evidence";
      reasonCode:string; missingInputs:readonly string[];
      records?:never; evidence?:never; nextCursor?:never; truncated?:never};
// Strict Zod runtime union: unsuccessful reads expose NO record or source data.

// Analyses are distinct catalog surfaces, but their I/O types come from a
// CONCRETE LITERAL KEY of the compiled, server-reviewed capability registry.
// No independent I/O generics or arbitrary string ID may widen the binding.
type AnalysisMode = "read"|"simulate"|"evaluate";
type CapabilityRegistry = typeof compiledCapabilityRegistry;
type AnalysisCapabilityKey = {
  [K in keyof CapabilityRegistry]:
    CapabilityRegistry[K]["mode"] extends AnalysisMode ? K : never
}[keyof CapabilityRegistry];
type AnalysisCapability<K extends AnalysisCapabilityKey> = CapabilityRegistry[K];
type AnalysisResult<K extends AnalysisCapabilityKey> =
  z.infer<AnalysisCapability<K>["outputSchema"]>;
// A purpose either has explicit, versioned real-source dependencies, OR
// explicitly certifies that all inputs are self-contained validated arguments.
type AnalysisSourceInput = {
  metricIds:readonly string[]; entityReadIds:readonly string[];
  readerId:string; readerVersion:number;
  selectorId:string; selectorVersion:number;
  precedencePolicyId:string; precedencePolicyRevision:number;
  sourcePurpose:string;
  minimumCoverage:"complete"|"partial_explicit";
  allowedActualities:readonly ("actual"|"estimated"|"forecast"|"planned")[];
  allowedEvidenceStatuses:readonly ("verified"|"reported"|"unverified")[];
};
type AnalysisSourceRequirements =
  | {kind:"registered_sources";
      inputs:readonly [AnalysisSourceInput,...AnalysisSourceInput[]];
      minimumOverallCoverage:"complete"|"partial_explicit";}
  | {kind:"preauthorized_operands";
      // Pure evaluator makes no new reads, but receives verified café evidence.
      // Each leaf is resolved by its own registered reader/source contract.
      operandManifestSchemaVersion:1;
      minimumOperands:1;
      requireSourceRefs:true;
      requireExactLeafPolicyAndRevision:true;
      minimumOverallCoverage:"complete"|"partial_explicit";}
  | {kind:"no_external_sources";
      inputs:readonly [];
      justification:"pure_validated_input_only";
      minimumOverallCoverage:"not_applicable";};
// Both schema refs are the SAME typed schemas as bound capability K; runtime
// requires the SAME immutable contract id/version AND exact schema fingerprints.
type AnalysisInvocation<K extends AnalysisCapabilityKey,P extends string> = Readonly<{
  analysisId:string; analysisVersion:1;
  boundCapabilityKey:K; selectedPurpose:P; // strict server-validated discriminator
  input:Readonly<z.infer<AnalysisCapability<K>["inputSchema"]>>;
}>; // server-issued, tenant/actor resolved separately; no LLM authority
type AnalysisDefinition<K extends AnalysisCapabilityKey,P extends string> = {
  kind:"analysis"; id:string; version:1;
  domainOwner:AgentId; titleKey:string; descriptionKey:string;
  boundCapabilityKey:K; // literal registered key, never a free string
  boundCapabilityVersion:AnalysisCapability<K>["version"];
  boundCapabilityMode:AnalysisCapability<K>["mode"];
  schemaContract:AnalysisCapability<K>["schemaContract"];
  inputSchema:AnalysisCapability<K>["inputSchema"];
  outputSchema:AnalysisCapability<K>["outputSchema"];
  allowedPurposes:readonly [P,...P[]]; // nonempty strict literal union; no duplicates
  invocationSchema:ZodSchema<AnalysisInvocation<K,P>>;
  // selectedPurpose is in EVERY invocation; strict schema validates against
  // this literal allowedPurposes set, key/version and bound input schema.
  sourceRequirementsByPurpose:Readonly<Record<P,AnalysisSourceRequirements>>;
  authorization:{
    policyKey:string; requiredRole:"owner"; sensitivity:"normal"|"staff"|"financial";
    scope:"business"|"permitted_locations"|"owner_private";
    allowedFields:readonly string[]; allowedEntityTypes:readonly string[];
  };
  sourcePolicyKey:string; // provenance precedence, snapshot/time coherence
  requiresContextVersion:1; // authorized BusinessContext projection
  resourceLimits:{
    maxRangeDays:number; maxRows:number; maxSourceRefs:number;
    maxSeriesPoints:number; maxOperations:number;
    timeoutMs:number; maxResultBytes:number;
  };
  // No independent execute function: generic dispatcher invokes only K.
};
~~~

**Concrete analysis binding example (future P2 fixture, not executable in this PR):** A compiled `alex.pricing.review.v1` registration supplies a **literal registry key**, exact `inputSchema`, `outputSchema` and `schemaContract` fingerprint pair; its analysis entry may use only that key and those exact schema references. An Olivia `simulate` key, an Alex `read` key with a different `I/O` pair, or a different version/fingerprint **must fail**, even when IDs/modes look plausible. The reviewed build-time `defineAnalysis<K,P>()` factory derives input/output/mode schema types from `compiledCapabilityRegistry[K]`; runtime startup independently compares registered key, version and schema-contract fingerprints and rejects changes to semantic refinements under the same contract version. For example, a purpose union declared `as const` requires `sourceRequirementsByPurpose` to `satisfies Record<(typeof allowedPurposes)[number],AnalysisSourceRequirements>` and startup enforces **exact** object keys and a nonempty purpose set; this does not silently widen `P` to `string`.

**Analysis registration and dispatch (mandatory P1/P2 gate):** Every analysis is a checked-in `AnalysisDefinition<K,P>`, where `K` is a **literal, concrete key** of the compiled capability registry and its input, output, mode and schema-contract identity are **derived from that exact entry**. Only registered read/simulate/evaluate keys are allowed; no independent generic `I/O`, string-only IDs or schema adapters can assert compatibility. The bound capability and analysis must reference the **same reviewed input/output schemas** by exact `schemaContract.id`, version and deterministic input/output fingerprints (and concrete registered schema references), not merely shapes that appear similar. At build/startup compare registry key/version/mode, schema identity and canonical schema fingerprints; reject absent keys, retired versions, mismatched or unverifiable fingerprints, incompatible types and extra/unknown keys; do not silently substitute another handler or accept inferred subtype casts. Changing a schema meaning requires a new contract version and reviewed registry export.

**Selected-purpose execution and exhaustive per-purpose source policy:** The dispatcher MUST parse a concrete `AnalysisInvocation<K,P>` with the registered **strict `invocationSchema` before calling any prerequisite**, validating `analysisId/version`, literal `boundCapabilityKey`, **`selectedPurpose:P`** and bound `inputSchema`. It obtains the **single** `sourceRequirementsByPurpose[parsed.selectedPurpose]` and authorizes its matching reader, actuality, selector version, source policy, coverage requirements and budgets; the server stores an immutable validated invocation snapshot (deep-frozen/immutable serialized original) with selected purpose and normalized arguments in its evidence/context request fingerprint and analysis audit; it validates the same original snapshot at dispatch and never rereads mutable request-object fields. No other purpose's policy can be used as a fallback, and the classifier's free text, request URL or goal label is not a trusted selector. If purpose is missing/unknown, contradicts bound parameters/source coverage, or changes between validation and dispatch, fail closed before the reader with sanitized unavailable/clarification. A source-free purpose still requires a validated selectedPurpose and its explicit `no_external_sources` branch. A `preauthorized_operands` purpose is **not source-free**: it permits no new evaluator reads but requires immutable, source-qualified operand envelopes whose independently authorized leaf reader/selector/purpose/coverage/version manifests are verified against the invocation snapshot before calculation. Its registered purpose and strict operand-envelope schema are checked at startup and dispatch; missing, forged, stale or cross-tenant source refs fail closed. `allowedPurposes` must be nonempty, unique and an explicit literal purpose union; `sourceRequirementsByPurpose` must have **exactly one own-key entry per allowed purpose**, no missing or extra keys, validated both with strict registration-time Zod and checked-in compile-time `satisfies`/exact-key tests. Each `registered_sources` entry requires a nonempty typed source list with registered metric/entity prerequisites, canonical reader/selector/version, source purpose/precedence policy/version, permitted actuality and minimum coverage; all must be tenant/role scoped and provenance-audited before executing or publishing results. `preauthorized_operands` is a distinct registered case for previously authorized source-bearing inputs and MUST pass ANALYSIS-08 negative tests for source provenance, scope, purpose, freshness and coverage. `no_external_sources` is a separate explicit, validated, **empty** source-list case for a calculation based **only** on fully validated input arguments; it may not claim verified café facts or backfill absent data. Reject undeclared source reads, missing or extra purposes, unsupported reader versions, incomplete required coverage, incorrect actuality or unknown provenance; a source-free contract cannot implicitly depend on external data. Authorize business/location/owner-private scope and resource budgets per analysis and purpose before the matched typed capability is invoked. Validate strict mode/result evidence after execution, including any prerequisite metric's output; return an appropriately sanitized unavailable/partial result for unsupported/no-POS/denied/conflicting inputs. Read/simulate/evaluate analyses cannot create proposals, tasks or domain effects; recommendations require the existing separate propose/approve/commit gates. Adding Olivia, Alex, Maya, Leo or a fifth specialist changes only its reviewed registry/catalog module, not central routing.

**Extensibility examples (contracted, not active features):** Alex price review/recipe margin comparison registers a read analysis backed by canonical pricing and `lib/calc/`; Olivia coverage-vs-cost what-if is a `simulate` analysis after domain readiness; Maya unit-normalized supplier-quote comparison is a read analysis with explicitly unverified quote provenance; Leo matched-period profit-cost comparison is a read analysis with complete numerator/denominator coverage, not a bank-feed assumption. A synthetic **fifth** specialist registers the same analysis and bound capability exports, tests and localization only, **without a central Supervisor analysis switch, metric exception or LLM SQL**. Unsupported/no-POS/denied/conflicting/stale inputs return a typed `unavailable`/`partial`/`insufficient_evidence` result with missingInputs/assumptions and no invented output; derived money remains `lib/calc/` canonical. Entity-read handlers likewise bind café/user/location/purpose, validate filters and resource caps, apply RLS and allowlist fields and relationships. Never expose a generic SQL editor, unrestricted SELECT, arbitrary joins, free-form table names, schema exploration or all-employees/all-records dumping. Record permissions do **not** follow automatically from metric permission; e.g., labor total does not authorize every staff wage. Restricted surfaces remain explicit in the coverage manifest.

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
  snapshot: {asOf:string; fingerprint:string;
    sourceRefs:readonly CanonicalSourceRevisionRef[]}; // full canonical source selection set
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

Illustrative strict **per-key registry** declaration (proposed contract, not deployed code):

~~~ts
const preferenceDefinitions = {
  "supervisor.digest_cadence.v1": {
    schemaVersion: 1,
    scope: "owner_private", sensitivity: "normal",
    allowedDomains: ["supervisor"],
    valueSchema: z.enum(["daily","weekly","off"]),
  },
  "olivia.owner_preferred_weekly_minutes.v1": {
    schemaVersion: 1,
    scope: "owner_private", sensitivity: "staff",
    allowedDomains: ["olivia"],
    valueSchema: z.number().int().min(0).max(10080),
  },
} as const;
// `key + schemaVersion` selects the only valid type; no general text/value field.
type PreferenceKey = keyof typeof preferenceDefinitions;
type PreferenceFor<K extends PreferenceKey> = {
  key:K; schemaVersion:(typeof preferenceDefinitions)[K]["schemaVersion"];
  recordRevision:number;
  value:z.infer<(typeof preferenceDefinitions)[K]["valueSchema"]>;
  confirmedBy:string; confirmedAt:string; effectiveUntil:string|null;
  source:SourceRef;
};
type ConfirmedPreference =
  { [K in PreferenceKey]:PreferenceFor<K> }[PreferenceKey];
~~~

**Intentional free-text owner/AI Team instructions are `untrusted_guidance`**, stored/retrieved separately from typed preferences, clearly labeled source and owner, bounded/sanitized and treated as *data* with prompt-injection defenses. They cannot change priority of canonical records, approval gates, permissions, workflow checks or the type registry. Owner confirmation establishes provenance, **not safety of arbitrary prose**. Strictly typed objectives also require reviewed metric/target/unit/period validation and revisions; unknown targets remain unsupported, not operator commands.

**Fingerprint semantics:** `snapshot.fingerprint` is a deterministic, tenant-scoped hash of the **complete canonical `snapshot.sourceRefs` source-selection/revision manifest** (including selected and proven-absent dependencies), not a substitute for storing that manifest. The exact material `sourceRefs` must also be persisted in each immutable `ActionProposal` and **copied unchanged into every successful typed approval** (§7). The separate `contextFingerprint` hashes the **canonical ordered, scope-bound material projection actually used for the proposed effect** (business, location, relevant owner scope, each referenced preference ID+definition version+record revision+validated value hash or explicit absence/revocation, objective revision/value hash, guidance rule ID/version+content hash, workflow ID/revision/decision state, and all applied policy/delegation IDs+revisions/expiry/constraints). Include a complete `contextRevisionRefs` manifest of *material* inputs used so additions/revocations/changed defaults cannot evade stale checks; if complete dependency tracking cannot be proved, conservatively fingerprint the full authorized active projection for that action. Context and policy fingerprints are **server-generated from trusted stores** with deterministic canonical serialization, not LLM text, and never expose sensitive raw values in logs/owner-visible tokens. Persist **both** the exact source revision manifest and source hash, plus the context fingerprint and material context/policy references, with every proposal/approved artifact. At approval and immediately before commit, rerun the same registered canonical source selectors with the original selection policies/time windows and revalidate **every** original source ID/revision and the full selected set (including additions, deletions, superseded sources, precedence swaps and confirmed absences), as well as the context/policy projection; **any material changed, missing, revoked, expired or schema-invalid revision means conflict/repropose/reapprove**, not silent refresh or stale execution. Irrelevant context changes can be excluded only with an auditable dependency manifest verified by the domain. Revoked authority always blocks effect.

Owner-confirmed personal working preferences, business operating objectives and active approved rules have **distinct provenance and authority**. Confirm/update/revoke owner preferences and business objectives explicitly with actor/version/effective dates; unconfirmed chat or inferred “memory” cannot silently become a fact. Keep an individual's private preferences and threads inaccessible to co-owners, while café-shared objectives require their separately reviewed update/override semantics. Approved Team guidance is *quoted data*, **never** business-effect consent, an authorization rule or precedence over actual evidence. Domain adapters request only the least context needed. Resolve conflicting values through source-purpose rules and targeted confirmation; pin source and context revisions to proposals, revalidate before execution, and reject stale authority. Do not persist broad raw model transcripts, sensitive employee records or third-party tokens in shared context.

### 6.1 Bounded multi-domain delegation

The Supervisor is a **bounded coordinator**, not the universal owner of every domain calculation or intent parser.

1. **Resolve trusted scope:** existing authenticated owner + selected café, locale, timezone; never read the business ID, user role, approver or allowed capabilities from model arguments.
2. **Capture goals:** semantically parse one or more requested outcomes (read, compare, simulate, propose, approve, commit); approve must resolve a **previously persisted exact server-side proposal**, not an LLM-created generic goal. Preserve all independent clauses and dates. Preserve existing Phase 4–later semantic request goals through a compatibility adapter. Reject unsupported commands rather than hallucinate a tool.
3. **Discover and match:** select only enabled, role-allowed capability descriptors and metric definitions. Source availability is evaluated at execution; a known capability may still be unavailable. Return explicit unhandled goals for every unsupported clause.
4. **Build a constrained DAG:** prerequisites from registry, max depth, fanout and duplicate canonical reads. Plan two-domain requests using stable dependency IDs. Never let a specialist directly invoke an unregistered sibling, mutate another domain or change shared Supervisor instructions.
5. **Run read/preview steps:** bounded parallel read-only operations, caching only within the authorized request/snapshot. Domain read failures are isolated; budget oversubscription produces per-goal budget-exhausted/unavailable outcomes, not silent dropped intents.
6. **Aggregate verified results:** the server validates each capability schema, source coverage, value provenance, period and consistency; any cross-domain conclusion must call a reviewed deterministic function or offer separate facts without claiming a calculated causal relationship.
7. **Choose action path:** `read` and `simulate` supply no-effect facts/what-ifs; simulation is **not** a draft or approval. Persist an inert `propose` artifact only on explicit request, binding the complete typed **`sourceRefs` canonical revision manifest** alongside `sourceSnapshotHash`, exact `proposedEffectHash`, BusinessContext fingerprint and policy versions; a separate **typed `approve` transition** checks authenticated actor and original source/target/context/policy revisions, **copies `sourceRefs → approvedSourceRefs` and identical `proposedEffectHash → approvedEffectHash`** and creates a durable approval record **without executing**. The `commit` path validates both immutable source manifests and the entire context/policy binding before atomically consuming that approval/proposal once and invokes the distinct authorized domain executor (§§8–9). NEVER execute a mutation by selecting an LLM tool.
8. **Present:** adapt verified results to existing strict grounded reply blocks. Preserve current finance/sales/staff/pricing semantics and stable task links, and show attributed Olivia/Alex/Maya/Leo content inside the **same** Supervisor conversation.

**Snapshot coherence:** Cross-domain what-if comparisons use a referenced immutable input set or captured source revisions/as-of times. If one teammate sees a changed price/wage/schedule revision mid-plan, show a conflict/recompute instead of mixing stale numbers. Dependencies may degrade independently: "labor unavailable; observed sales available" is better than a false combined profit answer.

**Model trust boundary:** prompts and owner rules are untrusted interpretation hints, never data readers or grants. Any free-form attachment/search snippet/supplier quote may contain prompt injection; sanitize display and ignore embedded instructions. Parse model tool arguments through strict schemas; resolve entity IDs server-side with ambiguity checks. The model selects among server-issued IDs/approved phrases; it does not author business math, arbitrary URLs or final proof of completion. Provider absence, timeout or malformed JSON triggers deterministic safe fallback where available.

### 6.2 Mandatory P3: AI-composed, bounded novel what-if calculations

**Product acceptance:** OpenAI must answer safe café *calculation requests that were not individually programmed*, by selecting authorized evidence and composing reviewed arithmetic/domain primitives. A registry containing only named finished reports does not meet this requirement. The owner should not need to pick an agent, know a formula name, upload Excel, or ask only predefined questions. Example questions below are *generality tests*, not a closed supported-intent list.

**Required actual P3 implementation (not just interfaces):**
1. **Reasoning and planning:** AI interprets unknown natural-language goals, including all clauses of a mixed request, and emits an **untrusted strictly typed, bounded calculation plan** (`AnalysisPlan` declarative IR/AST or equivalent). The plan refers only to registered capability IDs/versions/purposes, server-issued authorized source handles, vetted primitive/operator IDs, labeled owner-supplied hypothetical operands, and explicit desired units/periods. It cannot pick database tables, generate SQL, shell, JavaScript, arbitrary code, external URLs or any business-effect operation. No keyword/intent branch for every example.
2. **Exactly bound, safe expression evaluator:** Register a **concrete, versioned `simulate` capability** (for example, `platform.scenario.expression.v1`) in the same compiled six-mode registry, with strict input/output Zod schemas, literal key, reviewed schema-contract fingerprint, exact source-purpose requirements, permission scopes and resource limits. The reusable evaluator is the **private, pure implementation of this registered capability**, **not a new generic executor**, not an unregistered dynamic analysis and not an exception to §§4–5/15.6–15.7. Any `AnalysisDefinition<K,P>` that exposes this function must bind to **exactly that pre-existing compiled capability key `K` and its I/O/mode/contracts**, like every other analysis; multiple requested formulas are input instances of the same vetted capability, not new analysis IDs at runtime. The trusted dispatcher validates the complete AST and exact key/version/purpose, tenant/role/field/source selector, revisions, depth/fanout/time budget, numeric range, zero division, money cents/rounding, dimensions/currency and period compatibility **before unauthorized reads or computation**. Allowed primitives include reviewed addition/subtraction, dimensional multiplication/division, ratios/percentages, US gallon↔US fluid ounce and minutes↔hours conversions, comparisons and scenario deltas. Each new primitive is reviewed/registered with tests; no arbitrary `eval`, SQL/JS, model-created capabilities or privileges. Reuse canonical `lib/calc/` for payroll, labor cost, recipes, pricing/profit and scheduling feasibility; the model chooses allowed operations but never supplies authoritative results.
3. **Source-bound operand contract:** The expression capability accepts **only provenance-bearing, previously authorized operand envelopes** (or server-issued immutable operand handles resolving to them), never raw model-provided café facts or arbitrary reader identifiers. The trusted orchestrator independently invokes each leaf's concrete registered metric/entity capability with its exact declared purpose and its **own typed source contract** before constructing the expression invocation; metrics use their required `sourceSelectionRequirements`; entity leaves used in composition MUST define `sourceSelectionRequirements` for their fixed `purpose` (legacy entity readers without this versioned mapping are unavailable as composition operands until upgraded); analysis leaves use `sourceRequirementsByPurpose[selectedPurpose]`. It validates each leaf's tenant/role, source selector/version, revision, coverage, actuality, period, units, output schema and budget. The expression capability declares `preauthorized_operands` for café-derived leaves: its private pure evaluator performs **zero new external reads**, but the invocation remains **source-bearing** and must validate each leaf's independently authorized source manifest, purpose, coverage, revision and tenant. The separate `no_external_sources` purpose is permitted **only** for calculations using labeled owner hypotheticals and other self-contained validated constants; it cannot claim verified café facts. The evaluator rejects absent/mismatched/stale operand provenance. Owner hypothetical constants are separately typed and labeled, never masquerading as verified records. This preserves §5.2's exact per-capability source requirements without registering arbitrary source combinations or granting dynamic reads to the expression interpreter.
4. **Grounded result:** Distinguish an owner's proposed "25 extra drinks" from observed demand, estimated from verified, and planned schedule from actual timecard. Each numerical result carries a traceable formula/primitive path, source revision and owner assumption list, compatible period/unit/currency, scenario/baseline, completeness and missing inputs; unsafe or unsupported combinations yield explicit partial/conditional/unavailable—not a fabricated verified result. No extrapolation from daily POS totals to hour-by-hour demand or from a supplier quote to actual inventory.
5. **Actual Supervisor experience:** Integrate this with the **compatibility-flagged existing Supervisor** read/simulation path in P3, not merely a mock standalone demonstrator. Keep legacy read behavior and EN/ES/AR grounded replies; preserve MAX_TOOLS/MAX_ROUNDS as the initial budget pending measured change. P2's shadow proof stays isolated. P3 never proposes, approves, commits, publishes, edits prices, sends messages or modifies domain records; P4 remains the authorized effect boundary.
6. **Completeness gate:** Implement and run COMPOSE-01..08 on real canonical readers/fixtures with mocked model plans in normal CI and optional isolated measured live OpenAI testing. If size requires separate P3A/P3B implementation PRs, **both are required** and P3 remains incomplete until a read-only owner request reaches the trusted evaluator and returns a grounded result in the actual Supervisor integration. This gate must not be silently deferred to "future AI improvements."

**Concrete examples:** For "If I sell 25 more iced lattes per day but Sophie needs 45 additional paid minutes, would it help?", assemble item price, supported marginal cost and worker's authorized loaded labor rate; evaluate a **conditional incremental contribution** with exact unit conversions and labeled demand assumption. Do not claim true net profit, known payroll burden or demand prediction without evidence. For whole/oat/almond milk costs per gallon and 12/16-oz usage, compute ingredient-option deltas from real or explicitly assumed quantities, and **do not** invent option-mix volume or aggregate losses. Paraphrases, alternate numbers and different products/workers must not require new routing code.

**Migration strategy:** keep the current supervisorRequest / supervisorFunctions / requestScope / toolRegistry / runSupervisorTurn path as a legacy adapter first. Feature-flag new discovery **in shadow mode for tests only**, compare supported intents/answers and budgets, then switch read routing behind a reviewed tenant-level rollout. Do **not** replace the existing read router in one PR. Existing MAX_TOOLS=5/MAX_ROUNDS=3 are baseline constraints to preserve initially; expansion must be bounded, cost-reviewed and explicitly tested.

## 7. Universal verified result and owner-facing action contract

Every specialist result must be machine-readable and server-validated; a textual explanation is derivative.

~~~ts
type SourceRef = {
  sourceType: string; sourceId: string; sourceRevision: string | null;
  capturedAt: string | null; effectiveFrom: string | null; effectiveTo: string | null;
  status: "actual"|"estimated"|"reported"|"planned"|"unverified"; // legacy classification, retained for compatibility
  // Separate P3 axes. Mandatory and schema-validated for composable operands;
  // older P1 source refs may omit these until a reviewed adapter enriches them.
  actuality?: "actual"|"estimated"|"forecast"|"planned";
  evidenceStatus?: "verified"|"reported"|"unverified";
};
type ComposableSourceRef = SourceRef & {
  actuality:"actual"|"estimated"|"forecast"|"planned";
  evidenceStatus:"verified"|"reported"|"unverified";
}; // no `unavailable`: unsuccessful reads have no SourceRef
// Never infer `verified` from legacy status=actual or `actual` from status=reported.
// An adapter may populate these only from independently verified source metadata;
// absent proof fails closed. Supplier quotes remain reported/unverified evidence,
// with independently established actuality and conditional-only claims.
// Typed source manifest: precise canonical source selection, not hash-only proof.
// The selector identifies the authorized canonical reader/precedence rule,
// business-local period and location used to choose the original evidence.
type NormalizedSelectorArgs = Readonly<Record<
  string, string|number|boolean|null|readonly string[]|readonly number[]
>>; // only fields allowed by this selector's strict, registered Zod schema
type CanonicalSourceSelection = {
  purpose:string; selectionKey:string; canonicalReaderId:string;
  readerContractVersion:number; // version of canonical reader's selection semantics
  selectorContractId:string; selectorContractVersion:number;
  normalizedSelectorArgs:NormalizedSelectorArgs; // validated, bounded, deterministic
  selectorArgsHash:string; // canonical serialization hash of normalizedSelectorArgs
  precedencePolicyId:string; precedencePolicyRevision:number;
  locationId:string|null; from:string|null; to:string|null;
};
type CanonicalSourceRevisionRef =
  | {kind:"selected"; businessId:string; selection:CanonicalSourceSelection;
     source:SourceRef & {sourceRevision:string}}
  | {kind:"confirmed_absent"; businessId:string; selection:CanonicalSourceSelection;
     source:null; completeCoverageRevision:string}; // verified absence, not unknown
type SourceConflict = { code:string; left:SourceRef; right:SourceRef; affectedMetrics:string[] };
// Evidence success and failure have DIFFERENT data boundaries.
// Status is the discriminator, not a decorative label. Typed output schemas
// must be strict Zod discriminated unions with cross-field refinements.
type CapabilitySuccessBase<T> = {
  capabilityId:string; contractVersion:1;
  payload:NonNullable<T>; // never null/undefined on ANY successful status
  evidence:readonly SourceRef[]; metricIds:readonly string[];
  period:{from:string;to:string;timezone:string}|null;
  warnings:readonly string[]; missingInputs:readonly string[];
  assumptions:readonly string[]; conflicts:readonly SourceConflict[];
  producedAt:string; inputFingerprint:string;
  reasonCode?:never;
};
type SuccessfulCapabilityResult<T> =
  | (CapabilitySuccessBase<T> & {status:"verified";
      completeness:"complete"; conflicts:readonly []; missingInputs:readonly []})
  | (CapabilitySuccessBase<T> & {status:"estimated";
      completeness:"complete"|"partial"})
  | (CapabilitySuccessBase<T> & {status:"partial";
      completeness:"partial"});
type UnsuccessfulCapabilityResult = {
  capabilityId:string; contractVersion:1;
  status:"unavailable"|"failed"|"conflict"|
    "insufficient_evidence"|"requires_approval";
  payload:null; reasonCode:string; // safe, registered localization code
  missingInputs:readonly string[]; // public allowlisted KEY CODES only
  producedAt:string;
  // No evidence/source IDs, raw conflicts, periods, context, private input
  // fingerprints, internal exceptions or executable data on any failure.
  evidence?:never; metricIds?:never; period?:never;
  completeness?:never; warnings?:never; assumptions?:never;
  conflicts?:never; inputFingerprint?:never;
};
type VerifiedCapabilityResult<T> =
  | SuccessfulCapabilityResult<T> | UnsuccessfulCapabilityResult;
type ReadResult<T> = VerifiedCapabilityResult<T> & {
  mode:"read"; proposal:null; effect?:never; approval?:never;
};
type SimulationResult<T> =
  | (SuccessfulCapabilityResult<T> & {
      mode:"simulate"; proposal:null; effect?:never; approval?:never;
      baselineFingerprint:string; scenarioAssumptions:readonly string[]})
  | (UnsuccessfulCapabilityResult & {
      mode:"simulate"; proposal:null; effect?:never; approval?:never;
      baselineFingerprint?:never; scenarioAssumptions?:never});
type ProposalResult<T> =
  | (SuccessfulCapabilityResult<T> & {
      mode:"propose"; state:"persisted_inert"; proposal:ActionProposal;
      effect?:never; approval?:never})
  | (UnsuccessfulCapabilityResult & {
      mode:"propose"; state:"not_created"; proposal:null;
      effect?:never; approval?:never});
type EvaluationResult<T> =
  | (SuccessfulCapabilityResult<readonly T[]> & {
      mode:"evaluate"; proposal:null; effect?:never; approval?:never})
  | (UnsuccessfulCapabilityResult & {
      mode:"evaluate"; proposal:null; effect?:never; approval?:never});
// Successful evaluator payload = strictly typed readonly findings;
// a failure contains NO findings, proposal or other executable content.
// Task creation remains a separate authorized reconciler, never evaluate.
type ApproveResult = {mode:"approve"; transition:ApprovalTransitionResult;
  proposal?:never; effect?:never};
type CommitResult = {mode:"commit"; outcome:VerifiedActionOutcome;
  proposal?:never; approval?:never};

// The build-time typed effect registry is composed from reviewed domain exports.
// Each compiled entry carries {version, parametersSchema, canonicalizer,
// safePreviewRenderer, policyKey, commitOnlyHandlerId, verifier}.
// The generated manifest is a *future implementation artifact*, not a file
// created by this documentation PR. New domains extend this typed map.
type RegisteredEffectRegistry = typeof compiledEffectRegistry; // future manifest
type EffectContractKey = keyof RegisteredEffectRegistry;
type CanonicalEffectPayload<K extends EffectContractKey> = {
  effectContractKey:K;
  effectContractVersion:RegisteredEffectRegistry[K]["version"];
  businessId:string; capabilityId:string; capabilityVersion:number;
  actionType:string; tenantScopedTargetId:string; baseRevision:string;
  parameters:z.infer<RegisteredEffectRegistry[K]["parametersSchema"]>;
};
type AnyCanonicalEffectPayload =
  { [K in EffectContractKey]:CanonicalEffectPayload<K> }[EffectContractKey];
// Example *future only*: Alex price set has a product ID, exact new USD cents,
// effective timestamp and expected product revision validated by its domain
// Zod schema; Olivia schedule publish has the exact immutable assignments or
// a content-addressed, verified immutable assignment blob + policy version.
// Neither example grants any product, POS or worker write today.
type SafeEffectPreview = {
  summaryKey:string; localizedArgKeys:readonly string[];
  displayedEffectHash:string; // trusted renderer from canonical payload bytes
  expectedImpact:string|null; // grounded, typed and evidence-backed
};
type ActionProposal = {
  businessId:string; proposalId:string; proposalRevision:number; // immutable
  actionType:string; capabilityId:string; capabilityVersion:number;
  tenantScopedTargetId:string; baseRevision:string;
  canonicalEffectPayload:AnyCanonicalEffectPayload; // immutable exact operation
  proposedEffectHash:string; // hash of canonical payload, NOT preview
  sourceSnapshotHash:string; // entire canonical source revision manifest
  sourceRefs:readonly CanonicalSourceRevisionRef[]; // complete material inputs
  businessContextVersion:1; contextFingerprint:string;
  contextRevisionRefs:BusinessContextV1["contextRevisionRefs"];
  policyRevisionRefs:BusinessContextV1["activePolicyRefs"];
  effectPreview:SafeEffectPreview; // derived from canonical payload, NEVER input
  expiresAt:string; approvalPolicyKey:string; riskClass:"low"|"medium"|"high";
  missingPreconditions:string[];
};
// Approval is a typed transition, never a side effect and never LLM-provided consent.
type ApprovalTransitionInput = {
  proposalId:string; proposalRevision:number; decision:"approve"|"reject";
  displayedEffectHash:string; // must match trusted persisted proposal preview
};
type ApprovedTransition = {
  state:"approved";
  approvalId:string; proposalId:string; proposalRevision:number;
  actorUserId:string; decisionAt:string; approvedEffectHash:string;
  approvedSourceSnapshotHash:string;
  approvedSourceRefs:readonly CanonicalSourceRevisionRef[];
  approvedContextFingerprint:string;
  approvedContextRevisionRefs:BusinessContextV1["contextRevisionRefs"];
  approvedPolicyRevisionRefs:BusinessContextV1["activePolicyRefs"];
  expiresAt:string; auditEventId:string;
};
type UnsuccessfulApprovalTransition = {
  state:"rejected"|"conflict"|"expired"|"unauthorized";
  requestId:string; reasonCode:string; decidedAt:string;
  // These fields MUST NOT exist, including as null or empty arrays.
  approvalId?:never; proposalId?:never; proposalRevision?:never;
  approvedEffectHash?:never; approvedSourceSnapshotHash?:never;
  approvedSourceRefs?:never; approvedContextFingerprint?:never;
  approvedContextRevisionRefs?:never; approvedPolicyRevisionRefs?:never;
  actorUserId?:never; expiresAt?:never; auditEventId?:never;
};
type ApprovalTransitionResult =
  | ApprovedTransition
  | UnsuccessfulApprovalTransition; // strict Zod discriminatedUnion("state", ...)

// Commit evidence is trusted server-side persisted postcondition proof.
// A retry receipt, HTTP 200 or successful LLM completion is never this proof.
type PostconditionProof = {
  kind:"canonical_reread"|"verified_provider_receipt";
  proofId:string; // immutable tenant-scoped reference into audited proof ledger
  checkedAt:string; observedEffectHash:string; observedTargetRevision:string;
  sourceRevisions:readonly [CanonicalSourceRevisionRef,...CanonicalSourceRevisionRef[]];
  verificationPolicyId:string; verificationPolicyRevision:number;
}; // source may prove a selected revision OR confirmed absence; no null gaps
type AppliedActionOutcome = {
  status:"applied";
  actionId:string; workflowId:string; actionType:string;
  effectId:string; persistedRevision:string; verifiedAt:string;
  verifiedEvidence:readonly [CanonicalSourceRevisionRef,...CanonicalSourceRevisionRef[]];
  postconditionProof:PostconditionProof; postconditionAuditEventId:string;
  // No nullable evidence/proof; all IDs are server-issued and tenant-scoped.
  reasonCode?:never; ownerActorId?:never;
};
type InFlightActionOutcome = {
  status:"executing"|"pending_reconciliation";
  trackingId:string; reasonCode:"executing"|"awaiting_postcondition"|
    "external_receipt_unknown";
  // A safe opaque tracking handle is not evidence of effect or receipt.
  actionId?:never; workflowId?:never; actionType?:never; effectId?:never;
  persistedRevision?:never; verifiedAt?:never; verifiedEvidence?:never;
  postconditionProof?:never; postconditionAuditEventId?:never;
  ownerActorId?:never;
};
type UnsuccessfulActionOutcome = {
  status:"rejected"|"conflict"|"failed";
  requestId:string; reasonCode:string; // safe allowlisted error only
  // Private grant/actor/audit IDs, target/actual state, source revisions,
  // executable parameters and proof are preserved ONLY in server audit.
  actionId?:never; workflowId?:never; actionType?:never; effectId?:never;
  persistedRevision?:never; verifiedAt?:never; verifiedEvidence?:never;
  postconditionProof?:never; postconditionAuditEventId?:never;
  ownerActorId?:never;
};
type VerifiedActionOutcome =
  | AppliedActionOutcome | InFlightActionOutcome | UnsuccessfulActionOutcome;
// Strict Zod status discriminatedUnion with cross-field proof validation.
// Applied requires durable postcondition proof persisted and reread
// against the exact approved effect hash and authorized target revision.
// Otherwise return executing/pending_reconciliation, never applied.
~~~

**Mode result status and privacy invariants:** The server compiles **strict Zod discriminated unions by `status` and `mode`**, with no passthrough/unknown fields and no implicit numeric coercion. For `read`, `simulate`, `evaluate` and any bound analysis, only `verified`, `estimated` or `partial` may contain a **non-null, schema-validated payload**; verified requires complete applicable source coverage, no unresolved material conflicts, no missing prerequisites and authorized provenance, partial requires explicitly partial coverage. Estimated requires declared assumptions and no false actual/verified claim. `unavailable`, `failed`, `conflict`, `insufficient_evidence` or `requires_approval` **require `payload:null`** and expose only a safe error/required-input *code allowlist*, not raw refs, private source data, model fragments, preview, proposal, actor IDs or input fingerprints. The domain's actual result value must be validated against the **exact capability-bound output schema plus mode/status-specific runtime refinements** before caching, analysis composition, grounded replies or owner-visible cards; a malformed `verified + null`, `failed + payload`, `partial + complete`, `simulated failure + scenario fingerprint`, or `evaluated failure + findings` is rejected and safely converted to a sanitized unavailable result by the trusted boundary (with private audit of the validation error). Runtime schemas do not `strip` forbidden extra fields: **reject** them and never leak untrusted objects. No arbitrary fallback to a success or a fabricated zero. An analysis takes this same `ReadResult`/`SimulationResult`/`EvaluationResult` schema **from its exact bound capability registry key**, so it cannot use a weaker result envelope. `propose` keeps an inert draft **only on a valid successful proposal transition**; failed creation has no proposal or effect. `approve` already uses its separate success/failure privacy union and `commit` remains the only effect gateway.

**Commit proof and output validation:** The trusted commit gateway's `CommitResult.outcome` must use the exact `VerifiedActionOutcome` **strict Zod discriminated-by-status** schema, not a nullable effect metadata bag. `applied` requires a **durably persisted postcondition proof** linked to the original tenant/proposal/effect identity and a **fresh authorized canonical reread (including confirmed absence when relevant) or independently verified provider receipt**. Recompute effect/target revision and verification policy; require nonempty immutable source revision proof, nonempty `effectId`, `persistedRevision`, `verifiedAt` and append-only proof/audit reference, and verify `checkedAt` and receipt semantics. A successful DB write, reservation, HTTP 200, provider timeout, queued outbox, optimistic action card or owner approval is NOT applied. `executing` and `pending_reconciliation` expose only an opaque tracking handle/safe state and do not claim success; `failed`/`rejected`/`conflict` expose only a safe request ID/reason and cannot serialize effect IDs, actor or audit IDs, source manifests, payloads or sensitive targets. Detailed failure and retry/receipt records stay on the tenant-scoped private ledger. **Validate output before cache, notifications, operating tasks or grounded reply**; reject unknown keys, empty/unverifiable proof, wrong effect/target, fabricated successful branch or partial evidence with a safe pending/error state, never turn unsupported proof into success. Concurrency and retries recover the same consumed proposal; no second effect or invented receipt.

**Action-state separation:** current facts (`read`, `ReadResult` with `proposal:null`) → transient deterministic comparison (`simulate`, `SimulationResult` with `proposal:null`) → separately requested persisted inert draft (`propose`, a `ProposalResult` with **exact immutable `canonicalEffectPayload`**, derived preview/hash and complete `sourceRefs`) → **typed, auditable, no-effect approval** (`approve`, `ApproveResult` copies `proposedEffectHash` into identical `approvedEffectHash`, and exactly copies `sourceRefs` into `approvedSourceRefs`) → **one-time approval/proposal consumption and authorized domain operation** (`commit`, `CommitResult` alone may invoke verified effects) → separately verified postcondition. `evaluate` returns only `EvaluationResult` findings and never a proposal or executable command. “What if we schedule Sarah for fewer hours?” or “What if the drink price rises?” must stop at simulation unless the owner explicitly asks to propose a change. The server, not a model phrase, controls transitions. Tests verify no database/business side effects from simulation or approval, and that a valid approval is not proof of completion.

A proposal is neither permission nor an applied outcome. Owner-visible statuses map distinctly: **Suggested / Needs approval / Working or awaiting verification / Applied / Cannot complete / No data**. Show the exact employee/product/location, local schedule times, modeled costs/units, expected effects, uncertainty and proposed next action before committing. A completed badge requires durable postcondition evidence from the domain source; merely receiving an HTTP 200, an LLM completion, an external send attempt or a worker contact draft is not proof.

**Canonical effect payload — exact owner-to-domain instruction:** Every persisted `ActionProposal` must store a **schema-validated canonical `canonicalEffectPayload`** containing the *entire immutable intended operation*, its capability/effect discriminator and semantic schema version, business/target/base revision, and all domain-specific values (e.g., price in integer cents, currency, timing, location, schedule assignment set). A compiled **per-domain effect registry** exports its strict Zod payload-parameter schema, canonical serialization/hash rule, deterministic safe owner-preview renderer, required evidence/approval policy, and **commit-only** allowlisted domain handler. Adding a 5th specialist registers its own contract; no central action switch or generic `Record<string,unknown>` as executable parameters. An effect whose runtime arguments depend on a mutable draft, updated menu price, unversioned remote object or missing parameter is **unproposable** until immutable values (or content-addressed immutable payload bytes with verified hash) can be persisted.

The proposal's exact **canonical, stable serialized effect payload** is the **single source of truth** for the owner-visible typed preview, `proposedEffectHash`, approval and later domain execution. Bind the hash to the effect type+schema version and tenant/target/expected revision as well as parameters; never hash a prose summary or LLM preview. A `SafeEffectPreview` is computed by a trusted renderer from the validated payload (plus pinned *display-only* evidence) and is non-executable. At `approve` **reload the persisted payload**, re-run the originally registered effect schema and canonical serializer, recompute hash and preview, check the displayed hash and approved target/revision, source selection, BusinessContext and policy. At `commit` **reload and validate those exact immutable payload bytes again** against the original schema/version, original hash, successful `approvedEffectHash`, stored source/context/policy refs and target revision; then pass **that typed payload, never IDs-only guessed parameters**, to the authorized effect handler. If an old effect schema/renderer/executor is unavailable, revalidation fails closed and the owner must create/reapprove a new version. A parameter mismatch, payload alteration, preview/hash mismatch or unsafe scope yields a conflict with zero domain effect. A typed approval artifact **never allows altering the payload**: `approvedEffectHash === proposedEffectHash` and canonical bytes remain identical. The domain may verify current preconditions but **must not replace approved parameters with newly computed live-state values**. Source, context and policy manifests are separately persisted/rechecked as specified; payload validation is an additional mandatory gate.

**Source-manifest and effect-hash invariants:** The `ActionProposal.sourceRefs` array contains the **complete, immutable and tenant-scoped canonical source revision manifest used to generate its proposed effect**, not merely the refs convenient for UI citation. A `selected` entry must have a stable source ID and non-null canonical revision; `confirmed_absent` is permitted **only with a complete authorized query and a versioned absence/coverage proof**, never for missing/unknown evidence. Each entry fixes the canonical reader **ID and semantic contract version**, registered selector **ID and semantic contract version**, complete **normalized, schema-validated selector arguments and their canonical hash**, source purpose, source-precedence policy/version, selection identity and bounded location/time window. A `selectionKey` alone or a precedence version alone is **not** a source-selection contract; the source manifest must preserve replayable filter meaning even when an old record has disappeared. Normalize/deduplicate/sort the complete manifest deterministically, validate that it is consistent with `sourceSnapshotHash`, and persist both atomically with the immutable proposal; **reject effectful proposals if material sources or selection semantics cannot be versioned, persisted or validated**. A proposal that uses multiple domains must include **all** material inputs and selectors from every participating domain, including derived-metric lineage; source selection cannot silently change when a referenced record is deleted, backfilled, superseded or replaced.

**Canonical selector/reader versioning and replay rules:** The build-time source-read registry declares each reviewed `canonicalReaderId + readerContractVersion` and `selectorContractId + selectorContractVersion` with a **strict per-selector Zod input schema**, normalization rules, coverage/absence semantics, source identity rules and allowed source-precedence policy. Normalize filters *before* generating the proposal (canonical field names and ordering, timezone/local date windows, units, default values and explicit null/absence). Persist the normalized arguments **and** `selectorArgsHash`, the two semantic versions and full typed selected/confirmed-absent manifest; `sourceSnapshotHash` commits to all of these inputs, the source revisions, selection/coverage proof and relevant precedence policy version, not merely the list of observed record IDs. Never accept model-provided contract versions, selector hashes or mutable query text. The selector arguments are **not arbitrary SQL/GraphQL**; only strict registered fields and bounded types may be executed under tenant scope.

A change to a canonical reader's **selection or coverage semantics** (including filter interpretation, implicit defaults, join/visibility rules, actual-versus-estimated status or empty-result completeness) **requires a new reader/selector contract version**, independent of source-precedence policy changes. Tests and code review enforce no semantic changes under the same version. At both `approve` and `commit`, load the **original** contract versions and re-run the **persisted normalized arguments**, checking their hash and comparing both the original and freshly selected canonical manifest/coverage proof, even if both currently return zero records. **Never replay under a newer default selector**, silently migrate the arguments, or merely compare hash values returned by current code. If the original version is retired, unsupported, revoked or unreplayable, **fail closed with conflict and require a new proposal/approval**. A `confirmed_absent` result can pass only if its original selection contract, normalization, coverage-version proof and empty result all still agree. No absence proof may be synthesized from unsupported, incomplete or unauthorised reads. The original selector manifest remains immutable and auditable even when superseded; authorization is reevaluated at approval and commit.

Only the **`ApprovedTransition` success variant** copies the original source array unchanged into `approvedSourceRefs` and `sourceSnapshotHash` unchanged into `approvedSourceSnapshotHash`. It must also copy `ActionProposal.proposedEffectHash` exactly into `approvedEffectHash`: **`approvedEffectHash === proposedEffectHash`**. Neither approval nor commit may silently recalculate and substitute fresh refs, a different effect, or a new context; any mismatch is `conflict` requiring a new proposal. **The `UnsuccessfulApprovalTransition` branch never contains `approved*` bindings (not even null/empty values), approval IDs, proposal IDs/revisions, actor IDs or internal audit details.** Return only a request correlation ID and safe, non-enumerating error reason; store sensitive rejection/audit details solely in the authorized server ledger. The actual runtime Zod discriminated union must use **strict object schemas** (with unknown keys rejected), and server serializers must whitelist branch fields, so an unauthorized caller cannot discover private source, context or policy revision identifiers. An unsuccessful transition never creates an approved artifact. Server-side approval/audit storage retains the original proposal reference as permitted. Immediately before commit, reload the immutable proposal and approved manifest and reselect canonical sources with the original selector/precedence policies; compare the **full ordered manifest** and its hash to both durable copies, separately recheck `contextFingerprint` and policy/grant revisions, and fail closed if a source changed, disappeared, became newly authoritative, or an originally complete absence ceased to be true. A hash with no stored manifest is **not auditable proof**. Persist only bounded provenance pointers/revision metadata, not sensitive full source payloads or raw model text.

Preserve legacy GroundedSupervisorReply/blocks and evidenceReferenceSchema as the final write gate. Add a **separate, versioned trusted action-card renderer contract**, backed by server-issued opaque IDs and canonical internal routes; avoid relaxing the current numeric/text/link whitelist or allowing model-supplied action URLs. A detailed schedule grid or supplier/price compare can be a new typed block only after the same evidence validation, privacy, localization and backward-compatibility tests.

## 8. Capability-level authority, approval and delegated operation

### 8.1 Explicit policy dimensions

**Deny by default for every effect.** Evaluate authorization on discovery, preview, approval and execution, and again before an external call. Policy must bind: active café + authenticated actor + current role; registered capability ID/version/effect; target entity and location; sensitivity/risk class; canonical evidence freshness; business state/revision; confirmed owner choice; provider and transport availability; explicit enabled feature; and unexpired delegated grant when applicable.

| Tier | Example | Default behavior |
| --- | --- | --- |
| R0 — bounded read | Profit, menu products, scheduling inputs, Team tasks | Owner-scope checks; no business effects |
| S0 — transient what-if | Pure price/labor simulation using known evidence | No proposal, approval, domain write, notification or scheduled job |
| P1 — propose | Persist a reviewed pricing/schedule draft after explicit request | May persist inert, versioned proposal metadata; **not** apply |
| A2 — typed approval (no effect) | Approve exact immutable Olivia proposed plan or Alex pricing draft | Authenticated owner/delegate with explicit capability policy; record exact effect/source/context/policy revision and decision; **no publication or provider call** |
| C2 — one-shot commit | Publish specifically approved Olivia revision; apply separately enabled canonical action | Atomically consume proposal once across **all client request keys**; recheck actor/policy/context/source/effect; execute, reconcile and verify |
| D3 — tightly delegated action (future) | Repeated **allowlisted** low-risk internal action within owner-set guardrails | Separate opt-in per capability/target/limits, TTL/revocation, spend/time caps, anomaly stop, audit and owner visibility; do not turn on in baseline |
| X — forbidden/no provider | POS writes, payroll posting, staff texting without consent/transport, supplier purchasing without provider | No execution capability even if owner asks or a rule says so |

Owner guidance in ai_team_rules, a chat phrase ("always do this"), a model opinion, or prior approval of a different revision is never an authority grant. There is no universal Supervisor "full access" switch that authorizes writes. The permission to **read all supported metrics** must not imply ability to modify any record.

A future delegated grant should be persisted as tenant-scoped, capability/effect/version-scoped record with allowed targets, maximum per-run/count/spend/period, permitted hours, approval actor/time, expiry, revocation version and provenance; revocation must apply before new executions. High-risk/irreversible effects (payroll, price propagation to POS, outbound purchases, worker contact, external finance) remain forbidden absent their own security/privacy/legal review even with generic delegation. Provide owner-readable revocation, audit history and default off in every tenant.

### 8.2 Server-side approval workflow

Untrusted parse → entity resolution → **strict domain effect schema validation of complete immutable `canonicalEffectPayload`** → deterministic trusted preview **derived only from the canonical payload** → capability-specific feasibility and permissions → **immutable proposal** persisting exact typed payload, preview, `proposedEffectHash` derived from that payload, full typed canonical `sourceRefs` revision manifest (versioned selector/reader arguments + `sourceSnapshotHash`), BusinessContext.v1 `contextFingerprint` and material preference/objective/guidance/workflow/**policy** refs, target baseRevision and expiry → **typed `approve` transition** by an authenticated authorized actor (CSRF/same-origin; server-stored proposal, actor, displayed hash, optimistic proposal revision) that **reloads and revalidates exact payload+hash/preview** and original source/context/policy versions → **approved** artifact with identical effect hash and copied refs, **without business effect** → **separate `commit`** that revalidates **the exact original canonical payload bytes+schema/version/hash**, all source/context/policy/tenant preconditions, atomically consumes the proposal once across request keys, then passes *only that validated typed payload* to the commit-authorized domain executor → postcondition reread → audited verified outcome. Any material source/context/rule/workflow/policy/grant change, schema-invalid preference, altered effect/target or expiration fails closed with `conflict`/`repropose`/`reapprove`; no "best effort" substitution of a different schedule, staff member, product or price.

**ApprovalTransitionInput / ApprovalTransitionResult (§7) are mandatory common registry contracts.** They resolve only a persisted `ActionProposal` and bind the owner's exact `displayedEffectHash` to the *server-revalidated, persisted* `canonicalEffectPayload`'s `proposedEffectHash`; **only the `state:"approved"` result branch** copies that unchanged hash to *postapproval* `approvedEffectHash` and copies immutable `sourceRefs` (including reader/selector versions and normalized args) into `approvedSourceRefs`. The approved artifact binds the **immutable canonical payload via its proposal ID/revision and hash** and may never substitute parameters. Non-approved branches have no approved bindings, proposal IDs or internal audit IDs in the response. It must not regenerate new canonical input snapshots, allow changing effects, or swap in a fresh source/context/policy fingerprint. Authorization checks the actor and relevant approval requirement; a delegate may approve only if separately enabled for that specific effect, otherwise only owner confirmation qualifies. Approval status and approver details are audited; `approve` does **not** consume the proposal (consumption belongs to `commit`) and cannot produce an `applied` outcome. Approval can only be used to commit its own exact proposal revision/effect, never another proposal. For a future delegated workflow, an explicit persisted scope/threshold/version-bound authority decision stands in for the human approval **but never skips the proposal/context binding or atomic consumption**.

Olivia **approve** and **publish** remain distinct milestones according to docs/scheduling-architecture.md until an explicit later UX/security review authorizes combining them. Publishing is not worker acceptance, delivery or clock-in. Keep existing owner task response APIs separate from universal action grant policy.

## 9. Durable, idempotent execution and workflow state

Use a **small, additive tenant-scoped workflow ledger only when the first effectful capability is approved**; no migration in this documentation PR. Logical records: workflow (business, owner, originating conversation/message, goals/plan hash, state, version, created/expiry); steps (capability+version, input hash, dependency IDs, attempt count, lease, state, immutable result refs); **proposals** (businessId, proposalId, immutable proposalRevision, **schema-validated exact immutable `canonicalEffectPayload` plus derived `SafeEffectPreview` and `proposedEffectHash`**, target/baseRevision, `sourceSnapshotHash` **plus typed immutable `sourceRefs`/versioned selector contracts and normalized selector args/hash**, contextFingerprint, material context+policy refs, expiry, one complete effect or explicitly reviewed atomic bundle); **approvals** (strict state-discriminated success/failure audit decision: **successful approvals only** reference exact persisted canonical payload/proposal revision, store approver, **`approvedEffectHash` identical to recomputed `proposedEffectHash` of validated immutable payload**, `approvedSourceSnapshotHash`/unaltered `approvedSourceRefs`, context/policy refs, expiry; failures are private server audit events, **not** executable grants or client-visible bindings); **proposal consumptions** (unique tenant/proposal/revision; deterministic effect key; workflow/effect outcome state); effects (unique business/actionType/idempotency key *and* canonical proposal/effect identity, requested payload hash, domain outcome); append-only audit events; transactional outbox where needed. The action/audit ledger must retain both source revision arrays by immutable reference/value, not hash-only rows or a later mutable snapshot lookup.

States: requested → planned → awaiting_approval → approved → **consumed/executing** → applied / pending_reconciliation / failed / rejected / canceled / superseded. Each transition uses tenant-scoped compare-and-swap and full audit. **Before approval**, the proposal has an **immutable one-effect identity** (`businessId, proposalId, proposalRevision, proposedEffectHash`). **On successful approval**, the trusted transition copies `proposedEffectHash` unchanged into `approvedEffectHash`; equality must be persisted and validated. **After approval**, consumption/outbox uses the identical value under its approved field name (`businessId, proposalId, proposalRevision, approvedEffectHash`), and the original proposal identity remains unchanged. A proposal permitting multiple external/domain operations must instead be represented as **individually approved single-effect proposals**, or a separately reviewed atomic bundle with every effect fixed in its hash; one approved revision can never be retargeted or consumed for an extra effect.

**Two non-interchangeable idempotency constraints:**
1. **Request retry dedupe:** `UNIQUE (business_id, client_idempotency_key)` with payload-fingerprint comparison; same key/same payload returns stored state, reused key/changed payload conflicts.
2. **One-time proposal consumption across *different* request keys:** a durable `proposal_consumptions` row with **`UNIQUE (business_id, proposal_id, proposal_revision)`** and persisted `approved_effect_hash` (checked equal to the proposal's `proposed_effect_hash`), `approval_id`, `workflow_id`, `deterministic_effect_key`, and lifecycle. Derive the immutable server-only effect key deterministically from canonical tenant+proposal ID/revision+**approved effect hash, verified identical to the proposal hash**; enforce **`UNIQUE (business_id, deterministic_effect_key)`** for effect/outbox records too. In one **database transaction** lock/CAS the approved proposal revision, verify strict `state:"approved"` approval, **reload and revalidate the exact persisted canonical effect payload against original effect-contract schema/version; recompute/compare `proposedEffectHash === approvedEffectHash`**, verify **both original+approved source revision manifests, reader/selector contract versions, normalized arguments/hash and `sourceSnapshotHash`**, context/policy and state, insert unique consumption and effect intent/outbox/atomic domain work as applicable, then transition to executing. The effect/outbox intent persists the approved **typed payload or verified immutable content-addressed pointer**, never a presentation preview or IDs-only guessed action. **No consumption of rejected, unauthorized, expired or conflict transition results.** This is not keyed by client request ID. If concurrent owners/requests (including *different* keys) race, exactly one consumes the proposal; losers return the existing execution state **without running another effect**, or conflict if payload/effect differs. Transaction rollback must also roll back the consumption reservation if no effect intent was durably recorded.

Retries and crash recovery resume the **original deterministic effect identity** from the durable row; same key or *new* key must never create a second effect, purchase, shift publication or provider send. A reserved/in-flight consumption is **not a successful applied effect**: return `executing` or `pending_reconciliation` until domain postconditions/remote receipts prove completion. If an external provider's result is uncertain, query provider status/receipt and **never** blindly resend, especially where remote idempotency is unavailable. If the owner wants a genuinely new attempt after a final failure, require a **new reviewed proposal revision and authorization**, not recycling the consumed approval. Only canonical domain transaction + outbox can provide atomic local exactly-once intent; third-party delivery remains reconcilable, not claimed as guaranteed exactly once.

**Effect ownership:** Let each canonical domain repository own its atomic transaction and overlap/version constraints (e.g. Olivia published plan and shifts). Its **commit-only** write handler receives the **revalidated exact canonical effect payload** (full parameters, contract ID/version, tenant/target/revision) with original proposal+successful approval source manifests including reader/selector versions and normalized args; it never reconstructs parameters from untrusted preview prose, request IDs, hash alone or changed domain state. It rejects absent payload bytes, changed payload/hash/contract, changed target and removed/unreplayable selectors/revisions before an effect. The one-time proposal consumption, effect intent and any local domain write/outbox must participate in **one atomic trusted database transaction** (or an explicitly reviewed equivalent that never releases a second consumption); for external effects persist the intent/outbox and consumed proposal atomically **before** contacting the provider. Where an outbox/event must be emitted, write it **in the same transaction** as the domain change; then retry dispatch with lease + the **deterministic server-derived effect key** as consumer dedupe identity. Avoid distributed transactions and fake exactly-once external messaging. For a provider with uncertain timeout, mark pending_reconciliation and query its receipt/remote idempotency status rather than blindly replay a potentially charged or delivered action. Irreversible effects require explicit compensating **new action**, never history deletion.

Store the **minimal but complete immutable canonical effect parameters** needed to reproduce the authorized operation, with integrity-checked serialization and appropriate access controls/encryption for sensitive fields, plus provenance hashes/source IDs; never omit executable parameters and attempt to infer them later. Exclude broad raw conversations, bank statements, private uploads and bearer tokens from audit/job payloads. Provider secrets stay server-side encrypted. Support safe cancellation/expiry, administrator kill switch, and per-tenant quota without losing already-persisted records.

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

## 13. Merged Olivia PR #72 foundation and distinct release gates

**Verified source state:** PR #72 was merged into main on **2026-10-14** (merge commit `a3f5f2f0cb88e27482bc268739ed6578e44f1663`). The additive backend exists in `lib/actions/schedulingFoundation.ts`, `lib/scheduling/foundation.server.ts` and `foundationSchemas.ts`, `lib/calc/scheduling/availability.ts`, safety tests and `supabase/migrations/20261014000060_olivia_scheduling_foundation.sql`. It defines owner-only manual availability rules, exceptions, preferences, qualifications, coverage, compensation provenance, revisioned reads/commands and audited tenant isolation. Merged corrections cover compensation precedence and local-day hours caps (including overnight spillover). **Git merge does not prove production migration application, environment activation, optimizer readiness, or Supervisor integration.**

**Original six independent follow-on gates (historical sequence; optimizer and draft-saving code now merged):**
1. **Migration:** verify actual applied Supabase ledger, RLS/foreign keys and disposable/staging tests; production application needs a separate owner decision. This PR does not apply or assert production migrations. No table/flag = **unavailable**, not an empty verified schedule.
2. **Activation:** after schema verification, separately approve manual foundation activation and owner access tests, co-owner/tenant/demo denial, local-day cap, effective dates, wage precedence and audit. Do not enable an effectful Supervisor tool, worker contact, POS write or payroll change.
3. **Optimizer (delivered after this historical PR #72 baseline):** Olivia PR #77 is **merged**, implementing pure feasibility, qualification/coverage, local timezone/DST, break/rest, detailed scheduling and deterministic `lib/calc/scheduling/` costs/tests, including independent `validateOliviaAssignments`. This does **not** mean a plan can be saved, published or treated as actual attendance. A positive daily cap restricts aggregate scheduled minutes over the local day including overnight spillovers; it is not an availability interval. Unknown/salary pending wage must not become zero cost.
4. **Plans/approval/publish:** merged Olivia PR #84 provides default-off, revisioned schedule-draft saving, subject to migration and activation verification; this is **not** approval or publication. Future Olivia work must provide immutable approved proposals/assignments, separate no-effect owner approval and authorized one-time publish with full canonical effect payload, pinned source/context/policy manifests, atomic domain transaction and verified postcondition. Published ≠ actual attendance or worker acceptance.
5. **Supervisor adapter:** only when prerequisite capabilities and source availability are independently verified, register Olivia availability reads, schedule simulation, inert propose, approval and commit through **the existing Universal Supervisor's shared registry**, plus bounded metric/analysis schemas; preserve Staff/Operations, EN/ES/AR, legacy grounded replies and manual/no-POS functionality. Never insert an Olivia-specific central router branch. Missing foundation/optimizer/permission yields truthful unavailable, not a synthetic plan.
6. **Proactive/communication:** future evaluated gaps feed existing `operating_tasks` via authorized reconciler and opt-in quiet-hour-controlled owner alerts. Worker messaging, worker acceptance, external delivery and POS write-back remain separately unsupported until reviewed provider authority and receipts.

**Critical compatibility boundaries:** Old `staff_schedules`/`materializeSchedule.ts` may create `source_type=owner_schedule` **predicted** timecards; never silently convert published future assignments into actual attendance or double count labor. Positive recorded wages override stale `known_eligible_zero`; unknown/salary_conversion_pending are not free labor. The PR #72 owner-only domain writer must not be directly exposed as a model-invoked generic effect gateway. “Ahmed cannot work Friday” requires verified person/date/location, ambiguities clarified, safe availability read and (only after adapter readiness) a **proposal**; never imply a worker was contacted or a roster published.

**Product decision and historical-document reconciliation (resolved):** `docs/01-product.md` § **“Approved core capability: Olivia owner-directed scheduling”** records explicit owner approval of the narrow scheduling exception. Its “Don't build” list continues to forbid an **unrelated standalone POS scheduling clone**, payroll processing and automated POS write-back; it does **not** veto Olivia's already approved scheduling work inside the single Supervisor and Staff/Operations. The older `docs/scheduling-architecture.md` §§1/9 references to missing product sign-off were **outdated** and have now been corrected **in that document on this same documentation-only PR #73 branch**. The merged PR #72 implementation and the original six gates are now **partially delivered**: optimizer PR #77 is merged; migration verification, manual activation, versioned plan approval/publish, Supervisor adapter, and proactive/communication remain separate gated work. Issue #74 owns staged delivery; this P0 clarification does not authorize runtime work or activation.

## 14. Minimal ordered implementation PRs (AFTER architecture approval)

This PR is **P0 — architecture only**: reconcile the now-received RFC/review packet with the existing contract and request fresh independent review; no application code, migration, test fixture or environment change. Do not merge automatically.

| Order / prerequisite | Minimal PR and targeted files | Acceptance / stop gate |
| --- | --- | --- |
| **P1 — full metric/entity/analysis inventory and access** | Inventory supported metrics, entities and analyses with strict input+output Zod schemas, safe cents, verified coverage and no-POS support; analyses must have explicit nonempty purpose union and **exhaustive exactly keyed source requirements**, including explicit validated-input-only case; bound capability literal identity and schema contract tracked in CI | Both-way coverage CI rejects orphan/mismatched analysis key, I/O schema identity/fingerprint/version, missing/extra per-purpose rules and malformed metric/entity results; no central specialist branches or unsafe data exposure |
| **P2 — six-mode typed capability protocol + shadow registry** | Preserve six disjoint mode descriptors; compile literal registry-key-derived analysis I/O+mode contracts and versioned exact schema identity, startup equality checks, exhaustive purpose/selector/coverage gates; introduce strict **status-discriminated** read/simulate/evaluate output schemas and sanitized failure serializer | Static/runtime tests reject mismatched bindings, unknown contract hashes, purpose drift, source-free misuse, success-with-null, failure-with-payload/refs and read/simulate proposals; no domain effects, tenant/locale/current Supervisor behavior unchanged |
| **P3 — bounded multi-domain orchestration + novel what-if composition** | Compatibility-flagged Supervisor uses OpenAI to decompose unfamiliar multi-clause goals, discover exact authorized purpose-bound readers/analyses and assemble a **strict typed, bounded read-only calculation plan** executed by registered trusted arithmetic/domain primitives (§6.2), including source/BusinessContext versions and budgets | **COMPOSE-01..08 are mandatory executable gates:** unseen safe calculations and paraphrases work through actual Supervisor without a new central intent branch; source units/periods/actuality verified, canonical `lib/calc/` preserved, no-POS partial results honest, legacy EN/ES/AR/Team/pricing/money behavior and rollback intact, no effects. P3 incomplete if only named-report routing exists |
| **P4 — immutable typed proposal/approval/one-time execution** | Tenant workflow persists entire exact Zod-validated canonical effect bytes/params, safe derived preview/hash, immutable source/context/policy manifests; strict no-effect approval, DB unique consumption across request keys, commit-only executor and **durable reread/provider postcondition proof** | Only applied branch has complete verified nonempty postcondition revisions/audit proof and matches approved hash+target; executing/pending cannot claim success; failed/rejected/conflict redact all private/effect IDs; concurrent co-owner/race/crash/outbox and receipt tests pass, default-off until separate owner authorization |
| **P5 — Olivia scheduling adapter when domain ready** | Separate PR integrating reviewed lib/scheduling/ preview/publish domain services and **Olivia schedule feasibility/coverage-cost analyses as typed registered read/simulate capabilities**, with canonical source/metric validated output and Staff link | No change to #72 or activation by this docs PR; no POS needed, no fake timecard/payroll or inferred hourly demand; strict wage/cost units, missing inputs/hard constraints and owner approval, idempotent publish |
| **P6 — evaluators, interruption budget and owner-outcome verification** | Register bounded **analysis/evaluate** evidence findings with strict outputs and dedicated separately authorized task reconcile; add outbox/lease only as needed, urgency/digest/quiet hours/owner consent and measured outcome scorecard | Evaluations read-only and provenance/metric validated, no false urgency or invented issue; task lifecycle retry safe, opt-in notifications/verified receipts, measured owner time and false-alert/failure guardrails |
| **Domain follow-ons (parallel where safe)** | Alex pricing capability, Maya evidenced supply/optional inventory, Leo money actions only after supported integration; each domain supplies contracts/tests, not new central intents | One or two new module registrations, no new Supervisor core branching or LLM SQL; unsupported integrations visibly unavailable |

P1 and P2 may be divided by test and migration risks; P4 and P6 must remain default off until separately approved. **No broad "agent framework first" rewrite.** PR #72 is already merged on main; future Olivia domain PRs remain independent and must not be folded into this documentation PR. Every application PR requires diff review, unit and DB integration tests where relevant, npx tsc --noEmit, npm run test, npm run lint, npm run build, git diff --check, and pilot/staging verification before production activation. Report actual results/skips; no implicit auto-merge or production migration.

### Required executable acceptance tests (architecture specification)

These are **future tests**, not tests executed by this documentation change.

| Test ID | Fixture / operation | Must prove |
| --- | --- | --- |
| EXT-01 | Register Olivia read/preview implementation with domain descriptors; ask about staffing | No changes to core planner, tool schema enum, permission engine or global intent switch; one validated, attributable result |
| EXT-02 | Register Alex pricing review+proposal using same contract | No Olivia-specific exception in core; canonical lib/calc pricing engine and evidence, no POS price write |
| EXT-03 | Register Maya supply quote read and Leo period cost read | No new central intent-specific branches; proper source estimates, matching units, distinct canonical domain ownership |
| EXT-04 | Register fifth domain / new metric and analysis bound to correct typed non-effectful capability | Domain registry exports and I/O/policy/provenance/limit tests only; no core routing changes, no synthetic data or effects |
| COVER-01 | Inventory every public metric/entity-read/analysis surface; add/rename public domain projection | CI fails orphan/missing mapping, missing strict metric output/value schema or analysis I/O/handler contract; every supported surface has authorized path or explicit restricted/unsupported state |
| COVER-02 | Test staff-private, missing inventory/no POS, incomplete sales, unsupported hourly/dimension and malformed metric/analysis output | Metric/entity/analysis tenant/role/source/status/kind/unit/coverage checks enforce security; malformed output not passed to Supervisor, no SQL/invented zero |
| ANALYSIS-01 | Register Alex pricing review, Olivia coverage what-if, Maya supplier quote comparison and Leo matched-period profit analysis | AnalysisDefinition binds typed read/simulate/evaluate handler, strict input/output, permissions, source provenance/coverage, time and resource budgets; no central routing branches |
| ANALYSIS-02 | Register fifth-domain analysis then change/remove exact bound capability registry key/version/mode/schema fingerprints or contradict source/policy/budget | Type-level literal key and runtime schema-contract parity reject mismatched/missing/outdated registrations; no central dispatcher exception or substitute handler |
| ANALYSIS-03 | Return malformed money, cross-tenant staff records, conflicting/partial source data, missing POS data or injected executable proposal | Underlying metrics and exact bound analysis status schema validated; failure sanitized, non-null verified payload and truthful partial proven data only; never writes effects |
| ANALYSIS-04 | Bind one analysis to unrelated same-mode capability with different input/output Zod schemas; reuse ID but wrong schemaContract version/fingerprint; remove bound registry key | Compile-time literal registry-key linkage fails incompatible types; startup rejects absent or mismatched input/output contract id/version/fingerprint, never coerces/forwards |
| ANALYSIS-05 | Declare purpose union `payroll_actual` / `schedule_forecast` but configure only one source rule, an extra purpose, duplicate allowed purpose or stale selector | `Record<P,...>` compile-time fixture and strict registration own-key equality reject missing/extra/duplicate purpose; dispatcher has exact purpose-source/coverage/actuality rules or denies |
| ANALYSIS-06 | Register intentionally source-free pure simulation with declared `no_external_sources` and empty inputs; try calling a reader, citing business facts or passing a nonempty hidden source list | Explicit source-free declaration accepted only for typed-input-only scenario; runtime blocks undeclared sources, unsupported verified real-world claims and bogus empty-coverage proofs; no fallback to another purpose |
| ANALYSIS-08 | Register a `preauthorized_operands` purpose for the expression capability; supply independently validated versioned metric/entity source manifests, then attempt forged tenant/source refs, wrong purpose, stale reader/selector/policy revisions, incomplete coverage, missing evidence, reported/unverified supplier quotes improperly presented as verified paid costs, legacy status improperly promoted to verified evidence, missing separate actuality/evidenceStatus, or unsuccessful read carrying a SourceRef, swapped operand handles and mixed-tenant inputs | Valid source-bearing operands may compute without new evaluator reads; all invalid provenance/coverage/scope/revision cases fail closed before arithmetic; `no_external_sources` remains invalid for café-derived evidence; require both fixture and dispatcher integration tests |
| METRIC-01 | Register sales, labor and profit metrics with distinct Zod filter/dimension schemas, explicit purposes, granularities and source-selection rules | Dispatcher strictly parses entire request before calling reader; unknown filter, purpose, employee dimension, hourly inference, excessive date range or unauthorized role denied with **zero reader calls** |
| METRIC-02 | Register fifth-domain metric with purpose/source selector, strict value/output schema and bounded rows/series/cost | No central branch; CI rejects missing schema/unit/type, unbounded read or wrong purpose-source map, result checked before analysis or cache |
| METRIC-03 | Return money metric as fractional cents, NaN, Infinity, unsafe integer, numeric string, wrong unit/value kind, or mismatched metric ID/version/query | Strict metric value and output schemas reject before aggregation/cache/Supervisor; no coercion, rounding, zero fallback; safe unavailable and internal audit |
| METRIC-04 | Return series with duplicate/overlapping/out-of-order buckets, invalid time zone/DST, mixed units, invalid point values, null with verified status, wrong dimension or oversized series | Strict ordered point/array schemas, scalar/unit/coverage checks and per-metric bounds reject; complete empty series requires full evidence |
| METRIC-05 | Return verified value with missing/partial source coverage, contradictory actuality, stale/missing evidence or unacknowledged conflicts | Cross-field refinements reject false verified status; partial is labeled observed subtotal with missing keys; failed/denied/unavailable requires null and reason |
| MODE-01 | Register all six descriptors; type-check forged read/simulate proposal, eval write, propose executor, approve commit and commitless action | Static type-check fails incorrect descriptor/result variants; runtime strict Zod mode discriminants deny non-null proposal in read/simulate or extraneous effect/approval fields |
| MODE-02 | Invoke every mode in trusted server dispatcher with malicious model parameters and provider errors | `read` and `simulate` no drafts/effects; `evaluate` finding-only with task writes restricted to separate reconciler; `propose` inert only; `approve` no effect; **only** authorized `commit` calls domain executor |
| STATUS-01 | Test read, simulate, evaluate and bound analysis with `verified + payload:null`, `partial + completeness:complete`, `failed/unavailable/conflict/insufficient_evidence + nonnull payload` | Strict Zod mode/status union rejects every impossible combination and unexpected output keys; only evidence-backed successful status exposes typed nonnull payload; no owner-facing invalid value |
| STATUS-02 | Return unauthorized, failed, insufficient-evidence or conflict result containing private evidence refs, metric IDs, conflict details, input fingerprint, scenario fingerprint or executable proposal; test evaluator failure with findings | Negative branch accepts only safe codes and null payload, no private metadata or scenario/evaluator content; audit internal failure privately, never serialize leaked keys |
| STATUS-03 | Check estimated/partial result with absent assumptions, mismatched provenance, non-source-safe source-free analysis, forged successful evaluator findings, and proposal not_created carrying an ActionProposal | Runtime quality/coverage and strict mode schema rejects fabricated success or executable draft; partial values grounded, source-free not promoted to café fact; no domain side effect |
| SIM-01 | Compare a proposed staff-hour scenario and an Alex price what-if without asking to save | Pure reproducible calculation from pinned evidence; zero draft, price, schedule, timecard, notification or external effects; proposal ID absent |
| CONTEXT-01 | Two owners with private preferences and shared confirmed objectives, approved natural-language team rule and stale snapshot | Each domain sees minimum authorized context; version changes invalidate proposal; rule cannot execute; no cross-owner memory leak |
| INTERRUPT-01 | Ten duplicate routine findings, one verified urgent shift exception, café-local quiet hours and provider disabled | Single digest/operating task for routine findings; only explicitly authorized emergency override bypasses quiet hours; pending urgent task remains actionable; no false delivery |
| OUTCOME-01 | Workflow has simulation, proposal, verified completion, unverified external attempt, owner intervention and confirmed false alert | Scorecard uses only verified effects and audited owner time; correctly counts interventions, false alerts, unresolved issues and failures without inflating savings |
| COMPOSE-01 | Novel hypothetical: sell 25 additional iced lattes daily but require 45 more paid minutes of a specifically resolved worker; evidence permits price, unit variable costs, wage rate and applicable burden | OpenAI proposes a typed plan selecting authorized readers; trusted generic evaluator computes reproducible *conditional contribution*, cents-safe and unit-correct, with hypothesized volume separate from actual. No question-specific core branch |
| COMPOSE-02 | Change customer wording/language, quantities, drink, worker, and introduce a second unrelated goal | Same vetted primitives/registry handles the new composition and all clauses; no regex/special case or silent lost goal; model's attempted invented facts are rejected |
| COMPOSE-03 | Whole, almond and oat milk per US gallon; usage for 12-oz/16-oz drinks with base selling prices | Trusted unit conversion and source-qualified incremental ingredient/margin scenarios work; no invented total loss without observed option mix or a specifically stated hypothetical volume |
| COMPOSE-04 | No POS, missing wage/payroll burden, salary conversion pending, missing variant sales, stale supplier cost, conflicting planned vs actual periods | Return justified partial/conditional/unavailable result and exact missing data; unknown is not zero, hypothetical is not actual and contribution is not net profit |
| COMPOSE-05 | Model sends forged tenant/person/source handles, unauthorized named wage, wrong capability key/purpose or stale selector revision | Deny before unauthorized reads or sensitive output; RLS/owner-private source and exact purpose/selector versions enforced for every leaf |
| COMPOSE-06 | Model supplies SQL, JS, shell, URL, unknown primitive, unbounded expression/tree, 0 denominator, NaN, fractional money, mixed currencies, inconsistent units or incompatible dates | No code execution or domain writes; typed AST, depth/operation budgets, units, currency and money status validated; safe unavailable rather than numeric hallucination |
| COMPOSE-07 | Model tries to improvise payroll tax, overtime, labor-rule feasibility, recipe accounting or canonical net-profit formula | Use existing independently tested `lib/calc/` primitives under correct scope/policy or decline; AI-composed expressions cannot replace authoritative domain calculations or double-count |
| COMPOSE-08 | Compatibility-flagged live Supervisor with read-only composition and existing multilingual/Team/pricing/staff/sales fixtures; provider down or disabled | Grounded real result in live read/simulation path when enabled, no drafts/effects, regression parity and safe rollback; routine CI uses deterministic mocked model plus real trusted readers/fixtures |
| MULTI-01 | "Plan next week and show what it would cost vs this month's profit" with no POS | Olivia planned labor/coverage if domain ready; Leo period profit explicitly unavailable when unsupported; never add incompatible periods or forecast to actual profit |
| MULTI-02 | "Which drinks need a pricing review and how much did we sell yesterday?" | Alex+sales scopes independently fulfilled; missing item sales produces partial/unavailable while verified pricing remains valid |
| MULTI-03 | Conflicting source versions or a changed wage after read plan | Shared snapshot fingerprint mismatch → conflict/replan, not mixed-period math or stale zero wages |
| BACK-01 | Exact current semantic request fixtures, ordinary finance/sales/staff/pricing/Team, EN/ES/AR | Stable canonical numbers, period meaning, task links, evidence blocks, currently supported goal coverage and safe unknown responses |
| BACK-02 | No POS, no bank, no inventory, no sales history, provider offline | Explicit unavailable with missing inputs; zero only if verified; no invented hourly demand or external connection |
| BACK-03 | Unknown dimension, unsupported hour/day rollup or unauthorized person | Reject/return unavailable with correct reason; never extrapolate daily sales to hourly |
| SEC-01 | Owner A, second owner same café, manager, outsider, other business, tampered business/employee/plan IDs | Server auth + RLS + composite FKs enforced; private owner conversations isolated; no cross-tenant leak, including from cache or tool output |
| AUTH-01 | LLM attempts commit/read->write escalation, approved natural-language Team rule, forged confirmation | No effect; rules are not grants; action must be registered, policy-allowed, exact proposal approved |
| AUTH-02 | Approved plan revision then change source/wage/revoke grant/expire proposal | Execution blocked, conflict or reapproval; no stale change applied |
| COMMIT-01 | Valid tenant-scoped approved proposal commits local domain effect; separately reread persisted postcondition and compare exact effect hash, source/target revision and proof policy | `AppliedActionOutcome` requires nonempty revisioned evidence, persisted `postconditionProof`, verification timestamp, effect ID and durable audit reference; never applied from commit/HTTP 200 alone |
| COMMIT-02 | Attempt applied output with null effect ID/revision/time, empty proof/evidence, changed target/effect hash, fabricated provider receipt or inaccessible proof | Strict status-discriminated runtime output + trusted reread rejects invalid applied branch; no owner-visible Applied state, status remains executing/pending or sanitized failed |
| COMMIT-03 | Rejected/conflicted/failed execution or remote timeout returns effect IDs, actor/audit IDs, target, source refs or canonical payload in client output | Strict failure schema rejects all inappropriate keys; only opaque tracking+safe status for in-flight and safe request/reason for unsuccessful; private ledger retains audit and never duplicates effect |
| ANALYSIS-07 | Register analysis with two allowed purposes, invoke selected forecast purpose while model suggests actual payroll, omit/forge/mutate `selectedPurpose`, or reroute to another policy after parsing | Strict `AnalysisInvocation<K,P>` parses literal selected purpose, bound key/input and exact version **before** reader; uses only that purpose's selector/actuality/coverage/limits; invalid or changed purpose fails closed |
| OLIVIA-01 | On merged PR #72 main, migration absent/flag off; then with staged schema and manual activation, verify owner-only availability, pay provenance and overnight local-day cap | Git merge does not imply production schema/feature; disabled yields unavailable; positive per-local-day cap applies to both sides of midnight and cannot become an availability window; no optimizer/payroll mutation |
| OLIVIA-02 | Preview future schedule/coverage with missing wages and no POS, then attempt publish without separately ready optimizer/plans/authority/adapter | Unpriced labor remains missing, partial planning permissible only if all hard constraints and inputs support it; publication and cost claims blocked; future Supervisor integration remains independently gated |
| OLIVIA-03 | Read `docs/01-product.md` approved Olivia scheduling exception and `docs/scheduling-architecture.md` §§1/9; simulate reviewer claiming product sign-off missing based on historical `Don't build` wording | Product scope is **already approved**: no duplicate sign-off required; unrelated POS scheduling clone/payroll/POS writes remain prohibited; actual migration-ledger, flags, RLS/legal/wage tests, optimizer, versioned publish, Supervisor registration and notifications are **independent gates** |
| APPROVE-01 | Invoke `mode: "approve"` on a server-issued exact proposal revision/effect, then inspect domain state and approval ledger | Typed schema/actor/policy checks create an audited approval record **without committing**; successful approval copies exact `proposedEffectHash → approvedEffectHash` and `sourceRefs → approvedSourceRefs` unchanged; model text/Team guidance/another revision cannot approve; publish/commit remains distinct and default-off |
| APPROVE-02 | Tamper displayed effect hash, approval owner, proposal target or an expired/rejected approval; try direct commit | No approval/effect, typed conflict/unauthorized state; only exact authenticated approval may be consumed |
| APPROVE-03 | Serialize each `rejected`, `expired`, `conflict`, `unauthorized` result, including unauthorized owner of another café and forged extra `approved*` keys | A **strict Zod state-discriminated union** emits only `state`, generic `reasonCode`, opaque `requestId`, `decidedAt`; **no** `approvedEffectHash`, source manifest/hash, BusinessContext/policy revisions, proposal IDs, approval IDs, actor IDs or audit IDs (not even null/empty arrays); unknown response keys rejected |
| APPROVE-04 | Produce `state:"approved"` and then commit with exact permitted actor; change an immutable source or policy after approval | Success branch alone contains complete non-null copied effect/source/context/policy bindings; no-effect approval, commit rechecks originals and blocks changed bindings; rejected branches are never consumable |
| SOURCE-01 | Create cross-domain proposal using two source record revisions and one fully verified absent selection; persist and approve | Immutable `sourceRefs` with canonical reader, purpose, precedence version, location/period, IDs, revision/absence proof plus `sourceSnapshotHash` survives serialization; on successful approval `approvedSourceRefs` exactly equals the original manifest and approved hash equals original hash |
| SOURCE-02 | Between propose/approve/commit, delete or supersede an original wage/product/quote, add a more authoritative source, change precedence or **reader/selector semantic version**, alter normalized filters, or fill a previously complete absence | Both approve and commit detect changed canonical **selection behavior**, original arguments/hash, reader/selector contract version and mismatched source/absence coverage even when the old source ID cannot be fetched; reject with conflict/reproposal, no domain effect or silent recomputation |
| SOURCE-03 | Supply an incomplete/no-POS selector, missing or null source revision, tampered manifest, hash collision test fixture, reordered entries or cross-tenant source reference | No effectful proposal without a complete versioned, canonical and authorized manifest; sorting/canonical hash stable under equivalent ordering, altered material identity fails; unknown source is not confirmed absence |
| SELECTOR-01 | Same source records and same precedence policy, but change a canonical reader's default filters, joins, timezone normalization or full-coverage definition under a **new selector/reader contract version** | Manifest persists `canonicalReaderId`, `readerContractVersion`, `selectorContractId`, `selectorContractVersion`, strict `normalizedSelectorArgs` and `selectorArgsHash`; proposal hash changes even if selected source IDs are unchanged; stale approval/commit fails |
| SELECTOR-02 | An old versioned selector for `confirmed_absent` returns no records; deploy a new selector with different empty-set/coverage semantics, or retire the old one | No re-evaluation with latest defaults: replay exact old semantic version/arguments with valid coverage revision **or fail closed**; new empty result under changed semantics cannot validate original absence; no effect |
| SELECTOR-03 | Reorder equivalent filters, alter actual filter value or casing, use invalid/unknown selector keys, or silently change old-version reader semantics | Deterministic normalized args/hash equal for logically identical filters; material changed args/version rejected; strict Zod allowlist rejects unknown keys/model-generated SQL; CI/review gates fail on semantic drift without version bump |
| EFFECT-01 | Approve one proposed effect; try alternate effect parameters, mismatched display/hash, then two different request keys | Successful approval sets `approvedEffectHash === proposedEffectHash`, never renames/changes proposal's original field; any mismatch blocks; consumed effect key uses same value, only one execution |
| EFFECT-02 | Persist exact future Alex price set payload with target product, base revision, amount in integer cents, currency and effective time; show preview and approve then execute test effect | Same full strict canonical effect payload bytes determine safe owner preview, proposed hash, approved hash and commit parameters; no inference from preview/hash/IDs or changed price |
| EFFECT-03 | Tamper one stored payload field, replace preview, change target or contract version, remove required param, retire effect schema/executor or change referenced schedule assignments | Propose/approve/commit recompute strict Zod schema + deterministic payload hash, fail closed on mismatch or missing original immutable bytes/contract, no effect/audit of false applied outcome |
| EFFECT-04 | Register fifth-domain effect with versioned parameter schema, trusted preview and executor; supply unregistered effect type or free-text SQL/url/parameter | No central specialist code edits; only registered strict domain effect permitted, untrusted executable objects denied before draft/approval/commit |
| AUDIT-01 | Crash/restart between approved transition, outbox intent and provider receipt; original evidence later deleted | Immutable source manifest and identical effect hash remain auditable from stored proposal+approval metadata without a mutable snapshot lookup; pending recovery never claims applied or duplicates provider effect |
| CONTEXT-02 | Propose price or shift using preference+objective+guidance+workflow+policy revisions, then edit each separately **after proposal or approval** | Proposal/approval persists exact **contextFingerprint**, revision/absence manifest and separate **sourceSnapshotHash** plus original complete typed `sourceRefs`; material context or policy change blocks approval/commit until reproposed and reapproved |
| PREF-01 | Register two per-key strict Zod preferences, ingest old unknown JSON, wrong key/version, shape, range or free-text injection | Only known schema-versioned values/scope reach authorized specialist; invalid/unknown become needs_review/unavailable, never silent coercion; free text stays explicitly `untrusted_guidance` without authority |
| PREF-02 | Two co-owners differ in private preference; a confirmed shared preference is revoked or sensitive value filtered | No leak or stale cached value; scoped context fingerprint includes relevant revision/absence/revocation; actions blocked on context mismatch |
| IDEMP-01 | Same request ID/action key 10 retries and 2 concurrent owners | One resulting domain effect and one provenance chain; mismatched payload key conflicts |
| IDEMP-03 | Two concurrent co-owners submit **same approved proposal with different client request keys**, including a nonrevisioned external effect | DB `UNIQUE(business_id, proposal_id, proposal_revision)` plus deterministic effect/outbox uniqueness permits **one consumption and one effect**, derived from an `approvedEffectHash` verified identical to the original `proposedEffectHash`; second returns existing state or conflict without replay |
| IDEMP-04 | Provider times out after outbox claim; a second request key retries; then receipt arrives and original worker crashes/restarts | A durable consumed proposal resumes under same server effect key, never resends uncertain external effect blindly; reconciles actual receipt; no `applied` claim before verification |
| IDEMP-02 | Process crashes after effect commit, before reply or after provider timeout | Resume reconciles durable state; does not reapply effect/send again blindly |
| EVENT-01 | Replay event and cron simultaneously; change/reopen source evidence | One task lifecycle per fingerprint; meaningful new evidence reopens; previous resolved/snoozed tasks not resurrected spuriously |
| NOTIF-01 | Opt-out, quiet hours, no provider, uncertain provider receipt | No message delivered or claimed; only provider-confirmed sends count; provider absent keeps in-app task |
| MONEY-01 | Verified zero vs absent wage; 0/unknown/estimated sales, duplicate imported order/timecard, DST shift | Exact integer cents and coverage, no double labor counts; positive wage invalidates stale zero provenance |
| QUALITY-01 | Fresh/partial/stale, conflicting purpose-specific sources, estimated burden | Accurate status lattice and provenance, no misleading verified totals |
| COST-01 | 5 tools/3 model rounds baseline, slow third-party adapter, budget exhausted, model down | Deadline/fanout enforced; each owner goal receives verified result or explicit safe failure; no runaway expense |

Additional integration cases: unsupported attachment as evidence, worker acceptance absent, scheduling legal profile unknown, report/snapshot replay, two same-name employees, location and timezone/DST mismatches, idempotent action card review, price/schedule simultaneous requests, source conflicts that require owner confirmation, transaction audit failure, notification consent revocation between reservation and send. Use synthetic tenant fixtures, no production customer/worker PII.

### End-to-end architecture stress walk-throughs (design validation only)

These are **contract traces**, not claims that the future features already run. Every scenario must be repeated as a cross-module integration test with synthetic tenants before relevant implementation/activation. Each trace identifies **creator → validator → consumer → missing/revoked/version/failure**. No implementation beyond later Issue #74 phase is implied.

| Scenario / owner goal | Registered contracts and trusted lifecycle | Authorization, provenance, version, negative path and expected owner answer |
| --- | --- | --- |
| **E2E-01 Olivia: “Make next week's schedule” with wage missing** | Current merged foundation owner read (`foundation.server.ts`) is a source only when migrated/activated; later `olivia.availability.read` registered `ReadCapability`, strict staff/coverage entity+metric read; `olivia.schedule.preview` `SimulateCapability` calls pure `lib/calc/scheduling/`; `SimulationResult` carries only evidenced schedule coverage and bounded assumptions | Owner authenticated; confirmed availability, qualifications, local-day cap, legal unknown and wage provenance checked per purpose. If production migration/flag off return sanitized unavailable; if wage unknown, **no zero-cost or verified total**; if feasible roster exists but cost not known, show only evidence-qualified partial planning plus missing wage, no draft, publishing or worker contact |
| **E2E-02 Supervisor: Olivia plus Leo labor cost analysis** | Goal planner discovers `olivia.*` schedule simulation analysis and `leo.money.*` period metrics/analysis via literal bound `AnalysisInvocation`; validates selected `schedule_forecast` vs `payroll_actual` and per-purpose source rules; `lib/calc/staff.ts` and `lib/calc/profit.ts` retain money authority; `ReadResult`/`SimulationResult` merge only compatible validated results | Authenticated café/location/timezone and wage/timecard provenance. Planned future shifts are NOT worked timecards. If salary conversion, payroll tax or sales coverage missing or periods inconsistent, no combined “actual profit” or invented savings; return separately grounded partial/unavailable with data gap and next manual step |
| **E2E-03 Alex: “Change drink price to $X”** | Alex pricing `read`/`simulate` uses canonical recipe/menu cost; explicit `propose` persists full `canonicalEffectPayload` (product, cents, effective time, base revision), derived preview/hash and source+BusinessContext/policy manifest; separate owner `approve` copies exact bindings; policy-gated `commit` locks unique proposal consumption, validates original payload, writes only supported domain and rereads proof | Only authorized owner/explicitly delegated scoped actor; no LLM consent, no generic POS write. Stale price, ingredient cost, missing approval or revoked grant yields conflict/new proposal. Owner sees Applied **only** with `AppliedActionOutcome` persisted postcondition proof; uncertain remote receipt remains pending; concurrent retries never duplicate |
| **E2E-04 Maya: supplier price rise → cost analysis** | `maya.supplies.quote_compare` read/evaluate analysis invokes explicit `supplier_quote_review` purpose and typed bounded quote/product-cost readers; `sourceRequirementsByPurpose` pins quote provenance/status, comparable unit/date, approved canonical ingredient costs; Leo/Alex optional dependent read metrics use consistent periods | Owner-reported quotes are NOT verified invoices, purchased inventory or live stock. Absent comparable unit, matching recipe, confirmed quote or integration yields estimated/partial/unavailable; no unauthorized supplier reorder, financial total or proactive message. Evaluation may create a task only through a separate authorized reconciler and quiet-hour/consent gate |
| **E2E-05 two co-owners approve/commit same action** | Both actors enter independent authenticated `ApprovalTransitionInput` with proposal revision/hash and role/grant; server serializes approval conflict/CAS; `commit` loads exact approved identity and atomically inserts `UNIQUE(business_id, proposal_id, proposal_revision)` consumption and deterministic outbox intent | Tenant/privacy per actor and co-owner policy revision checked at every transition. First valid consumption wins **even with different request keys**; second receives existing safe executing/applied tracking or conflict, cannot execute/send again. Revoked grants invalidate pending approvals, and unsafe result branches leak no other actor IDs |
| **E2E-06 facts/preferences change after proposal** | `ActionProposal` pins exact typed effect payload/hash, versioned reader/selector/normalized arg manifest (including proven absence), full `sourceRefs` snapshot, `BusinessContext.v1` preference/objective/workflow revisions and policy grant refs | Approval **and** commit replay original selector semantics and compare versions/coverage, target and context. Wage, menu price, newly backfilled source, modified owner rule/preference or revoked grant conflicts; no replacing old hash with new data, no silent execution. Propose a new revision and request fresh explicit approval |
| **E2E-07 DB, provider or AI unavailable** | Canonical metric/entity/analysis/LLM reads use strict bounded schemas and grounded fallback; versioned workflow ledger/outbox/lease provides retry state; `VerifiedActionOutcome` differentiates executing/pending, applied proof and sanitized failure | Reader outage/missing POS → unavailable (never verified zero). AI provider failure → safe no-action reply or existing authorized facts, not fabricated capabilities. Remote timeout after write intent → pending reconciliation until verified provider receipt, no blind re-send. No unreviewed alert delivery, worker contact or success badge |
| **E2E-08 fifth specialist registers a new analysis** | Add only domain-owned compiled capability key+schema contract, `AnalysisDefinition<K,P>` with strict per-purpose invocation/source mapping and result, optionally metric/record readers plus localized display; shared planner/dispatcher discovers module exports | Type/CI checks I/O identity, complete source purposes, role/sensitivity/tenant, budget, verified evidence and result-status union; source-free purpose explicitly declares no external source and makes no café factual claim. Bad contract denied at startup, no central Supervisor routing branch, no extra owner chat or effect privilege |

**Stress-test result:** These eight traces are *specification-consistent only if* the gate and negative-path tests above are implemented and passed in future PRs. The unresolved real-world choices—delegation/spending scope, co-owner private vs shared preferences, pilot retention, legal applicability and opt-in notifications—are owner/product policy **decisions**, not permission to weaken strict default-deny behavior. Do not claim any new scheduling plan, cost saving, external connector, worker acceptance or automation is currently deployed.

## 15. Risk register, tradeoffs and avoided overengineering

**R1 — Review packet reconciled; external verdict not yet provided:** the attachment has been read and reconciled. It contains the architecture proposal and instructions **requesting** an independent critical A–H verdict, not that verdict. Its availability is resolved; fresh reviewer sign-off and owner product/policy decisions remain necessary before implementation.

**R2 — Regressions from replacing today's central router:** keep legacy read adapter and strict grounded final writer, test existing semantic fixtures first, shadow run before switching. Do not replace all existing tools in one commit.

**R3 — Catalog gives illusion of data coverage:** metric metadata is not data. Implement quality, coverage and unsupported granularity as first-class result states; "every metric" must mean every **supported** metric, never database-wide universal facts. No POS/bank/inventory assumption.

**R4 — Approval and rules conflated:** natural-language owner rules remain text. Specific, expiring, version-bound approval and later separately reviewed delegation are mandatory for effects.

**R5 — Scheduling provenance/payroll double counts:** merged #72 compensating positive-wage-over-zero and overnight local-day-cap corrections are **regression invariants**; legacy materialized predicted timecards, external planned shifts and legal rules remain separate hard gates. No planner publication without source/role/time/wage tests, separate verified activation and explicit owner action.

**R6 — Durable workflows increase schema/operational complexity:** do not add a job store until first approved effect or proactive evaluator needs it; keep atomic domain transactions and minimal outbox, not distributed workers.

**R7 — Cost/latency explosion from multi-agent prompting:** one Supervisor reasoning boundary with shared deterministic tools; specialist is a typed responsibility, not four sequential expensive LLM conversations.

**R8 — "universal" routing becomes lowest-common-denominator domain logic:** registry protocol stays narrow; domain validation, solvers, financial formulas and source precedence remain specialist-owned/canonical.

**R9 — Notifications and legal/privacy:** WhatsApp owner messages are opt-in and current UTC cron; avoid reusing as employee messaging or asserting location quiet hours without additional tests. Staging / counsel or compliance review as appropriate.

**R10 — Source freshness, legal and data reliability:** unsupported worker opt-in, hourly sales, tax/benefits and supplier quantities must not be generated by a model. Unknown data preserves unknown consequences.

**R11 — Catalog coverage drift:** the starter list is not an exhaustive inventory. Without P1 audit and bidirectional CI tests, a new metric/record can become silently unqueryable (or, worse, erroneously claimed available). Do not claim universal coverage complete until the audited manifest passes.

**R12 — Context and interruption creep:** owner preference/LLM memory and growing proactive alerts can worsen privacy, overwhelm owners or silently confer authority unless **per-key schema validation** and explicit confirmation/versioning, digest/quiet hours and workload measures constrain them.

**R13 — Ambiguous approval versus execution:** an untyped approve command can collapse proposing into committing or permit fake owner consent. Use the explicit `approve` registry mode and typed persisted approval envelope; source, BusinessContext and policy must agree when committing.

**R14 — Cross-request duplicate effects:** client-key-only idempotency does **not** stop two request IDs consuming one approved proposal, particularly purchases/sends without a DB row revision. Enforce unique proposal consumption and server-derived effect identity in atomic DB/outbox operations.

**R15 — Unrecoverable source evidence / effect-hash stage confusion:** a source hash without persisted typed revision/selection references cannot support historical audits or deleted/superseded source revalidation; treating `approvedEffectHash` as an unapproved proposal field permits divergent effect identities. Require the full immutable source manifest in proposal and approval, and enforce exact `proposedEffectHash → approvedEffectHash` copying before execution.

**R16 — Reader/selector semantics drift without data revisions:** source-precedence policy revision and selectionKey alone cannot detect a changed filter/default/coverage rule, especially for a confirmed empty result. Persist semantic reader/selector versions **and** strict canonical selection args/hash, review/test version bumps, and fail closed if the original selector contract is unavailable.

**R17 — Unauthorized approval-result metadata leaks:** a union with nullable approved fields can still serialize source/context/policy details in rejected/unauthorized branches. Use strict state-discriminated schemas/serializers, omit all approved/private bindings in unsuccessful responses and retain sensitive failure audit only server-side.

**R18 — Hash without executable effect parameters:** an effect hash is not an instruction. If a price/schedule/purchase change is reconstructed from preview text or mutable domain state, the executed action may not match consent. Store immutable canonical typed effect bytes/parameters, derive hash/preview from them and revalidate exact schema/version/bytes at propose, approve and commit; unregistered effects remain unavailable.

**R19 — Erased mode type boundaries:** a shared `execute` method/result that permits `proposal:ActionProposal|null` for reads can smuggle unapproved drafts. Six discriminated descriptors and results, strict Zod parsing, mode-scoped service access, and a commit-only effect gateway are mandatory; runtime and type-check negative tests cover every mode.

**R20 — Unregistered metric filters/purposes:** a generic metric filter record and unbounded purpose string can bypass source/role/granularity limits or lead to bespoke central routing. Require per-metric strict schemas, permitted purposes, source-selection mapping, authorization and bounded limits, validated before readers by one generic dispatcher.

**R21 — Malformed metric output bypasses trusted facts:** strict metric input checking is not enough; unchecked money/series can inject fractional cents, NaN, Infinity, misleading units or false complete data into owner replies. Require **per-metric full output and audited value/point schemas**, cross-field status/coverage/provenance and source constraints, strict validation before caching/aggregation/UI, and safe unavailable on failure. Tests METRIC-03/04/05 and no false zero.

**R22 — Invisible analytical access surface / special-case dispatcher:** an analysis without a versioned registry entry and bound typed capability bypasses consistent tenant policy, source attribution, budgets and unsupported handling. Require `AnalysisDefinition` with strict I/O, source/coverage policy and bounded execution, bound to read/simulate/evaluate by ID/version/mode, validated in registry+dispatcher. Tests ANALYSIS-01/02/03 and EXT-04; recommendations are **not** permission to propose/commit.

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
| PR #72 and Staff/timecards (§§10–11) | **Preserve:** separate scheduling-domain delivery, `lib/calc/`, no-POS manual input, staff/cost provenance, no direct Supervisor changes in the merged PR #72 | **Current-state update:** #72 merged at `a3f5f2f` with compensated-wage and overnight local-day cap correction tests; continue those as regression fixtures. Applied production migration and feature activation remain unverified, while optimizer PR #77 is now merged; publication and Supervisor adapter work remain future. Original packet predates the merge |
| Packet examples: Maya inventory and Leo bank/cashflow (§4) | **Disagree if described as present:** supported supplier quotes are not stock counts, and no connected bank feed is verified; advertise unavailable until connectors and canonical sources actually exist | Future integration requirements remain independently reviewable, not reasons to expand PR #73 |
| Success measured by reduced owner workload (§§1,7,12) | **Accept:** owner hours saved, manual decisions, routine completed effects, false alerts, unresolved issues and verified failures with baseline/quality guardrails (§10.2) | Owner and pilot must select valid denominators, baseline sampling and success thresholds |

**Alternative considered:** A purely modular Supervisor adding new hand-coded tool branches per domain is smaller at first but keeps the demonstrated central schema/permission/response churn and eventually duplicates metrics, workflows and interruption policies. A fully generic autonomous agent framework is substantially more costly and increases security/latency risks without owner-value evidence. **Recommended middle course:** typed in-process registry, canonical reads and verifier immediately; durable effect ledger and outbox only after a safe business case is implemented. This is an architectural preference needing review, **not a measured performance result**.

**Issue #74 long-term roadmap alignment:** [AI CAFE Universal Supervisor & AI Team Delivery Roadmap — Issue #74](https://github.com/killbill2792/aicafe/issues/74) is the binding **future-session tracking/merge-gate checklist**, not authority to merge/deploy. Preserve platform P1 inventory and access, P2 typed capabilities/preferences, P3 shadow-compatible multi-domain reads, P4 approvals/idempotency, P5–P6 real proactivity; Olivia PR #72 then 1B/2/3 and adapter, Alex/Maya/Leo, optional integrations and owner-time evidence remain separately staged. The roadmap tracks code status, tests, deployment gates and follow-on decisions; this architecture specifies contracts. After **separately approved merge**, a **different small docs-alignment PR** may link #74 from AGENTS.md/PROGRESS.md and other historical docs. **The only additional file updated in this documentation-only PR #73 is `docs/scheduling-architecture.md`**, to reconcile the already-approved Olivia product decision. No application source, migration or flag changes. Do **not** check off #74 implementation milestones based on a docs-only architecture design.

**Remaining explicit owner/security approvals:** choose initial involvement mode (hands-on/assisted/delegated preferences are never grants); action/delegation effect allowlist and risk thresholds; co-owner private/shared preference and rule correction rights; staff-sensitive field visibility vs aggregate reads; quiet-hour and true urgent exception policies; approved pilot targets and measurement/privacy retention; proposal-to-action UX; eventual provider-independent effect reconciliation; compatible grounded card renderer extension. None authorizes an immediate POS write, salary change, schedule publish or worker message.

**Packet checklist disposition:** future specialist extensibility **specified but untested**; deterministic approval veto **specified but not implemented**; durable crash-safe execution **specified but not implemented**; cross-domain grounded result **specified but not implemented**; no-POS manual mode and independent Olivia track **preserved as binding requirements**; proposed/approved/applied visibility **contracted, not deployed**; simpler alternatives **considered with hybrid choice**. The architecture is **ready for a new critical architecture review**, not yet independently approved or ready for feature implementation.

### 15.2 Reconciliation of Codex's four findings on PR #73 commit `59b9299`

All four concerns are **accepted design corrections**, not deferred product choices. They were findings against a prior **documentation commit**; the following contracts are now specified but remain **unimplemented** until separately reviewed later phases.

| Codex finding | Contract amendment | Mandatory future gate |
| --- | --- | --- |
| **P1: approval missing from typed modes** | `Mode` explicitly includes `approve`; `ApprovalTransitionInput/Result` and §8.2 require an authenticated, exact-proposal **no-effect** approval independent of `propose` and `commit` | Registry/dispatcher schema checks and **APPROVE-01/02**; no model-created approval, no implicit publication |
| **P1: stale BusinessContext not bound to proposals** | `ActionProposal` binds `BusinessContext.v1` fingerprint + complete material preference/objective/guidance/workflow revision references **and** separate canonical source snapshot and applied policy/grant revisions; approval copies the exact binding | **CONTEXT-01/02**, AUTH-02 and PREF-02; compare at approval **and at commit**; changed/unknown/revoked/expired material references fail closed |
| **P1: request-key dedupe does not enforce single-use proposal** | `UNIQUE(business_id,proposal_id,proposal_revision)` consumption and unique deterministic effect/outbox key independent of client key; atomically reserve+commit/reconcile with typed state | **IDEMP-01/02/03/04**, cross-owner different request keys, race, crash/provider timeout; never duplicate delivery or falsely report success |
| **P2: untyped preference key/value and free text** | Reviewed versioned per-key Zod schemas, typed discriminated preference values, sensitivity/scope access and unknown-version denial; explicit `untrusted_guidance` lane separate from authority | **PREF-01/02**, CONTEXT-01/02 and no prompt-injection/policy escalation |

**Architectural sign-off status:** the defects have been corrected **in the proposed contract**; future CI, database uniqueness, security and product validation remain prerequisites. The current fresh Codex reviewer must confirm no blocking specification gaps, and the owner must separately approve any merge and later implementation. These changes do not repair/alter Olivia PR #72 or check off Issue #74's implementation tasks.

### 15.3 Codex re-review on `6cd278a1`: source revisions and effect identity

The next Codex review of commit `6cd278a1` identified two additional contract inconsistencies: **P1** (the proposal and approval preserved an opaque `sourceSnapshotHash` but not the typed canonical source revision manifest) and **P2** (the proposal's preapproval `proposedEffectHash` was incorrectly called `approvedEffectHash` in the §9 identity definition). Both are **accepted and corrected in this documentation design**:

- **P1 — source manifest:** `CanonicalSourceRevisionRef` now specifies each originally selected canonical record/revision and its reader, purpose, precedence policy/version, selector scope and time period, plus any **verified complete absence**. `BusinessContextV1.snapshot.sourceRefs` and `ActionProposal.sourceRefs` are typed. Every immutable proposal stores the complete original manifest **alongside** its `sourceSnapshotHash`; successful typed approval copies the exact immutable list into `approvedSourceRefs` alongside `approvedSourceSnapshotHash`. Original source selection and full manifest are re-evaluated at approval/commit; deletion, supersession, selection change, backfill or inability to verify safely requires conflict/reproposal. Test **SOURCE-01/02/03** and **AUDIT-01**; required P2/P3/P4 gates above.
- **P2 — effect identity:** before approval the one-effect identity is `(businessId, proposalId, proposalRevision, proposedEffectHash)`. Only a successful typed `approve` transition can copy `proposedEffectHash` **unchanged** into `approvedEffectHash` for the approval/consumption/outbox identity; the original proposal field remains named and immutable. A mismatch is rejected, never silently substituted. Test **EFFECT-01**, APPROVE-01/02 and IDEMP-03/04; required P4 gates above.

**Issue #74 remains authoritative for the delivery sequence and merge gates**, not an instruction to start P1–P6 or edit PR #72. The design corrections are specifications only, **not implemented migrations, provider confirmation or production-tested behavior**. Fresh Codex review and an explicit owner merge decision are still required; leave draft #73 open until those gates clear.

### 15.4 Codex re-review on `b5ab39b`: selector contract versions and approval privacy

The fresh full-PR review of commit `b5ab39b` reported two further precise specification issues, accepted as **required security/correctness corrections** rather than speculative features:

- **P1 — Source reader/selector contract version and arguments:** `CanonicalSourceSelection` now preserves the **canonical reader's semantic version**, **selector ID/version**, strict normalized filter arguments and canonical selector-argument hash independently of the source-precedence policy/version. The immutable source manifest and `sourceSnapshotHash` commit to those semantics, including verified `confirmed_absent` coverage proofs. At approval/commit, **replay the exact original version/normalized arguments** and compare all source revisions/absence coverage; absent old selector version, changed defaults, filters, coverage policy or source selection fail closed. No arbitrary model SQL or silent remapping. P2/P3/P4 gates and **SELECTOR-01/02/03, SOURCE-02/03** tests require this.
- **P2 — Strict successful versus unsuccessful approval types:** `ApprovalTransitionResult = ApprovedTransition | UnsuccessfulApprovalTransition` is state-discriminated. **Only `state:"approved"`** returns non-null copied `approvedEffectHash`, `approvedSourceSnapshotHash`, `approvedSourceRefs`, `approvedContextFingerprint`, `approvedContextRevisionRefs`, and `approvedPolicyRevisionRefs`. Other statuses (`rejected`, `unauthorized`, `expired`, `conflict`) **omit**, rather than null or fabricate, all approved bindings/IDs, with a safe error code and opaque request identifier; strict Zod object schemas reject extra keys. Secrets and source/context/policy revisions stay server-side in failure audit. P4 gates and **APPROVE-03/04** tests require this.

**No architectural implementation or runtime security improvement is claimed by a documentation edit.** The [Issue #74 roadmap](https://github.com/killbill2792/aicafe/issues/74) retains ownership of merge/rollout gates and separate P1–P6 implementation, Olivia PR #72 / follow-ons, Alex/Maya/Leo, integrations, legacy-compatibility checks and verified owner time savings. This document is ready to request a fresh **whole-PR Codex review** before any owner-authorized merge; no app code, feature flag, migration or deployment is authorized.

### 15.5 Codex whole-PR review on `0cce78b8`: exact effect payload, six mode contracts and metric security

The next whole-PR Codex review flagged **P1 ×2 and P2 ×1** on documentation commit `0cce78b8`. These findings are accepted **architecture corrections**, not evidence of deployed fixes:

| Finding | Contract correction | Future proof gate |
| --- | --- | --- |
| **P1: hash without exact effect payload** | `ActionProposal.canonicalEffectPayload` stores complete immutable capability/version-discriminated, strict domain Zod-validated parameters and target/expected revision. Trusted renderer derives owner preview **from that payload**; `proposedEffectHash` hashes canonical bytes. Approval reloads/revalidates original schema, params/hash/preview, copies unchanged hash to approval; **commit reloads/revalidates same exact bytes and executes only this typed payload**, never mutable state or untrusted preview. Missing original schema/payload denies. | **EFFECT-02/03/04**, APPROVE-01/04, IDEMP-03/04; P2 contract registry and P4 executable transaction gate |
| **P1: read/simulate/propose/evaluate share unsafe descriptor/result** | Six `mode`-discriminated descriptors **ReadCapability, SimulateCapability, ProposeCapability, EvaluateCapability, ApprovalCapability, CommitCapability** with unique typed callbacks and strict runtime result variants. Read/simulate/evaluate contain `proposal:null`, propose returns only inert draft, evaluate only findings, approve authorization without effect, and **only commit** can call the reviewed domain executor. Least-privilege service interfaces/RLS and strict output validation supplement static type checks. | **MODE-01/02**, SIM-01, APPROVE-01/03 and EXT-04; P2/P3 shadow and P4 action boundaries |
| **P2: metric-specific filters/purposes not registered** | Every `MetricDefinition<F,P>` declares strict full-query, filter and dimension schemas; allowed purposes, granularity, periods, registered source-selector requirements, sensitivity/access policy and cardinality/time/row/range limits. One dispatcher validates **all** per-metric contracts **before** canonical reader access, with no arbitrary SQL or specialist-specific central exceptions. | **METRIC-01/02**, COVER-01/02, BACK-03, SEC-01 and EXT-04; P1 CI inventory and P3 read cutover |

**Whole-document invariant check to repeat during implementation:** (a) one owner-facing Supervisor and supported-but-authorized metric/entity access; (b) typed independent agent registrations and no central router exceptions; (c) read/simulate ≠ propose ≠ approve ≠ commit, with verified `evaluate` task reconciliation distinct; (d) exact immutable payload and provenance manifest/source selector, BusinessContext/policy and grant revisions bind one approved effect; (e) one-time DB consumption across distinct client request keys and fail-safe outbox; (f) canonical `lib/calc/`, owner consent, owner time/interrupt reduction, legacy EN/ES/AR, no-POS/manual, Olivia PR #72 and domain follow-ons remain separate; (g) default-off capabilities and migrations require an independent implementation/owner release gate.

**GitHub Issue #74** remains the long-term P1–P6, Olivia 1B–3, Alex/Maya/Leo, optional integration and measurable owner-time roadmap. Neither this architecture-only PR nor a successful documentation review checks off implementation deliverables or authorizes a Supabase migration, production deployment, external transaction or auto-merge. **Fresh whole-PR reviewer/owner sign-off is outstanding until returned.**

### 15.6 Codex whole-PR review on `eff2834c`: metric output safety and analytical registry

Codex's latest whole-PR review of prior documentation commit `eff2834c` identified **P1 ×1 and P2 ×1**. Both are accepted and corrected **in the proposed architecture contract**, not in shipped code:

| Finding | Specification correction | Required future implementation verification |
| --- | --- | --- |
| **P1 — metric reader output lacks strict schema** | Each `MetricDefinition<F,P,V>` now registers a **strict full `outputSchema`** and discriminated `valueContract` with audited scalar/series validators and unit/value-kind consistency. Money must use **safe integer USD cents**; every numeric point finite; correct count/minute/ratio/boolean kinds, ordered bounded timezone-aware series, validated per-point status and provenance; overall verified/partial/unavailable statuses must match actual coverage, source revisions, conflicts and non-null/null values. Dispatcher revalidates the **exact returned metric** before cache, cross-domain analysis or owner reply. Invalid output is quarantined as safe unavailable, never rounded, coerced or shown. | **METRIC-03/04/05**, METRIC-01/02, MONEY-01, QUALITY-01, COVER-01/02; P1 CI+dispatch and P3 grounded parity, including wrong unit/missing source, null-vs-zero and cross-tenant results. |
| **P2 — no typed analysis registration** | `AnalysisDefinition<K,P>` is a separate cataloged surface and **derives its I/O and mode from one literal compiled registry key** (corrected in §15.7); it **binds to one existing exact typed `read`/`simulate`/`evaluate` capability ID/version/mode**, never a new generic **unregistered** executor. P3 may register a separately reviewed, concrete typed `simulate` capability whose implementation interprets a bounded declarative math AST (§6.2); any exposed analysis still binds to that **one exact existing registry key/I/O/fingerprint** and cannot generate or dispatch arbitrary runtime capabilities. It declares strict analysis input/output schemas, authorized business/location/private scope, purpose, sensitivity/fields, prerequisite metrics/entities, versioned source readers/selector policies, provenance/actuality/coverage, BusinessContext and finite budgets. Generic dispatcher checks registration, role/tenant/sources/inputs before execution and strict verified result/evidence after. A recommendation is not a proposal/action; separate typed P4 gates apply. | **ANALYSIS-01/02/03**, EXT-04, COVER-01/02, MODE-01/02, MULTI-01/02; P1 inventory, P2 registry/shadow, P3 no-regression and P5/P6 when Olivia/evaluators are implemented. |

**Whole architecture invariants retained:** one café-owner Supervisor; all *authorized supported* metric/entity/analysis access without arbitrary SQL; extensible Olivia, Alex, Maya, Leo and fifth domain; strict six-mode read/simulate/propose/evaluate/approve/commit fences; exact immutable typed effect payload and source version manifest; policy/BusinessContext revalidation; one-time proposal consumption across different request keys; approved-only private bindings, provenance and safe unknown; canonical integer-cent `lib/calc/`; EN/ES/AR, current Supervisor and Olivia PR #72 compatibility; manual/no-POS, opt-in proactive work, interruption reduction and audited owner time saved.

**Issue #74 remains the governing delivery roadmap** for platform P1–P6, Olivia 1B/2/3 and later integration, Alex/Maya/Leo, legacy tests and production controls. This PR contains documentation only, not executable test results, migrations or enabled integrations. Request a **fresh complete PR Codex review**; retain draft state until reviewer and owner separately clear merge, and **never** run production Supabase migrations or auto-deploy.

### 15.7 Codex whole-PR review on `52726fc9`: final contract binding and status corrections

The latest review flagged **three genuine correctness/safety contract gaps**. This is a targeted amendment to the existing contracts, **not a broader redesign**:

| Finding | Narrow correction | Required future proof |
| --- | --- | --- |
| **P2 — analysis I/O binding erased by string ID** | `AnalysisDefinition<K,P>` now derives **mode, input/output Zod schema types and exact schemaContract identity from a concrete literal key `K`** of `compiledCapabilityRegistry`; only reviewed read/simulate/evaluate keys can bind. Startup compares concrete key/version/mode and the same registered schema object/contract id/version/fingerprint, rejecting missing, mismatched or incompatible contracts. | ANALYSIS-02/04; P1/P2 registry CI and fifth-domain fixture |
| **P2 — source requirements may omit an allowed purpose** | `sourceRequirementsByPurpose:Readonly<Record<P,AnalysisSourceRequirements>>` is exhaustive for the literal, unique `allowedPurposes` set; compile-time `satisfies` plus strict startup **exact own-key equality** reject missing, extra and duplicate purposes. Every purpose declares either bounded versioned `registered_sources` reader/selector/provenance/actuality/coverage requirements; a `preauthorized_operands` case with immutable, independently authorized versioned leaf manifests and no new evaluator reads; or an explicit `no_external_sources` empty-input, pure-validated-input-only case. The three branches are disjoint and exhaustively checked at registration and dispatch. | ANALYSIS-05/06/08; P1 inventory/P2 registry/P3 dispatcher |
| **P2 — success/failure result payload unsafe** | `VerifiedCapabilityResult<T>` is a **status-discriminated** union: `verified` has non-null typed payload and complete eligible evidence, `estimated` and `partial` have non-null qualified typed payload with validated assumption/coverage, while unavailable/failed/conflict/insufficient-evidence/requires-approval require `payload:null` and **omit private source, conflict, fingerprint and executable fields**. `ReadResult`, `SimulationResult`, `EvaluationResult` and all analyses use the exact strict mode/status runtime schemas. `ProposalResult` additionally forbids a draft on failed creation; entity/metric failure envelopes match privacy boundary. | STATUS-01/02/03, MODE-01/02, ANALYSIS-03, METRIC-05 and SEC-01; P2/P3 schema and cross-tenant tests |

**Internal contract-compatibility audit (specification only, not application test execution):**

| Surface | Typed input and output | Authorization and validation | Effect / privacy boundary |
| --- | --- | --- | --- |
| Metric | Per-metric query/filter/dimension schemas; exact safe unit/value/series + strict result/status schema | Tenant/role/purpose/period/source+coverage, bounded limits; verify output before use | Failed results null with no private query/provenance; money remains `lib/calc/` canonical |
| Entity read | Versioned field-limited I/O schemas with sanitized failure status | Row/field/RLS, purpose and bounded pagination | Failed reads expose no record or source refs |
| Analysis | Literal registry key `K`, same registered input/output schema references, schemaContract ID/version/fingerprints, purpose-exhaustive selection | Tenant/role/fields, source/selector revision and coverage, budgets; key/contract equality at startup and results at dispatch | No external-source case explicit; read/simulate/evaluate only, no proposals/effects |
| Read / simulate | Mode-specific strict `ReadResult` / `SimulationResult` over status union | AuthorizedContext; exact mode/input/output schema and provenance/quality checks | `proposal:null` always; failure sanitized; simulation transient |
| Evaluate | Registered strict `EvaluationResult` of typed findings via status union | Same analysis/tenant/evidence gates, bounds and verification | Failure no findings; dedicated task reconciler only, no direct mutation |
| Propose | Strict `ProposalResult` + persisted immutable effect/source/context bindings | Capability/effect schema, policy/grant, source/version and exact canonical hash | Successful inert draft only; failure `proposal:null`; no execution |
| Approve / commit | Existing distinct strict result contracts, exact original proposal/effect payload manifest | Authenticated authority, versioned source/context, one-shot proposal consumption/idempotency | Approval no effect; only policy-authorized commit invokes domain executor |

**Blocker versus refinement rule:** A missing/mismatched contract, selected-purpose or source gap, invalid verified payload or missing applied postcondition proof, privacy leak, unauthorized action, or loss of idempotency is a **blocking defect**. Alternative registry factoring, extra optional fields, new provider connectors, UI design preferences or speculative general frameworks are **nonblocking refinements** unless they demonstrably violate a stated acceptance test or security invariant. No P1–P6 implementation, Olivia PR #72 changes, new feature activation, provider actions or production Supabase migrations are part of this PR.

**Issue #74 remains the full delivery roadmap and release-gate tracker.** Request **one fresh whole-PR Codex review** only after a document-wide audit; keep PR #73 draft/unmerged and require separate owner approval for any merge and later implementation.

### 15.8 Latest full-PR Codex P1/P2 findings and self-correction audit against merged main

**Resolved architecture findings from review of `06fd6296`:**
1. **P1 verified commit results:** `VerifiedActionOutcome` now discriminates `applied`, in-flight and unsuccessful cases. `applied` requires **durable postcondition proof**, nonempty source revision evidence, verified effect/target revision and audited verification timestamp. Failed/rejected/conflict responses omit private/executable fields; provider uncertainty is pending, not Applied. Verified `CommitResult` rejects malformed output at the trusted server boundary (**COMMIT-01/02/03**).
2. **P2 selected analysis purpose:** each invocation has strict `AnalysisInvocation<K,P>.selectedPurpose` and registered `invocationSchema`. The server validates exact purpose + bound key/version and input **before** readers, selects only `sourceRequirementsByPurpose[selectedPurpose]`, and persists purpose in evidence/request fingerprint. Missing/mismatched selected purpose fails closed (**ANALYSIS-07**).
3. **P2 merged Olivia foundation:** #72 merged at `a3f5f2f`; documented current source files and separate migration-ledger, activation, planner, publish, Supervisor adapter and proactivity/notification gates. Historical `docs/scheduling-architecture.md` PR 0 wording does not undo merged code or authorize production activation (**OLIVIA-01/02**).

**Contract origin, validation, consumption and failure audit:** Verified registration constructors originate in domain-reviewed modules, with the platform compile-time manifest and startup validating exact schema/contract/version, tenant/actor policy, complete purpose mappings and resource caps. `AuthorizedContext` is server-created for each invocation; the dispatcher selects a validated source purpose and checks RLS/reader/selector and policy versions before reading. Canonical domain readers create source refs, the pure calculation layer creates numbers/preview results, and the registered Zod output schema plus source/quality checker validates all data **before** the Supervisor can consume it. Inert `ActionProposal` creation stores exact typed effect bytes+source/context/policy identity; only a distinct authenticated approval can authorize that exact revision and only commit can consume it once; the domain verifier creates the postcondition proof, and the owner-visible applied serializer consumes it only if durable/revalidatable. Missing/expired/revoked/changed permissions or schema/source versions deny or require reproposal, not silent fallback; domain failure returns sanitized null/partial or pending reconciliation without re-executing. These paths map to the E2E fixtures and test matrix, not to unimplemented runtime behavior.

**Pre-review internal inspection:** reviewed `AGENTS.md`, `docs/01-product.md`, `docs/05-calculations.md`, `docs/09-ai-native-operating-system.md`, `docs/scheduling-architecture.md`, current `toolRegistry.server.ts`, `runSupervisorTurn.server.ts`, `supervisorRequest.mjs`, `tools.ts`, `cafeTools.server.ts`, existing policies and merged PR #72's source. Earlier P1/P2 review findings in this PR were reread for regression. §7/§9 canonical effect approval and one-time consumption, §4/§5 mode and catalog typed checks, §6 context privacy, §10 owner-interruption policy and §12 RLS/LLM data authority remain binding. See E2E-01–08 for creator, validator, consumer and failure path consistency, and full earlier §§15.2–15.7 for fixed historic findings.

**Hard acceptance checkpoint by implementation phase:** P1 registers every supported metric/entity/analysis with strict I/O, authenticated source/coverage and no SQL; P2 passes typed+runtime mode/status/bound-purpose/schema version negative tests; P3 **actually integrates** dynamic OpenAI capability discovery and bounded COMPOSE-01..08 read-only novel what-if calculations into the compatibility-flagged Supervisor chat, **not merely shadow tests**; it preserves EN/ES/AR/grounding/parity, multiple goal clauses and legacy rollback; P4 tests complete exact payload, owner/delegate permission, durable postcondition proof, one-time consumption under two request keys, DB crash/provider receipt uncertainty and audit privacy; P5 checks merged #72 migration/activation **separately** from optimizer and schedule-publish adapter; P6 verifies task/notification consent, retries, quiet hours and owner-time outcomes. A **known failure** of any of these invariant contracts remains a blocker; implementation details, novel delivery channels or additional agent features remain phase work tracked in [Issue #74](https://github.com/killbill2792/aicafe/issues/74), not a reason to redesign P0.

**Independent verification remains required:** This PR is **documentation only**. The example TypeScript types and Zod requirements are specifications, not compiled executed schemas. Successful structural/self-review is not independent Codex approval, production migration success, activated capabilities or owner merge permission. Future reviewers should prioritize observable type/runtime inconsistencies over optional taste-level design changes.

### 15.9 Latest Codex P2 scope finding: approved Olivia exception, outdated domain-document wording

The whole-PR Codex review of `ff7a7999` raised **P2: “Restore the unresolved scheduling scope gate.”** Its premise is out of date: **`docs/01-product.md` already contains explicit owner approval** under “Approved core capability: Olivia owner-directed scheduling”; it expressly preserves the prohibition on an *unrelated standalone POS scheduling clone*, general payroll processing and automated POS write-back. The older `docs/scheduling-architecture.md` §1 “Product conflict to resolve” and §9 item 1 “owner sign-off required” predated that source-of-truth change and have now been **directly corrected** in the scheduling document **on PR #73**, without creating another PR or changing the approved product boundary.

**Binding decision:** do **not** reopen owner product authorization for the same Olivia scheduling capability. Treat it as a **resolved product-scope decision**, while preserving the separate hard gates established in §13: production migration-ledger validation/authorization, owner-only/default-off manual foundation activation, legal/wage/coverage provenance, independent pure optimizer, immutable plan revision with explicit approve-and-publish, shared Supervisor capability adapter, real provider/worker consent and quiet-hour controls. The product permission neither grants effects nor proves anything deployed. Source of truth: `docs/01-product.md` § approved scheduling and its amended “Don't build” section; supporting contract: `docs/scheduling-architecture.md` §§1/9/10 and this architecture §13. Future test `OLIVIA-03` catches a return of the false “sign-off pending” claim without weakening any release/safety gate.

**Diff scope:** this exception updates exactly two documentation files in existing PR #73; older source-reconciliation notes are retained for audit history. No runtime, migrations, permissions, feature flags, external integrations, prod Supabase changes or deployment occurred. Issue #74 retains all implementation and release milestones.

## 16. Proposed targeted documentation alignment AFTER approval

Do **not** edit the following documents further in this architecture PR, **except the already-completed narrow correction in `docs/scheduling-architecture.md` establishing existing Olivia product approval**. Remaining broader documentation alignments follow after owner-approved merge:

1. **docs/09-ai-native-operating-system.md:** add an explicit link to this platform contract and replace any now-obsolete "no shared structured tool surface" state with historical context; retain lib/calc/ and source-aware state as binding.
2. **docs/scheduling-architecture.md:** **already updated in this PR only to reconcile product-scope approval, merged PR #72 status and a short shared Supervisor adapter cross-reference**. The full later P1–P5 cross-file harmonization remains separately gated. Retain domain constraints, Olivia phase sequence, timecard/worker distinction and no-POS guarantee; a future PR 4 adapter registers into the common platform after P1–P3 and reviewed domain readiness.
3. **docs/supervisor-phase4-grounded-chat.md / phase5-owner-rules.md:** explain that legacy read-only tools are compatibility adapters and owner rule approval still cannot grant action authority. Do not rewrite their history.
4. **docs/01-product.md / 03-screens.md:** maintain the explicit owner-approved *Olivia* scheduling exception (already proposed in #72) and single Supervisor/Staff/Operations journey, rather than introducing separate specialist chat screens.
5. **docs/04-data-model.md, 06-integrations.md and 07-build-plan.md:** add only reviewed workflow/outbox/metric provenance dependencies and opt-in rollout steps **when** matching implementation PRs exist, not speculative tables at P0.
6. **AGENTS.md / PROGRESS.md:** **superseded for PR #81:** both are deliberately updated with the owner-approved P3 open-ended composition requirement and handoff. Future broader historical-document alignment remains separately reviewed; no Next.js rules or financial invariants are changed.

### P0 verification and exit criteria

**PR #81 successor exit criteria (supersedes the historical PR #73 file list):** Before merging this **documentation-only** PR, check: (a) its only changed files are **AGENTS.md**, **PROGRESS.md**, and **docs/supervisor-platform-architecture.md**; (b) no change to main or PR #72 from this branch; (c) the attached RFC/review packet was compared without falsely treating its *requested* external verdict as delivered and a **fresh Codex/architecture review** has been requested and addressed; (d) owner and reviewers decide open privacy, delegation, context, metric coverage and interruption contracts and validate P1–P3 backward-compatibility and Olivia gates; (e) no production DB migration, POS connection, env flag, Vercel change or deployment was made. P0 is a design contract, **not** test-passing application code or a claim that future integrations already exist.
