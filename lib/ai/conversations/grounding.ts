import type { KnownSlice } from "@/lib/operating/types";
import type { EvidenceReference, GroundingStatus, SupervisorIntent } from "./contracts";

export type GroundingAssessment = {
  intent: SupervisorIntent;
  status: GroundingStatus;
  evidence: EvidenceReference[];
  missingInputs: string[];
  estimatedInputs: string[];
};

/**
 * Phase 3 grounding gate used by Phase 4's router. An available slice alone is
 * not sufficient for an answer: the router must also provide source references.
 * Missing data always wins over estimates, which win over verified values.
 *
 * This function deliberately does not generate text, infer numbers, or execute tools.
 */
export function assessGrounding(
  intent: SupervisorIntent,
  slice: KnownSlice<unknown> | null,
  evidence: EvidenceReference[],
): GroundingAssessment {
  const validEvidence = evidence.filter(
    (entry) => entry.identifier.trim() !== "" && entry.asOf.trim() !== "",
  );
  const missingInputs = [
    ...(slice?.quality.missingInputs ?? ["unavailableToolResult"]),
    ...(!slice?.available ? ["unavailableToolResult"] : []),
    ...(validEvidence.length === 0 ? ["missingEvidenceReferences"] : []),
  ];
  const estimatedInputs = slice?.quality.estimatedInputs ?? [];
  const status: GroundingStatus =
    missingInputs.length > 0 ? "insufficient_evidence" :
    estimatedInputs.length > 0 ? "estimated" : "verified";
  return {
    intent,
    status,
    evidence: status === "insufficient_evidence" ? [] : validEvidence,
    missingInputs: [...new Set(missingInputs)],
    estimatedInputs: [...new Set(estimatedInputs)],
  };
}
