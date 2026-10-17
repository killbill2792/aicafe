# Alex → Universal Supervisor P3 domain handoff (read/simulate only)

Tracks #74. Domain branch based on merged #94; **no change** to Supervisor P2/P3 coordinator,
chat, auth, scheduling, P4 actions, migrations or deployment/feature flags.

## Export and central-owner integration

`buildAlexPricingRegistrations()` from `lib/pricing/alexCapabilities.server.ts`
returns a typed P2 `[ReadRegistration, SimulateRegistration]` tuple for Kill Bill 1
to review and add in the central registry **after this PR is merged**. Do not
replace/duplicate the existing `alex.pricing.review.v1` P1 shadow adapter.

~~~ts
// Example for central registry owner ONLY (not implemented by this Alex PR)
import { buildAlexPricingRegistrations } from "@/lib/pricing/alexCapabilities.server";
const registrations = [...existingRegistrations, ...buildAlexPricingRegistrations()];
const registry = createP2Registry(registrations);
// Invoke a registered ID only with the existing owner-authenticated TrustedReadScope.
// Read: registry.invoke(scope, "alex.pricing.batch_review.v1", typedReviewRequest);
// Simulate: registry.invokeSimulation(scope, "alex.pricing.what_if.v1",
//   typedScenarioRequest, {bindings:[],operands:[]});
// The source-context envelope is checked by the registry; Alex ignores caller
// snapshots and obtains fresh owner-authorized atomic RPC snapshots itself.
~~~

**Read ID:** `alex.pricing.batch_review.v1`, purpose `pricing_review`.
Use `selection:{kind:"specific",items:[{productId:"..."}]}` to avoid
variant/name ambiguity; `{exactName:"Latte 16 oz"}` must match one
record exactly. For a catalog scan, use `selection:{kind:"all_active",offset:0,limit:25}`
and continue while `hasMore`; the result reports unsupported category omissions.

**Simulate ID:** `alex.pricing.what_if.v1`, purpose `pricing_simulate`.
A scenario selects **one canonical item ID** and up to 20 ordered changes:
`ingredient_multiplier` (basis points, 13000 means 30% more),
`ingredient_unit_cost` (integer microcents per base unit),
`supplier_package` (integer cents, count, compatible unit),
`replace_ingredient` (compatible canonical base unit, optional quantity),
`set_quantity` (physical base unit or fl oz).
Optional `sellingPrice:{kind:"delta",deltaCents:50}` or replace, and
**explicit** `targetCostRatioBps` or `targetIngredientMarginBps`
produce a conditional ingredient-only target, never a price mutation.

Both operations obtain a *new* authorized P1 atomic snapshot, calculate
deterministically in the domain, and require a second authorized snapshot
with the **identical database revision** before returning. No epoch is
borrowed for any independent unversioned query. Unsupported currencies,
partial/truncated authoritative sources, ambiguous names, stale epochs,
missing ingredient prices, incompatible units and unknown variant IDs
are explicit failures/partials, not assumed zero.

## Freshness and hypothetical price-source semantics

The P1 snapshot proves the latest recorded *effective* ingredient price at the
trusted café-local date but does **not** verify that the supplier/quote is still
current. All current recipe-cost calculations using such price rows report
`partial` (not `verified`), with `staleInputs` identifying unverified
freshness. This applies even when an effective date is today: a recorded date
cannot establish ongoing supplier validity. Numeric ingredient-only what-if
targets remain **conditional advice**, not verified current recommendations.

Each before/after item lists `ingredientPriceSources` **only for recorded price
rows still contributing to final recipe cost**; it never keeps the replaced
ingredient's provenance. Absolute owner-supplied `ingredient_unit_cost`
and `supplier_package` overrides remove the superseded recorded price-source
label; `hypotheticalIngredientIds` identifies these hypothetical prices.
A relative `ingredient_multiplier` keeps the baseline recorded source and
also identifies the changed ingredient as hypothetical; the base price's
freshness remains unverified. The owner-supplied scenario is never persisted.

## Coverage and known limitations

- Ingredient prices are `ingredient_prices` latest effective date on the
  trusted café-local business day. **Prerequisite PR #98** extends P1's
  `p1_authoritative_source_snapshot` to include owner-entered
  `menu_item_cost_fallbacks` with the same revision, owner scope, source type,
  confirmed/estimated status and bounded truncation. Once PR #98 is approved,
  merged and its migration applied to the target environment, Alex uses
  **complete positive recipe first**, otherwise a **positive owner total**.
  Do not add them together or present owner totals as individual ingredients.
  `ownerTotalFallbackCoverage` is explicit: old P1 installations that lack
  the field still return missing/unavailable evidence, never a false zero.
- **Manual-only demo:** where total cost exists but recipe is absent, Alex can
  review each canonical menu product and run *price-only* / owner-target
  what-ifs. It refuses milk substitutions, recipe quantity edits or supplier
  ingredient sensitivity without a fully priced ingredient-level recipe.
  Estimated manual totals are explicitly estimated; totals whose currency or
  freshness cannot be independently proven remain partial and source-labeled.
  The new P1 migration must be run after owner approval and staging checks,
  not manually pushed to production from this PR.
- Actual customer option mix, observed recent demand, labor, card fees,
  vendor contract confirmation, and competitor benchmarks are not proven
  by the snapshot. Ingredient-only contribution is **not true profit**.
  `currentRecommendationCents:null` means no independently trustworthy
  business-adjusted recommendation can be asserted from this snapshot;
  owner-selected target options are conditional advice only.
- Size is identified by the canonical menu item ID and recorded full name.
  P1 atomic menu rows currently omit `size_label`, so duplicate names
  cannot be disambiguated without selecting ID. Ingredient-specific pump
  and shot conversions are not in the snapshot: unsupported until typed,
  source-backed conversions are supplied.
- This is a **domain-only** deliverable: no natural-language UI integration,
  live flag activation, POS price update or publication is asserted.
  Owner must approve merge separately; P4 owns all writes.

## Eight full-chat acceptance goals for the central coordinator

1. Owner requests review of all supported active drinks, including 12/16 oz:
   paginate 25/page, include every canonical ID and state unsupported omissions.
2. Owner asks about a uniquely named latte: show recorded selling price,
   ingredient-only cost/ratio/contribution, evidence date and missing inputs.
3. Owner asks about “latte” when two canonical variants share a name:
   request disambiguation rather than selecting one arbitrarily.
4. Owner asks to replace whole with oat/almond on one 16 oz variant:
   use same stored recipe base quantities, compare exact cents and units.
5. Owner asks “oat cost goes up 30%, price 50¢ higher” in follow-up:
   retain the selected product ID, apply 13000 basis points and +50 cents.
6. Owner supplies a supplier $/US-gallon hypothetical:
   convert only for ml-based ingredient and disclose hypothetical status.
7. Owner requests an explicit 25% target ingredient cost or 75% ingredient-only
   contribution margin: report conditional target price without claiming
   demand, margin after labor or market data.
8. Combined staffing+pricing goal with incomplete recipe or stale source:
   preserve the independently verified scheduling portion, label Alex's
   partial/unavailable result, never claim a changed menu/POS price.

Full-chat paraphrase, EN/ES/AR and mixed-domain acceptance remain the central
coordinator's responsibility. This domain emits typed data, not English-only
owner reply text.
