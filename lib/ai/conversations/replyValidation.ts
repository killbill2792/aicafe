import { createHash } from "node:crypto";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type { GroundedSupervisorReply } from "./contracts";
import { groundedReplySchema } from "./contracts";

export function supervisorReplyIdFor(ownerMessageId: string): string {
  const hex = createHash("sha256")
    .update("ai-cafe:supervisor-reply:v1:" + ownerMessageId).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) +
    "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

/** Exactly which of validateGroundedReply's checks rejected a reply. This gate
 * firing is never a normal "couldn't verify" outcome (those are already
 * handled earlier, before a reply ever reaches here) -- it always means an
 * upstream bug produced a reply that asserts a fact with no real grounding
 * behind it. Kept machine-readable (never the reply's own text/evidence) so
 * both the sanitized production diagnostic and the graceful owner-facing
 * fallback built from this error can act on exactly which check failed. */
export type ReplyValidationFailureReason =
  | "missing_evidence" | "insufficient_evidence_with_metrics" | "missing_grounding_reference";

/** Thrown by validateGroundedReply instead of a plain Error so the privileged
 * reply pipeline (persistGroundedSupervisorReply's caller) can recognize this
 * specific, always-a-bug failure and degrade to a safe fallback reply instead
 * of surfacing a raw/generic error to the owner. `reply` is the exact shape
 * that tripped the check, kept only for this same-process raw debug capture
 * (see logSupervisorDebugPayload) -- never for the sanitized production log. */
export class SupervisorReplyValidationError extends Error {
  readonly reason: ReplyValidationFailureReason;
  readonly reply: GroundedSupervisorReply;
  constructor(reason: ReplyValidationFailureReason, message: string, reply: GroundedSupervisorReply) {
    super(message);
    this.name = "SupervisorReplyValidationError";
    this.reason = reason;
    this.reply = reply;
  }
}

/** Same owner-facing copy the investigation loop's own exhaustion fallback
 * already uses for "I could not complete this reliably" (see
 * runInvestigationTurn's unavailable/budget fallback) -- reused rather than
 * inventing new owner-facing wording for this different, but equally
 * ungrounded, failure path. */
const fallbackText: Record<"en" | "es" | "ar", string> = {
  en: en.SupervisorInvestigation.unavailable,
  es: es.SupervisorInvestigation.unavailable,
  ar: ar.SupervisorInvestigation.unavailable,
};

/** Built ONLY when validateGroundedReply's final safety gate rejects a reply
 * that should never have reached it -- a genuine upstream bug, never a normal
 * "couldn't verify" outcome (those are handled earlier in the pipeline). A
 * safe, minimal, honest substitute the owner can act on: the existing
 * insufficient_evidence status plus a single warning block, in the same
 * spirit as the investigation loop's own exhaustion fallback. This shape is
 * one validateGroundedReply already accepts cleanly (no evidence/metric
 * blocks to re-check), so persisting it can never re-trigger this same gate. */
export function buildReplyValidationFallbackReply(locale: "en" | "es" | "ar"): GroundedSupervisorReply {
  return {
    intent: "unknown", status: "insufficient_evidence", evidence: [],
    blocks: [{ type: "warning", code: "SUPERVISOR_REPLY_VALIDATION_FAILED", text: fallbackText[locale] }],
  };
}

/** Reject metrics with no exact source citation before the privileged insert. */
export function validateGroundedReply(reply: GroundedSupervisorReply): GroundedSupervisorReply {
  const validated = groundedReplySchema.parse(reply);
  // A server-validated question is a pending request, never a verified business fact.
  if(validated.status==="requires_owner_input"){
    const cards=validated.blocks.filter(block=>block.type==="owner_question");
    if(!validated.ownerInput||cards.length!==1||
      cards[0].type!=="owner_question"||
      cards[0].questionId!==validated.ownerInput.questionId)
      throw new SupervisorReplyValidationError("missing_evidence","Invalid owner-input state",validated);
    const otherBlocks=validated.blocks.filter(block=>block.type!=="owner_question");
    // A reviewed, source-backed PARTIAL result may accompany one durable card
    // without losing the verified work. Every factual block retains its exact
    // validated evidence reference; source-free text stays card-only.
    if(otherBlocks.length&&(!validated.evidence.length||
      otherBlocks.some(block=>block.type==="owner_question"||
        (block.type==="metric"||block.type==="count"||block.type==="percent"||
          block.type==="task_status"||block.type==="task_card")&&
        !validated.evidence.some(e=>e.source===block.source.source&&
          e.identifier===block.source.identifier&&e.asOf===block.source.asOf))))
      throw new SupervisorReplyValidationError("missing_evidence",
        "Owner-input partial evidence failed its source contract",validated);
    return validated;
  }
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
  const sourceFreeAdvice=validated.status==="partial"&&validated.intent==="unknown"&&
    validated.evidence.length===0&&validated.blocks[0]?.type==="warning"&&
    validated.blocks[0].code==="SUPERVISOR_ADVICE"&&
    validated.blocks.every(b=>b.type==="text"||b.type==="warning");
  if (!["insufficient_evidence","unavailable"].includes(validated.status) &&
      validated.evidence.length === 0 && !sourceFreeP3 && !sourceFreeAdvice) {
    throw new SupervisorReplyValidationError("missing_evidence",
      "Supervisor response requires trusted evidence", validated);
  }
  if (["insufficient_evidence","unavailable"].includes(validated.status) &&
      validated.blocks.some((block) => block.type === "metric" || block.type === "count" || block.type === "percent" || block.type === "task_status" || block.type === "task_card")) {
    throw new SupervisorReplyValidationError("insufficient_evidence_with_metrics",
      "Insufficient evidence cannot contain factual metrics or task claims", validated);
  }
  for (const block of validated.blocks) {
    if ((block.type === "metric" || block.type === "count" || block.type === "percent" || block.type === "task_status" || block.type === "task_card") &&
        !validated.evidence.some((e) => e.source === block.source.source &&
          e.identifier === block.source.identifier && e.asOf === block.source.asOf)) {
      throw new SupervisorReplyValidationError("missing_grounding_reference",
        "Metric or task is missing its exact grounding reference", validated);
    }
  }
  return validated;
}
