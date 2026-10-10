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
  if (validated.status !== "insufficient_evidence" && validated.evidence.length === 0) {
    throw new Error("Supervisor response requires trusted evidence");
  }
  if (validated.status === "insufficient_evidence" &&
      validated.blocks.some((block) => block.type === "metric" || block.type === "count" || block.type === "task_status")) {
    throw new Error("Insufficient evidence cannot contain factual metrics or task claims");
  }
  for (const block of validated.blocks) {
    if ((block.type === "metric" || block.type === "count" || block.type === "task_status") &&
        !validated.evidence.some((e) => e.source === block.source.source &&
          e.identifier === block.source.identifier && e.asOf === block.source.asOf)) {
      throw new Error("Metric or task is missing its exact grounding reference");
    }
  }
  return validated;
}
