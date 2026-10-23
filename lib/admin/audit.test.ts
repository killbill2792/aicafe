import { describe, expect, it } from "vitest";
import { redactAuditText, estimatedTurnCost } from "./audit.server";
describe("private audit redaction", () => {
  it("removes credentials and contact data from recorded text", () => {
    const clean = redactAuditText("my api_key=abcdef012345 and password:open-sesame; call +1 (415) 555-0101; owner@cafe.com; Bearer abcdef");
    expect(clean).not.toContain("abcdef012345");
    expect(clean).not.toContain("open-sesame");
    expect(clean).not.toContain("owner@cafe.com");
    expect(clean).not.toContain("abcdef");
  });
  it("does not fabricate cost without configured prices", () => {
    const oldInput = process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
    const oldOutput = process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
    delete process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
    delete process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
    try {
      expect(estimatedTurnCost({ usage: { inputTokens: 100, outputTokens: 50 } } as never)).toBeNull();
    } finally {
      if (oldInput !== undefined) process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION = oldInput;
      if (oldOutput !== undefined) process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION = oldOutput;
    }
  });
});
