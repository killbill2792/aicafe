import { describe, expect, it } from "vitest";
import { supervisorReplyIdFor, validateGroundedReply,
  buildReplyValidationFallbackReply } from "./replyValidation";
import type { GroundedSupervisorReply } from "./contracts";

const source = { source: "cafe_state" as const, identifier: "profitability:2026-10-10", asOf: "2026-10-10" };
const valid: GroundedSupervisorReply = {
  intent: "profitability", status: "verified", evidence: [source],
  blocks: [{ type: "metric", label: "Owner profit", valueCents: 58048, source }],
};
describe("shared reply writer shape and storage limits", () => {
  it("creates deterministic, well-formed reply ids for idempotent retries", () => {
    const id = supervisorReplyIdFor("owner-message-1");
    expect(id).toBe(supervisorReplyIdFor("owner-message-1"));
    expect(id).not.toBe(supervisorReplyIdFor("owner-message-2"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("accepts model prose without requiring redundant evidence objects", () => {
    const reply: GroundedSupervisorReply = {
      intent: "unknown", status: "verified", evidence: [],
      blocks: [{type:"text",text:"The records show the expected result."}],
    };
    expect(validateGroundedReply(reply)).toEqual(reply);
  });
  it("continues enforcing integer cents, strict fields and block caps", () => {
    expect(validateGroundedReply(valid)).toEqual(valid);
    expect(() => validateGroundedReply({...valid,blocks:[
      {type:"metric",label:"Invalid cents",valueCents:1.99,source}]})).toThrow();
    expect(() => validateGroundedReply({...valid,blocks:[
      {type:"text",text:"X".repeat(1201)}]})).toThrow();
    expect(() => validateGroundedReply({...valid,blocks: Array.from({length:31}, () =>
      ({type:"text" as const,text:"Valid individual block"}))})).toThrow();
    expect(() => validateGroundedReply({...valid,blocks:[]})).toThrow();
    expect(() => validateGroundedReply(Object.assign({},valid,{role:"owner"}))).toThrow();
  });
  it("keeps fallback within the same safe schema in every locale", () => {
    for (const locale of ["en","es","ar"] as const) {
      const reply = buildReplyValidationFallbackReply(locale);
      expect(validateGroundedReply(reply)).toEqual(reply);
    }
  });
});
