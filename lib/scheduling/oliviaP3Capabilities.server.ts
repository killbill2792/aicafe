import "server-only";
import { z } from "zod";
import { executeOliviaReadCapability } from "./oliviaCapabilities.server";
import { schemaFingerprint, type ReadRegistration, type TrustedReadScope } from
  "@/lib/ai/supervisor/p2/registry";

/**
 * Exposes Olivia's existing, independently reviewed `olivia.schedule.preview`
 * read capability (merged PR2/PR4A) to the P3 dynamic registry, so an
 * open-ended Supervisor question can discover and read it the same way it
 * already discovers P1 financial sources. This file adds NO new scheduling
 * math: every number below is copied unchanged from the real optimizer's own
 * output. Write/publish/approve capabilities are never reachable from here.
 */
export const OLIVIA_P3_SCHEDULE_PREVIEW_ID = "p3.olivia.schedule.preview.v1" as const;

const inputSchema = z.strictObject({
  purpose: z.literal("schedule_preview"),
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const previewRow = z.strictObject({
  name: z.string().min(1).max(160),
  loadedLaborCostCents: z.number().int().safe().min(0).max(100_000_000),
  shiftCount: z.number().int().min(0).max(500),
});
const provenanceSchema = z.strictObject({
  sourceId: z.literal("olivia.schedule_foundation"),
  canonicalReaderId: z.literal("olivia.schedule.preview"),
  sourceRevision: z.null(),
  purpose: z.literal("schedule_preview"),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const qualitySchema = z.strictObject({
  missingInputs: z.array(z.string().max(80)).max(50),
  estimatedInputs: z.array(z.string().max(80)).max(50),
  staleInputs: z.array(z.string().max(80)).max(50),
});
export const oliviaP3PreviewOutputSchema = z.union([
  z.strictObject({ status: z.literal("unavailable"), value: z.null(), reason: z.string().min(1).max(100) }),
  z.strictObject({
    status: z.enum(["verified", "partial"]), id: z.literal("olivia.schedule.preview"),
    value: z.array(previewRow).max(1), provenance: provenanceSchema, quality: qualitySchema,
  }),
]);

/** Domains array entry for `createP3ReadRegistry`. Read-only; no simulate/what-if here yet. */
export function buildOliviaP3Registrations(): readonly [ReadRegistration] {
  return [{
    id: OLIVIA_P3_SCHEDULE_PREVIEW_ID, version: 1 as const, owner: "olivia",
    mode: "read" as const, availability: "shadow" as const,
    purpose: "Read-only summary (loaded weekly labor cost, planned shift count) of a feasible " +
      "seven-day schedule preview from the existing reviewed Olivia optimizer. Never writes, " +
      "approves, publishes or contacts a worker.",
    sourceIds: ["olivia.schedule_foundation"],
    canonicalReaderIds: ["olivia.schedule.preview"],
    allowedPurposes: ["schedule_preview"],
    inputSchema, outputSchema: oliviaP3PreviewOutputSchema,
    schemaContract: {
      id: OLIVIA_P3_SCHEDULE_PREVIEW_ID + ".v1", registrationId: OLIVIA_P3_SCHEDULE_PREVIEW_ID,
      version: 1 as const,
      inputSchemaFingerprint: schemaFingerprint(inputSchema),
      outputSchemaFingerprint: schemaFingerprint(oliviaP3PreviewOutputSchema),
    },
    requiredRole: "owner" as const, sensitivity: "staff" as const,
    budgets: { maxOperations: 1, timeoutMs: 10000, maxResultBytes: 20000, maxInputBytes: 2000, maxRangeDays: 7 },
    requiresApproval: false as const, effectPolicy: "deny" as const,
    async read(scope: TrustedReadScope, rawInput: unknown) {
      const input = rawInput as z.output<typeof inputSchema>;
      const response = await executeOliviaReadCapability({
        capability: "olivia.schedule.preview", version: 1, week: input.week,
      });
      if (!response.ok || response.capability !== "olivia.schedule.preview")
        return { status: "unavailable" as const, value: null,
          reason: !response.ok ? response.error.code : "unexpected_capability" };
      const { plan, selectedScenario } = response;
      if (plan.status !== "feasible" || !selectedScenario || selectedScenario.cost.loadedPayrollCents === null)
        return { status: "unavailable" as const, value: null,
          reason: plan.status !== "feasible" ? "no_feasible_schedule" : "wage_data_incomplete" };
      return {
        status: "partial" as const, id: "olivia.schedule.preview" as const,
        value: [{
          name: plan.horizonStart + " – " + plan.horizonEnd,
          loadedLaborCostCents: selectedScenario.cost.loadedPayrollCents,
          shiftCount: selectedScenario.shifts.length,
        }],
        provenance: {
          sourceId: "olivia.schedule_foundation" as const,
          canonicalReaderId: "olivia.schedule.preview" as const,
          sourceRevision: null, purpose: "schedule_preview" as const, asOf: scope.identity.asOf,
        },
        quality: { missingInputs: [], estimatedInputs: [], staleInputs: [] },
      };
    },
  }];
}
