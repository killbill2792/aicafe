import type { CafeDecision, CafeSignal } from "./types";

export function deterministicDecisions(params: { businessId: string; signals: CafeSignal[]; now?: Date }): CafeDecision[] {
  const now = params.now ?? new Date();
  return params.signals.filter((s) => s.type === "PRICE_REVIEW_REQUIRED" && s.entityId && s.currentValue !== undefined)
    .map((signal) => {
      const suggested = Number(signal.evidence.find((e) => e.field === "recommendedPriceCents")?.value ?? signal.currentValue);
      return {
        id: `decision:${signal.id}`, businessId: params.businessId, type: "PRICE_CHANGE" as const, entityType: signal.entityType, entityId: signal.entityId,
        recommendation: { action: "REVIEW_PRICE", parameters: { currentPriceCents: signal.currentValue!, suggestedPriceCents: suggested } },
        supportingSignalIds: [signal.id], confidence: signal.confidence, status: "recommended" as const, autonomyLevel: 2 as const,
        provenance: { calculationVersion: "pricing-v1", dataSnapshot: { evidence: signal.evidence, dataQuality: signal.dataQuality }, assumptions: [] }, createdAt: now,
      };
    });
}

export interface DecisionStore {
  saveDecision(decision: CafeDecision): Promise<void>;
  saveOutcome(outcome: import("./types").DecisionOutcome): Promise<void>;
  getDecisionHistory(businessId: string): Promise<CafeDecision[]>;
  getOutcomes(decisionId: string): Promise<import("./types").DecisionOutcome[]>;
}
