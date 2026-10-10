import { describe, expect, it } from "vitest";
import { supervisorReplyIdFor, validateGroundedReply } from "./replyValidation";
import type { GroundedSupervisorReply } from "./contracts";

const source = { source: "cafe_state" as const, identifier: "profitability:2026-10-10", asOf: "2026-10-10" };
const valid: GroundedSupervisorReply = {
  intent: "profitability", status: "verified", evidence: [source],
  blocks: [{ type: "metric", label: "Owner profit", valueCents: 58048, source }],
};

describe("Phase 4 privileged reply validation", () => {
  it("creates the same UUID for the same owner message on every retry", () => {
    const id = supervisorReplyIdFor("owner-message-1");
    expect(id).toBe(supervisorReplyIdFor("owner-message-1"));
    expect(id).not.toBe(supervisorReplyIdFor("owner-message-2"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("accepts only safe integer money backed by exact evidence", () => {
    expect(validateGroundedReply(valid).blocks).toHaveLength(1);
    expect(() => validateGroundedReply({ ...valid, evidence: [] })).toThrow();
    expect(() => validateGroundedReply({
      ...valid, evidence: [{ ...source, identifier: "unrelated" }],
    })).toThrow("exact grounding");
    expect(() => validateGroundedReply({
      ...valid, blocks: [{ type: "metric", label: "Bad", valueCents: 1.99, source }],
    })).toThrow();
  });

  it("rejects hallucinated metrics on insufficient-evidence replies", () => {
    expect(() => validateGroundedReply({
      ...valid, status: "insufficient_evidence", evidence: [],
    })).toThrow("cannot contain factual metrics");
    const notice: GroundedSupervisorReply = {
      intent: "unknown", status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "unsupported", text: "Not supported" }],
    };
    expect(validateGroundedReply(notice)).toEqual(notice);
  });

  it("rejects arbitrary extra keys, role spoofing and forged tool names", () => {
    expect(() => validateGroundedReply({
      ...valid, role: "supervisor", method: "update_price",
    } as unknown as GroundedSupervisorReply)).toThrow();
    expect(() => validateGroundedReply({
      ...valid, blocks: [{ type: "text", text: "Approved", action: "apply_price" }],
    } as unknown as GroundedSupervisorReply)).toThrow();
  });
});
