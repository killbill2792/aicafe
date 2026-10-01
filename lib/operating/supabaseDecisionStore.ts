import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionStore } from "./decisions";
import type { CafeDecision, DecisionOutcome } from "./types";

export class SupabaseDecisionStore implements DecisionStore {
  constructor(private supabase: SupabaseClient) {}
  async saveDecision(decision: CafeDecision): Promise<void> {
    const { error } = await this.supabase.from("cafe_decisions").upsert({ id: decision.id, business_id: decision.businessId, type: decision.type, entity_type: decision.entityType ?? null, entity_id: decision.entityId ?? null, recommendation: decision.recommendation, supporting_signal_ids: decision.supportingSignalIds, confidence: decision.confidence, expected_impact: decision.expectedImpact ?? null, status: decision.status, autonomy_level: decision.autonomyLevel, provenance: decision.provenance, created_at: decision.createdAt.toISOString(), updated_at: new Date().toISOString() });
    if (error) throw error;
  }
  async saveOutcome(outcome: DecisionOutcome): Promise<void> {
    const { error } = await this.supabase.from("decision_outcomes").upsert({ id: outcome.id, business_id: outcome.businessId, decision_id: outcome.decisionId, period_from: outcome.measurementPeriod.from, period_to: outcome.measurementPeriod.to, metrics: outcome.metrics, notes: outcome.notes ?? null, recorded_at: outcome.recordedAt.toISOString() });
    if (error) throw error;
  }
  async getDecisionHistory(businessId: string): Promise<CafeDecision[]> {
    const { data, error } = await this.supabase.from("cafe_decisions").select("*").eq("business_id", businessId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => ({ id: row.id, businessId: row.business_id, type: row.type, entityType: row.entity_type ?? undefined, entityId: row.entity_id ?? undefined, recommendation: row.recommendation, supportingSignalIds: row.supporting_signal_ids, confidence: row.confidence, expectedImpact: row.expected_impact ?? undefined, status: row.status, autonomyLevel: row.autonomy_level, provenance: row.provenance, createdAt: new Date(row.created_at) })) as CafeDecision[];
  }
  async getOutcomes(decisionId: string): Promise<DecisionOutcome[]> {
    const { data, error } = await this.supabase.from("decision_outcomes").select("*").eq("decision_id", decisionId).order("recorded_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => ({ id: row.id, businessId: row.business_id, decisionId: row.decision_id, measurementPeriod: { from: row.period_from, to: row.period_to }, metrics: row.metrics, notes: row.notes ?? undefined, recordedAt: new Date(row.recorded_at) })) as DecisionOutcome[];
  }
}
