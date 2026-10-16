import { createHash } from "node:crypto";
import type { GroundedSupervisorReply } from "./contracts";
import { groundedReplySchema } from "./contracts";

export function supervisorReplyIdFor(ownerMessageId: string): string {
  const hex = createHash("sha256")
    .update("ai-cafe:supervisor-reply:v1:" + ownerMessageId).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) +
    "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

/** Reject metrics with no exact source citation before the privileged insert. */
export function validateGroundedReply(reply: GroundedSupervisorReply): GroundedSupervisorReply {
  const validated = groundedReplySchema.parse(reply);
  // The P3 arithmetic evaluator can produce a deterministic owner-only what-if
  // using no café reads. Its result is necessarily conditional and consists
  // entirely of server-built text/warnings; it must never fabricate café
  // evidence just to satisfy the generic grounding requirement.
  const sourceFreeP3 = validated.status === "partial" &&
    validated.intent === "profitability" && validated.evidence.length === 0 &&
    validated.blocks[0]?.type === "warning" &&
    validated.blocks[0].code === "P3_CONDITIONAL" &&
    validated.blocks.some(b => b.type === "text") &&
    validated.blocks.every(b => b.type === "text" || b.type === "warning");
  if (!["insufficient_evidence","unavailable"].includes(validated.status) &&
      validated.evidence.length === 0 && !sourceFreeP3) {
    throw new Error("Supervisor response requires trusted evidence");
  }
  if (["insufficient_evidence","unavailable"].includes(validated.status) &&
      validated.blocks.some((block) => block.type === "metric" || block.type === "count" || block.type === "task_status" || block.type === "task_card")) {
    throw new Error("Insufficient evidence cannot contain factual metrics or task claims");
  }
  for (const block of validated.blocks) {
    if ((block.type === "metric" || block.type === "count" || block.type === "task_status" || block.type === "task_card") &&
        !validated.evidence.some((e) => e.source === block.source.source &&
          e.identifier === block.source.identifier && e.asOf === block.source.asOf)) {
      throw new Error("Metric or task is missing its exact grounding reference");
    }
  }
  return validated;
}
