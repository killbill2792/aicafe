import { describe, expect, it } from "vitest";
import { supervisorReplyIdFor, validateGroundedReply, SupervisorReplyValidationError,
  buildReplyValidationFallbackReply } from "./replyValidation";
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

  it("applies the exact same grounding checks to percent blocks as metric/count", () => {
    const percentReply: GroundedSupervisorReply = {
      intent: "profitability", status: "verified", evidence: [source],
      blocks: [{ type: "percent", label: "Margin", valueBps: 1200, source }],
    };
    expect(validateGroundedReply(percentReply).blocks).toHaveLength(1);
    expect(() => validateGroundedReply({ ...percentReply, evidence: [] })).toThrow();
    expect(() => validateGroundedReply({
      ...percentReply, evidence: [{ ...source, identifier: "unrelated" }],
    })).toThrow("exact grounding");
    expect(() => validateGroundedReply({
      ...percentReply, status: "insufficient_evidence", evidence: [],
    })).toThrow("cannot contain factual metrics");
  });

  it("persists only text-only source-free P3 conditional arithmetic without café evidence", () => {
    const pure: GroundedSupervisorReply = {
      intent: "profitability", status: "partial", evidence: [],
      blocks: [
        { type: "warning", code: "P3_CONDITIONAL",
          text: "Conditional arithmetic, not verified café profit." },
        { type: "text", text: "Calculated scenario result: $2.50" },
      ],
    };
    expect(validateGroundedReply(pure)).toEqual(pure);
    expect(() => validateGroundedReply({
      ...pure, blocks: [{type: "text", text: "Unverified financial claim"}],
    })).toThrow("requires trusted evidence");
    expect(() => validateGroundedReply({
      ...pure, intent: "unknown",
    })).toThrow("requires trusted evidence");
    expect(() => validateGroundedReply({
      ...pure, blocks: [...pure.blocks, {type: "metric",label: "Profit",
        valueCents: 250,source}],
    })).toThrow();
  });

  it("rejects arbitrary extra keys, role spoofing and forged tool names", () => {
    expect(() => validateGroundedReply({
      ...valid, role: "supervisor", method: "update_price",
    } as unknown as GroundedSupervisorReply)).toThrow();
    expect(() => validateGroundedReply({
      ...valid, blocks: [{ type: "text", text: "Approved", action: "apply_price" }],
    } as unknown as GroundedSupervisorReply)).toThrow();
  });

  it("throws a distinguishable SupervisorReplyValidationError, tagged with exactly which check failed, instead of a plain Error", () => {
    const missingEvidence = (() => {
      try { validateGroundedReply({ ...valid, evidence: [] }); return null; }
      catch (error) { return error; }
    })();
    expect(missingEvidence).toBeInstanceOf(SupervisorReplyValidationError);
    expect((missingEvidence as SupervisorReplyValidationError).reason).toBe("missing_evidence");
    expect((missingEvidence as SupervisorReplyValidationError).reply.intent).toBe("profitability");

    const insufficientWithMetrics = (() => {
      try { validateGroundedReply({ ...valid, status: "insufficient_evidence", evidence: [] }); return null; }
      catch (error) { return error; }
    })();
    expect(insufficientWithMetrics).toBeInstanceOf(SupervisorReplyValidationError);
    expect((insufficientWithMetrics as SupervisorReplyValidationError).reason)
      .toBe("insufficient_evidence_with_metrics");

    const missingGroundingRef = (() => {
      try {
        validateGroundedReply({ ...valid, evidence: [{ ...source, identifier: "unrelated" }] });
        return null;
      } catch (error) { return error; }
    })();
    expect(missingGroundingRef).toBeInstanceOf(SupervisorReplyValidationError);
    expect((missingGroundingRef as SupervisorReplyValidationError).reason).toBe("missing_grounding_reference");
  });

  it("builds a graceful insufficient_evidence fallback, in every supported locale, that itself passes validateGroundedReply cleanly (no infinite failure loop)", () => {
    for (const locale of ["en", "es", "ar"] as const) {
      const fallback = buildReplyValidationFallbackReply(locale);
      expect(fallback.status).toBe("insufficient_evidence");
      expect(fallback.evidence).toEqual([]);
      expect(fallback.blocks.every((b) => b.type === "warning" || b.type === "text")).toBe(true);
      expect(validateGroundedReply(fallback)).toEqual(fallback);
    }
  });
});
