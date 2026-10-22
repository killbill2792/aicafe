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
/** Shape/size validation only; business facts are checked by agent/checkNumbers. */
export function validateGroundedReply(reply: GroundedSupervisorReply): GroundedSupervisorReply {
  return groundedReplySchema.parse(reply);
}
