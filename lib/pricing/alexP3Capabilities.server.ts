import "server-only";
import { z } from "zod";
import { buildAlexPricingRegistrations } from "./alexCapabilities.server";
import type { AlexSimulateInput } from "./alexPricing";
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

const inputSchema = z.strictObject({ purpose: z.literal("pricing_review") });
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
const qualitySchema = z.strictObject({
  missingInputs: z.array(z.string().max(80)).max(100),
  estimatedInputs: z.array(z.string().max(80)).max(50),
  staleInputs: z.array(z.string().max(80)).max(50),
});
export const alexP3ReviewOutputSchema = z.union([
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    status: z.enum(["verified", "partial"]), id: z.literal("alex.pricing.review"),
    value: z.array(priceRow).max(MAX_ROWS), provenance: provenanceSchema, quality: qualitySchema,
  }),
]);

/**
 * Alex's pricing TARGET what-if: a product resolved by exact name, scored
 * against an owner-given cost ratio / ingredient margin / selling-price
 * delta — e.g. "what should I charge for a 70% margin on the oat latte".
 * Fully self-contained in one call: no prior lookup needed.
 *
 * Deliberately EXCLUDED: ingredient substitution/unit-cost/package-cost
 * changes (Alex's own "replace oat milk with almond milk" scenario kind).
 * `alexSimulateInputSchema`'s `changes[]` requires real ingredient UUIDs
 * (`ingredientId`/`fromIngredientId`/`toIngredientId`) that only exist
 * internally — the owner says "oat milk", never a UUID, and P3's one-shot
 * capability selection has no prior-read step to resolve a name to one
 * first (same limitation documented for Olivia's employee what-if). Letting
 * the model attempt to populate those fields would mean either a guessed/
 * fabricated ID (unsafe) or a silent `invalid_request` on exactly the
 * scenario owners ask for most. `changes` is forced to an empty tuple below
 * so this is impossible to misuse, not just undocumented. Caught in review
 * (the first version of this file advertised ingredient changes as if they
 * were reachable; they were not). Real ingredient-name resolution is a
 * separate, future capability, not a shortcut to take here.
 */
export const ALEX_P3_WHATIF_ID = "p3.alex.pricing.what_if.v1" as const;
const smallText = z.string().trim().min(1).max(120);
const uuid = z.string().uuid();
const cents = z.number().int().safe().min(0).max(100_000_000);
const whatIfInputSchema = z.strictObject({
  purpose: z.literal("pricing_simulate"),
  product: z.union([z.strictObject({ productId: uuid }), z.strictObject({ exactName: smallText })]),
  changes: z.tuple([]),
  sellingPrice: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("delta"), deltaCents: z.number().int().safe().min(-100000).max(100000) }),
    z.strictObject({ kind: z.literal("replace"), priceCents: cents }),
  ]).optional(),
  targetCostRatioBps: z.number().int().min(1).max(10000).optional(),
  targetIngredientMarginBps: z.number().int().min(0).max(9999).optional(),
}).refine(x => x.targetCostRatioBps === undefined || x.targetIngredientMarginBps === undefined,
  { message: "Select exactly one target ratio or ingredient-only margin" })
  // changes is always [] here, so unlike the legacy loop's hasScenario check this only
  // needs to rule out an owner turn with no selling price AND no target at all — a
  // no-op that would otherwise compare the product with itself and still report
  // "partial" success, exactly as the legacy loop's own guard exists to prevent.
  .refine(x => x.sellingPrice !== undefined || x.targetCostRatioBps !== undefined ||
    x.targetIngredientMarginBps !== undefined,
  { message: "A what-if needs a selling price or a cost/margin target" });
const whatIfOutputSchema = z.union([
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    // A what-if scenario is always hypothetical, never an observed fact — normalized
    // to "partial" here because the shared evidence envelope has no "conditional" status.
    status: z.literal("partial"), id: z.literal("alex.pricing.what_if"),
    value: z.array(z.strictObject({
      name: z.string().min(1).max(160),
      priceDeltaCents: z.number().int().safe().nullable(),
      ingredientCostDeltaCents: z.number().int().safe().nullable(),
      // The actual calculated outcome of a selling-price what-if (margin impact), not
      // just an echo of the requested delta — dropping this was a real finding in review.
      ingredientContributionDeltaCents: z.number().int().safe().nullable(),
      targetPriceCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
      // Alex's simulator's own caveats (e.g. "ingredient-only, excludes labor/fees/rent",
      // "cost freshness not proven") — dropping these was a real finding in review; a bare
      // target/delta number reads as a full profitability price without them. Capped at
      // 120 chars to match presentRegisteredReads' own safeText() limit, not re-truncated
      // there (a longer string would be silently dropped, not shortened).
      assumptionsSummary: z.string().max(120).nullable(),
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
    async read(scope: TrustedReadScope) {
      const raw = await alexReview.read(scope, {
        purpose: "pricing_review", selection: { kind: "all_active", offset: 0, limit: MAX_ROWS },
      });
      if (!raw || typeof raw !== "object" || !("status" in raw) ||
        (raw.status !== "verified" && raw.status !== "partial") ||
        !("value" in raw) || !raw.value || typeof raw.value !== "object" ||
        !("provenance" in raw) || !("quality" in raw))
        return { status: "unavailable" as const, value: null,
          reason: raw && typeof raw === "object" && "reason" in raw && typeof raw.reason === "string"
            ? raw.reason : "unavailable" };
      const value = raw.value as { items: ReadonlyArray<{
        name: string; status: string; currentPriceCents: number | null;
        ingredientCostCents: number | null; currentRecommendationCents: number | null;
      }> };
      const rows = value.items.filter(item => item.status === "ready").slice(0, MAX_ROWS).map(item => ({
        name: item.name, currentPriceCents: item.currentPriceCents,
        reviewIngredientCostCents: item.ingredientCostCents,
        currentRecommendationCents: item.currentRecommendationCents,
      }));
      if (!rows.length) return { status: "unavailable" as const, value: null, reason: "no_ready_items" };
      return {
        status: raw.status, id: "alex.pricing.review" as const, value: rows,
        provenance: raw.provenance as z.output<typeof provenanceSchema>,
        quality: raw.quality as z.output<typeof qualitySchema>,
      };
    },
  }, {
    id: ALEX_P3_WHATIF_ID, version: 1 as const, owner: "alex",
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only target-margin/cost-ratio or selling-price-delta what-if for ONE named " +
      "active product, using the existing reviewed Alex pricing simulator. No ingredient " +
      "substitution or cost change (that needs an internal ingredient id the owner cannot supply " +
      "by name yet). Owner-defined cost/margin target only. Never writes a price or recipe.",
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
      // whatIfInputSchema is a narrower, no-ingredient-changes subset of AlexSimulateInput
      // (changes forced to []); structurally compatible with what simulate() accepts.
      const input = rawInput as AlexSimulateInput;
      const raw = await alexSimulate.simulate?.(scope, input, undefined);
      if (!raw || typeof raw !== "object" || !("status" in raw) ||
        (raw.status !== "conditional" && raw.status !== "partial") ||
        !("value" in raw) || !raw.value || typeof raw.value !== "object" ||
        !("provenance" in raw) || !("quality" in raw))
        return { status: "unavailable" as const, value: null,
          reason: raw && typeof raw === "object" && "reason" in raw && typeof raw.reason === "string"
            ? raw.reason : "unavailable" };
      const value = raw.value as {
        name: string; priceDeltaCents: number | null;
        ingredientCostDeltaCents: number | null; ingredientContributionDeltaCents: number | null;
        targetPriceCents: number | null; assumptions: unknown;
      };
      const assumptions = Array.isArray(value.assumptions)
        ? value.assumptions.filter((a): a is string => typeof a === "string").slice(0, 2)
        : [];
      return {
        status: "partial" as const, id: "alex.pricing.what_if" as const,
        value: [{
          name: value.name, priceDeltaCents: value.priceDeltaCents,
          ingredientCostDeltaCents: value.ingredientCostDeltaCents,
          ingredientContributionDeltaCents: value.ingredientContributionDeltaCents,
          targetPriceCents: value.targetPriceCents,
          assumptionsSummary: assumptions.length ? assumptions.join("; ").slice(0, 120) : null,
        }],
        provenance: raw.provenance as z.output<typeof simulateProvenanceSchema>,
        quality: raw.quality as z.output<typeof qualitySchema>,
      };
    },
  }];
}
