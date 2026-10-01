# AI-native Coffee Operating System architecture

## Current state

The application already has the right core shape: raw POS, catalog, staff, expense, and recipe data
is stored in Postgres; pure functions in `lib/calc/` produce financial facts; server data services
assemble read models; and view models prepare those facts for the UI. POS adapters are read-only and
provider-neutral. Ingredient prices and transactional facts retain history. Existing AI use is
limited to unstructured input assistance (receipt reading, voice parsing, and statement
categorization), with deterministic vendor and keyword rules taking precedence.

The main weaknesses are architectural rather than product failures. `BusinessSnapshot` is focused
on current screens rather than being a composable café-state contract. Alerts are persisted UI
records rather than reusable machine-readable signals. There is no common decision/outcome model,
forecast boundary, internal domain-event contract, or structured tool surface. AI completion is
provider-switched, but there is no provider-level `NoAIProvider` contract for reasoning and
explanation. Suggested pricing is also calculated in a client component using a single ingredient
ratio, so it cannot carry data quality, evidence, or business context.

Inventory and suppliers are not present in the current product. They must therefore remain
explicitly unavailable in the state model; this foundation does not invent either dataset or add
inventory-counting UX, which remains outside the current product scope.

## Reusable components

- `lib/calc/` is the authoritative deterministic financial core. Recipe cost, loaded staff cost,
  profitability, per-drink economics, break-even, and cost recovery remain the only calculation
  paths for UI, policies, and future AI tools.
- `daily_rollups`, raw orders, timecards, expenses, recurring costs, and dated ingredient prices
  provide both current facts and historical query boundaries.
- `BusinessSnapshot` and the existing view models are retained as screen-optimized projections.
  The new café state composes these facts rather than replacing working screens.
- POS adapters, Supabase RLS, and provider-neutral structured AI extraction are retained.
- Existing alert generation demonstrates useful opportunistic evaluation until a scheduler or
  background worker is justified.

## Gaps and pricing-plan debt avoided

The pricing plan proposed a sound pure engine, but treated confidence and warnings as pricing-only
concepts, omitted general data quality/evidence, and deferred all recommendation history. That
would force future intelligence to reverse-engineer UI results and would prevent before/after
learning. The implementation keeps the plan's product behavior while exposing assumptions,
explanation inputs, data quality, and emitted signals. Pricing uses recipe ingredient cost as the
product-cost input because that is the only complete, stable per-product cost currently available;
staff and operating costs influence the business adjustment and are never allocated into recipe
cost. This avoids double-counting them when business economics are evaluated.

The plan's dedicated pricing query is retained for isolation, but it returns an explicit historical
window and completeness metadata. Recommendation and outcome tables are added now because adding
identity, evidence snapshots, and lifecycle state later would be a painful migration. They do not
automatically apply prices or spend money.

## Target architecture

1. **Business data:** versioned operational records in Postgres.
2. **Deterministic engines:** pure money and statistical functions in `lib/calc/`.
3. **Cafe state:** composable current or historical slices with explicit `DataQuality`.
4. **Events, signals, forecasts:** typed facts with evidence. Forecast providers are numerical,
   never language models.
5. **Decision engine:** small deterministic policies create auditable recommendations.
6. **Optional operating brain:** consumes only structured tools; a `NoAIProvider` always exists.
7. **Owner-approved actions:** recommendations do not mutate operational systems by themselves.
8. **Outcomes:** decisions, owner responses, before/after measures, and provenance are retained.

Coffee-specific defaults live in a `CoffeeShopProfile`; generic calculation and decision contracts
do not branch on scattered café constants. The initial autonomy ceiling is Level 2 (recommend).

## Migration decisions and implementation now

- Replace the ingredient-only UI helper with the deterministic Suggested Pricing Engine and retain
  one recipe-cost source of truth.
- Introduce shared contracts for data quality, café state slices, signals, decisions, outcomes,
  events, forecasts, audit provenance, and autonomy.
- Add a composable `CafeStateService` interface and snapshot-backed implementation supporting
  current and historical queries without pretending absent inventory/supplier data exists.
- Add deterministic pricing signals and a deliberately small fallback policy that recommends a
  price review only when evidence warrants it.
- Persist decision and outcome records with RLS-ready business ownership and structured evidence.
- Add a model-independent AI provider contract, mandatory no-AI implementation, failure-safe
  operating brain, and allow-listed structured café tools. Existing extraction prompts continue to
  use their current adapter until migrated incrementally.
- Add an in-process domain-event contract and numerical forecasting interface, without a queue,
  scheduler, forecasting model, or autonomous executor.

## Future work

- A scheduled evaluator for continuous signals, statistical trends/anomalies, and prioritized
  insights once deployment requirements define an appropriate worker.
- Actual inventory, supplier, waste, and purchase-order domains; deterministic demand, stockout,
  labor, revenue, and profit forecast implementations; and constrained optimization.
- More policies only when product evidence supports them, plus owner-configurable autonomy rules.
- Provider implementations of the operating-brain interface, richer cross-domain orchestration,
  and translated conversational UX. Provider prose remains presentation, never financial truth.
- Outcome evaluation jobs that fill post-decision windows and compare like-for-like periods.

## Final design tests

- **A — Yes.** Pricing, profit, expenses, sales metrics, signals, and policy recommendations use no
  AI provider.
- **B — Yes.** A future model implements the provider contract and consumes allow-listed tools over
  the same café state and engines.
- **C — Yes.** Decisions, actions, evidence snapshots, and outcomes have stable persisted identities.
- **D — Yes.** Financial tools and pricing composition call the existing pure calculation modules;
  neither policies nor AI reimplement money math.
