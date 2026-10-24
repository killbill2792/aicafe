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
  it("never persists names, addresses, bank lines, receipts or arbitrary answers",()=>{
    const content="Paid Jane Doe at 12 Market Street with Visa ending 1234; receipt: espresso $12.34; bank ACH reference 888";
    expect(redactAuditText(content)).toBe("[content withheld]");
    expect(redactAuditText("")).toBe("");
  });
  it("does not fabricate cost without configured prices", () => {
    const oldInput = process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
    const oldOutput = process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
    const oldSupervisorInput = process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS;
    const oldSupervisorOutput = process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS;
    delete process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
    delete process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
    delete process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS;
    delete process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS;
    try {
      expect(estimatedTurnCost({ usage: { inputTokens: 100, outputTokens: 50 } } as never)).toBeNull();
    } finally {
      if (oldInput !== undefined) process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION = oldInput;
      if (oldOutput !== undefined) process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION = oldOutput;
      if (oldSupervisorInput !== undefined) process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS = oldSupervisorInput;
      if (oldSupervisorOutput !== undefined) process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS = oldSupervisorOutput;
    }
  });
  it("uses model pricing already configured for supervisor, without requiring new secrets",()=>{
    const previous=[process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION,process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION,
      process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS,process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS];
    delete process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION;
    delete process.env.ADMIN_MODEL_OUTPUT_USD_PER_MILLION;
    process.env.SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS="1";
    process.env.SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS="2";
    try {
      expect(estimatedTurnCost({usage:{inputTokens:2000000,outputTokens:500000}} as never)).toBe(3);
      process.env.ADMIN_MODEL_INPUT_USD_PER_MILLION="1";
      expect(estimatedTurnCost({usage:{inputTokens:2000000,outputTokens:500000}} as never)).toBeNull();
    }finally{
      const names=["ADMIN_MODEL_INPUT_USD_PER_MILLION","ADMIN_MODEL_OUTPUT_USD_PER_MILLION","SUPERVISOR_INPUT_USD_PER_MILLION_TOKENS","SUPERVISOR_OUTPUT_USD_PER_MILLION_TOKENS"];
      names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});
    }
  });
});
