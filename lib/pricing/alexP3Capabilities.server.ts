import "server-only";
import { z } from "zod";
import { buildAlexPricingRegistrations } from "./alexCapabilities.server";
import {alexMissingIngredientCost} from "./alexOwnerInput.server";
import {ownerInputRequestSchema} from "@/lib/ai/supervisor/ownerInput/contracts";
import { alexNamedSimulateInputSchema, namedAlexChangeSchema, type AlexNamedSimulateInput } from "./alexNamedInputs";
import { schemaFingerprint, type ReadRegistration, type TrustedReadScope } from
  "@/lib/ai/supervisor/p2/registry";

/**
 * Exposes Alex's existing, independently reviewed `alex.pricing.batch_review.v1`
 * read capability to the P3 dynamic registry, so an open-ended Supervisor
 * question can discover and read it the same way it already discovers P1
 * financial sources. This file adds NO new pricing math: every number below
 * is copied unchanged from the real `reviewFromAtomicSnapshot` output.
 */
export const ALEX_P3_REVIEW_ID = "p3.alex.pricing.review.v1" as const;
const MAX_ROWS = 5;

const inputSchema = z.strictObject({ purpose: z.literal("pricing_review"),
  product:z.union([z.strictObject({productId:z.uuid()}),
    z.strictObject({exactName:z.string().trim().min(1).max(120)})]).optional() });
const priceRow = z.strictObject({
  name: z.string().min(1).max(160),
  currentPriceCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
  reviewIngredientCostCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
  currentRecommendationCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
});
const provenanceSchema = z.strictObject({
  sourceId: z.literal("p1.authoritative_snapshot.v1"),
  canonicalReaderId: z.literal("alex.pricing.atomic_snapshot"),
  sourceRevision: z.string(), purpose: z.literal("pricing_review"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
// Alex's real simulate() echoes the INPUT purpose into its own provenance
// (pricing_simulate, not pricing_review) — a separate schema is required or
// every real what-if result fails output validation. Caught in review.
const simulateProvenanceSchema = z.strictObject({
  sourceId: z.literal("p1.authoritative_snapshot.v1"),
  canonicalReaderId: z.literal("alex.pricing.atomic_snapshot"),
  sourceRevision: z.string(), purpose: z.literal("pricing_simulate"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
// reviewFromAtomicSnapshot prefixes each per-item quality signal with the
// product name (up to 160 chars) plus ":" plus a reason string plus,
// sometimes, ":" plus a 36-char ingredient UUID -- e.g.
// "<name>:ingredient_price_freshness_unverified:<uuid>". The previous 80-char
// cap was tight enough that a realistic product name alone could exceed it,
// silently failing this whole result's output validation (the P2 registry
// returns unavailable("invalid_result") on a schema mismatch, not an error)
// and discarding an otherwise-good "partial" read. These strings are never
// shown raw to the owner (only a generic "has missing inputs" signal is
// derived from them), so a longer cap leaks nothing. Found while testing
// this PR's unrelated completedSimulationClauses fix.
const qualitySchema = z.strictObject({
  missingInputs: z.array(z.string().max(260)).max(100),
  estimatedInputs: z.array(z.string().max(260)).max(50),
  staleInputs: z.array(z.string().max(260)).max(50),
});
const ownerInputOutputSchema=z.strictObject({status:z.literal("requires_owner_input"),
  value:z.null(),ownerInput:ownerInputRequestSchema});
export const alexP3ReviewOutputSchema = z.union([
  ownerInputOutputSchema,
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    status: z.enum(["verified", "partial"]), id: z.literal("alex.pricing.review"),
    value: z.array(priceRow).max(MAX_ROWS), provenance: provenanceSchema, quality: qualitySchema,
  }),
]);

/** Owner-parameterized pricing and recipe scenarios. Ingredient display names
 * are resolved inside the same authorized atomic snapshot used for calculation;
 * ambiguous/missing names never become guessed IDs. No business writes. */
export const ALEX_P3_WHATIF_ID = "p3.alex.pricing.what_if.v1" as const;
// The exact, exhaustive set simulateFromAtomicSnapshot (lib/pricing/alexPricing.ts) can emit —
// confirmed by reading its one call site, not assumed. Any other string is never shown, never
// silently passed through as English prose.
export const ALEX_ASSUMPTION_CODES = [
  "owner_hypothetical_not_recorded", "recorded_cost_freshness_not_proven",
  "owner_total_is_aggregate_not_ingredient_recipe",
  "ingredient_only_excludes_labor_fees_rent_and_demand",
  "owner_supplied_ingredient_cost_overrides_are_hypothetical",
  "no_target_selected_no_target_price",
] as const;
// simulateFromAtomicSnapshot always emits these in the same fixed internal order (own cost
// mechanics first), so the decision-critical caveat for an ingredient-only margin -- that it
// excludes labor, fees, rent and demand -- always lands at index 2 or 3, never 0 or 1. The
// output schema caps presented codes at 2, so picking by raw array position silently dropped
// that caveat from every real result. Select by this priority instead. Caught in review (round 4).
// "no_target_selected_no_target_price" is deliberately left OUT of this list: it only ever
// appears for a selling-price-only request (this capability requires at least one of
// sellingPrice/target, so a missing target implies a given selling price), it explains an
// already-visible absent field rather than a data-quality limitation on the computed result,
// and ranking it at all let it crowd out the real cost-freshness caveat under the 2-code cap.
// Caught in review (round 8).
const ASSUMPTION_CODE_PRIORITY: readonly (typeof ALEX_ASSUMPTION_CODES)[number][] = [
  "ingredient_only_excludes_labor_fees_rent_and_demand",
  "owner_total_is_aggregate_not_ingredient_recipe",
  "owner_supplied_ingredient_cost_overrides_are_hypothetical",
  "recorded_cost_freshness_not_proven",
  "owner_hypothetical_not_recorded",
];
const whatIfInputSchema = alexNamedSimulateInputSchema.safeExtend({
  changes: z.array(namedAlexChangeSchema).max(20),
}).refine(x =>
  x.changes.length > 0 || x.sellingPrice !== undefined || x.targetCostRatioBps !== undefined ||
    x.targetIngredientMarginBps !== undefined,
  { message: "A what-if needs a recipe change, selling price or cost/margin target" });
const whatIfOutputSchema = z.union([
  ownerInputOutputSchema,
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    // A what-if scenario is always hypothetical, never an observed fact — normalized
    // to "partial" here because the shared evidence envelope has no "conditional" status.
    status: z.literal("partial"), id: z.literal("alex.pricing.what_if"),
    value: z.array(z.strictObject({
      name: z.string().min(1).max(160),
      changesSummary: z.array(namedAlexChangeSchema).max(20),
      priceDeltaCents: z.number().int().safe().nullable(),
      ingredientCostDeltaCents: z.number().int().safe().nullable(),
      // The actual calculated outcome of a selling-price what-if (margin impact), not
      // just an echo of the requested delta — dropping this was a real finding in review.
      ingredientContributionDeltaCents: z.number().int().safe().nullable(),
      targetPriceCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
      // Alex's simulator's own caveats, as the exact enumerable codes it emits (see
      // ALEX_ASSUMPTION_CODES) -- NOT raw/joined text. Passing raw English snake_case codes
      // straight through was a real finding in review: unlocalized for ES/AR sessions. The
      // shared presentation layer maps each known code to a localized string. Capped at 3,
      // not 2: when the cost basis is an owner-entered total (not a recipe), both that
      // caveat AND the ingredient-cost-freshness one are decision-critical together, on
      // top of the always-present ingredient-only-scope caveat. Caught in review (round 9).
      assumptionCodes: z.array(z.enum(ALEX_ASSUMPTION_CODES)).max(3),
      // Carries quality.estimatedInputs's "owner_total_cost_estimated" signal through to
      // presentation (which otherwise never rendered it at all): per this project's own
      // rule that every estimate must be labeled, an owner-entered TOTAL cost that is
      // itself an estimate (not a recorded real figure) is a stronger caveat than "cost
      // freshness not independently verified" and must not be silently dropped either.
      // Caught in review (round 9).
      costBasisEstimated: z.boolean(),
    })).length(1),
    provenance: simulateProvenanceSchema, quality: qualitySchema,
  }),
]);

/** Domains array entry for `createP3ReadRegistry`. Reuses Alex's own already-reviewed
 * read() handler directly; this wrapper only reshapes its validated output. */
export function buildAlexP3Registrations(): readonly [ReadRegistration, ReadRegistration] {
  const [alexReview, alexSimulate] = buildAlexPricingRegistrations();
  return [{
    id: ALEX_P3_REVIEW_ID, version: 1 as const, owner: "alex",
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only summary (recorded price, ingredient cost, recommended price where one " +
      "exists) of a bounded sample of active menu items from the existing reviewed Alex pricing " +
      "reader. Never changes a price or recipe.",
    ownerInputWriteIds:["menu.ingredient_price.manual.v1"],
    sourceIds: ["p1.authoritative_snapshot.v1"],
    canonicalReaderIds: ["alex.pricing.atomic_snapshot"],
    allowedPurposes: ["pricing_review"],
    inputSchema, outputSchema: alexP3ReviewOutputSchema,
    schemaContract: {
      id: ALEX_P3_REVIEW_ID + ".v1", registrationId: ALEX_P3_REVIEW_ID, version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(inputSchema),
      outputSchemaFingerprint: schemaFingerprint(alexP3ReviewOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "financial" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 2000, maxRangeDays: 365 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope,rawInput: unknown) {
      const input=rawInput as z.infer<typeof inputSchema>;
      const raw = await alexReview.read(scope, {
        purpose: "pricing_review", selection:input.product?
          {kind:"specific" as const,items:[input.product]}:
          { kind: "all_active" as const, offset: 0, limit: MAX_ROWS },
      });
      if (!raw || typeof raw !== "object" || !("status" in raw) ||
        (raw.status !== "verified" && raw.status !== "partial") ||
        !("value" in raw) || !raw.value || typeof raw.value !== "object" ||
        !("provenance" in raw) || !("quality" in raw))
        {
          const gap=await alexMissingIngredientCost(scope,input.product);
          if(gap)return {status:"requires_owner_input" as const,value:null,ownerInput:gap};
          return { status: "unavailable" as const, value: null,
            reason: raw && typeof raw === "object" && "reason" in raw && typeof raw.reason === "string"
              ? raw.reason : "unavailable" };
        }
      const value = raw.value as { items: ReadonlyArray<{
        name: string; status: string; currentPriceCents: number | null;
        ingredientCostCents: number | null; currentRecommendationCents: number | null;
      }> };
      // A real recipe-priced item is "partial" (not "ready") essentially always --
      // evaluateItem marks any recorded ingredient price "freshness unverified",
      // which alone makes status "partial". Filtering to literally "ready" only
      // meant this capability silently returned no_ready_items for any real café
      // with recipe-priced items -- found while testing this PR's unrelated
      // completedSimulationClauses fix. "unavailable" (no price/cost data at all)
      // is still excluded; "partial" is the normal, honestly-disclosed real case.
      const rows = value.items.filter(item =>
        item.status === "ready" || item.status === "partial").slice(0, MAX_ROWS).map(item => ({
        name: item.name, currentPriceCents: item.currentPriceCents,
        reviewIngredientCostCents: item.ingredientCostCents,
        currentRecommendationCents: item.currentRecommendationCents,
      }));
      if((input.product||rows.length===1)&&
        rows.some(row=>row.reviewIngredientCostCents===null)){
        const gap=await alexMissingIngredientCost(scope,input.product);
        if(gap)return {status:"requires_owner_input" as const,value:null,ownerInput:gap};
      }
      if(!rows.length){
        const gap=await alexMissingIngredientCost(scope,input.product);
        if(gap)return {status:"requires_owner_input" as const,value:null,ownerInput:gap};
        return { status: "unavailable" as const, value: null, reason: "no_ready_items" };
      }
      return {
        status: raw.status, id: "alex.pricing.review" as const, value: rows,
        provenance: raw.provenance as z.output<typeof provenanceSchema>,
        quality: raw.quality as z.output<typeof qualitySchema>,
      };
    },
  }, {
    id: ALEX_P3_WHATIF_ID, version: 1 as const, owner: "alex",
    ownerInputWriteIds:["menu.ingredient_price.manual.v1"],
    resultKind: "owner_parameterized_simulation" as const,
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only target-margin/cost-ratio or selling-price-delta what-if for ONE named " +
      "active product, using the existing reviewed Alex pricing simulator. Supports ingredient substitution, quantity, " +
      "unit-cost, multiplier and supplier-package changes by exact ingredient name, resolved in " +
      "the same canonical snapshot. Owner-defined cost/margin target only. Never writes a price or recipe.",
    sourceIds: ["p1.authoritative_snapshot.v1"],
    canonicalReaderIds: ["alex.pricing.atomic_snapshot"],
    allowedPurposes: ["pricing_simulate"],
    inputSchema: whatIfInputSchema, outputSchema: whatIfOutputSchema,
    schemaContract: {
      id: ALEX_P3_WHATIF_ID + ".v1", registrationId: ALEX_P3_WHATIF_ID, version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(whatIfInputSchema),
      outputSchemaFingerprint: schemaFingerprint(whatIfOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "financial" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 10000, maxRangeDays: 365 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope, rawInput: unknown) {
      // The domain resolves typed ingredient names inside its source snapshot.
      const input = rawInput as AlexNamedSimulateInput;
      const raw = await alexSimulate.simulate?.(scope, input, undefined);
      const ownerGap=async()=>{
        const gap=await alexMissingIngredientCost(scope,input.product);
        return gap?{status:"requires_owner_input" as const,value:null,ownerInput:gap}:null;
      };
      if (!raw || typeof raw !== "object" || !("status" in raw) ||
        (raw.status !== "conditional" && raw.status !== "partial") ||
        !("value" in raw) || !raw.value || typeof raw.value !== "object" ||
        !("provenance" in raw) || !("quality" in raw))
        {
          const gap=await ownerGap();
          if(gap)return gap;
          return { status: "unavailable" as const, value: null,
            reason: raw && typeof raw === "object" && "reason" in raw && typeof raw.reason === "string"
              ? raw.reason : "unavailable" };
        }
      const value = raw.value as {
        name: string; priceDeltaCents: number | null;
        ingredientCostDeltaCents: number | null; ingredientContributionDeltaCents: number | null;
        targetPriceCents: number | null; assumptions: unknown;
      };
      // Shared by both missing-cost-basis checks below: simulateFromAtomicSnapshot still
      // returns "partial" (missing inputs, not a hard failure) when the product has
      // neither a complete priced recipe nor a usable owner-total fallback -- it does
      // not fail the whole scenario just because it can't price it.
      const missingCostReason = () => {
        const missingInputs = (raw.quality as { missingInputs?: unknown }).missingInputs;
        return Array.isArray(missingInputs)
          ? missingInputs.find((m): m is string => typeof m === "string" && m.includes("owner_total_cost"))
          : undefined;
      };
      // A target was requested but simulateFromAtomicSnapshot could not price it. Publishing
      // that as a successful what-if silently drops the one answer the owner actually asked
      // for (presentation omits the null targetPriceCents entirely). Report unavailable
      // instead. Caught in review (round 5).
      if ((input.targetCostRatioBps !== undefined || input.targetIngredientMarginBps !== undefined) &&
        value.targetPriceCents === null){
        const gap=await ownerGap();
        if(gap)return gap;
        return {status:"unavailable" as const,value:null,
          reason:missingCostReason()??"cost_basis_unavailable_for_target"};
      }
      // A selling-price change was requested (the point of which is its margin impact) but
      // the same missing cost basis means ingredientContributionDeltaCents comes back null
      // too -- not because the scenario is unapplied (it is applied; see targetOnly below),
      // but because the impact genuinely could not be computed. Publishing that as success
      // would silently echo back only the requested price change with no indication the
      // impact calculation failed. Report unavailable instead. Caught in review (round 7).
      if (input.sellingPrice !== undefined && value.ingredientContributionDeltaCents === null){
        const gap=await ownerGap();
        if(gap)return gap;
        return {status:"unavailable" as const,value:null,
          reason:missingCostReason()??"cost_basis_unavailable_for_impact"};
      }
      const knownCodes: readonly string[] = ALEX_ASSUMPTION_CODES;
      const presentCodes = new Set(Array.isArray(value.assumptions)
        ? value.assumptions.filter((a): a is string => typeof a === "string" && knownCodes.includes(a))
        : []);
      const assumptionCodes = ASSUMPTION_CODE_PRIORITY.filter(c => presentCodes.has(c)).slice(0, 3);
      const estimatedInputs = (raw.quality as { estimatedInputs?: unknown }).estimatedInputs;
      const costBasisEstimated = Array.isArray(estimatedInputs) &&
        estimatedInputs.includes("owner_total_cost_estimated");
      // A target-only request (no sellingPrice) never actually applies the target as a
      // hypothetical price -- simulateFromAtomicSnapshot leaves "after" identical to
      // "before" -- so both priceDeltaCents and ingredientContributionDeltaCents are
      // always exactly 0 and would misleadingly read as "Price change: $0.00" / "no
      // margin impact" right next to a nonzero targetPriceCents. Neither is a real
      // zero, both are an unapplied scenario; null them instead of presenting a false
      // zero. Recipe changes, however, are applied even without a selling-price change.
      // Caught in review (rounds 4 and 6).
      const targetOnly = input.sellingPrice === undefined && input.changes.length === 0;
      return {
        status: "partial" as const, id: "alex.pricing.what_if" as const,
        value: [{
          name: value.name,
          changesSummary: input.changes,
          priceDeltaCents: targetOnly ? null : value.priceDeltaCents,
          ingredientCostDeltaCents: value.ingredientCostDeltaCents,
          ingredientContributionDeltaCents: targetOnly ? null : value.ingredientContributionDeltaCents,
          targetPriceCents: value.targetPriceCents,
          assumptionCodes,
          costBasisEstimated,
        }],
        provenance: raw.provenance as z.output<typeof simulateProvenanceSchema>,
        quality: raw.quality as z.output<typeof qualitySchema>,
      };
    },
  }];
}
