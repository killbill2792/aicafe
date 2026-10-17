import "server-only";
import { z } from "zod";
import { buildAlexPricingRegistrations } from "./alexCapabilities.server";
import { alexSimulateInputSchema, type AlexSimulateInput } from "./alexPricing";
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
 * Alex's pricing what-if: unlike Olivia's employee-specific what-if, this is
 * self-contained — the product is resolved by exact name (or id) in the SAME
 * call, with no prior lookup step. P3 selects and invokes each capability in
 * one pass per clause (it has no multi-round "look something up, then use the
 * result" loop like the legacy Supervisor tool loop does), so only a what-if
 * that can be fully resolved from the owner's words in one shot can be
 * registered here safely. A what-if that needs a prior read's result (e.g.
 * Olivia's employee-id resolution) is explicitly NOT registered — see PR notes.
 */
export const ALEX_P3_WHATIF_ID = "p3.alex.pricing.what_if.v1" as const;
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
      targetPriceCents: z.number().int().safe().min(0).max(100_000_000).nullable(),
    })).length(1),
    provenance: provenanceSchema, quality: qualitySchema,
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
    purpose: "Read-only ingredient substitution, ingredient-unit-cost or supplier-package-cost " +
      "what-if for ONE named active product, using the existing reviewed Alex pricing simulator. " +
      "Owner-defined cost/margin target only. Never writes a price or recipe.",
    sourceIds: ["p1.authoritative_snapshot.v1"],
    canonicalReaderIds: ["alex.pricing.atomic_snapshot"],
    allowedPurposes: ["pricing_simulate"],
    inputSchema: alexSimulateInputSchema, outputSchema: whatIfOutputSchema,
    schemaContract: {
      id: ALEX_P3_WHATIF_ID + ".v1", registrationId: ALEX_P3_WHATIF_ID, version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(alexSimulateInputSchema),
      outputSchemaFingerprint: schemaFingerprint(whatIfOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "financial" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 10000, maxRangeDays: 365 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope, rawInput: unknown) {
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
        ingredientCostDeltaCents: number | null; targetPriceCents: number | null;
      };
      return {
        status: "partial" as const, id: "alex.pricing.what_if" as const,
        value: [{
          name: value.name, priceDeltaCents: value.priceDeltaCents,
          ingredientCostDeltaCents: value.ingredientCostDeltaCents,
          targetPriceCents: value.targetPriceCents,
        }],
        provenance: raw.provenance as z.output<typeof provenanceSchema>,
        quality: raw.quality as z.output<typeof qualitySchema>,
      };
    },
  }];
}
