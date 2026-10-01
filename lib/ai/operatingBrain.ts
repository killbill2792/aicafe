import type { CafeDecision, CafeSignal } from "@/lib/operating/types";
import type { AIProvider } from "./types";
import type { CafeToolset } from "./tools";

export interface CafeOperatingBrain {
  observe(businessId: string): Promise<{ signals: CafeSignal[]; decisions: CafeDecision[] }>;
  explainDecision(decision: CafeDecision): Promise<{ text: string; source: "ai" | "deterministic" }>;
}

/** AI failure never removes deterministic observations or recommendations. */
export class OptionalCafeOperatingBrain implements CafeOperatingBrain {
  constructor(private provider: AIProvider, private tools: CafeToolset) {}
  async observe(businessId: string) { return this.tools.getOperatingSnapshot(businessId); }
  async explainDecision(decision: CafeDecision) {
    const fallback = `${decision.recommendation.action}: ${JSON.stringify(decision.recommendation.parameters)}`;
    try {
      if (!(await this.provider.isAvailable())) return { text: fallback, source: "deterministic" as const };
      const result = await this.provider.explain({ subject: decision.recommendation.action, facts: decision.provenance.dataSnapshot, assumptions: decision.provenance.assumptions });
      return { text: result.text || fallback, source: result.text ? "ai" as const : "deterministic" as const };
    } catch {
      return { text: fallback, source: "deterministic" as const };
    }
  }
}
