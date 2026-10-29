import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, agentInstructions } from "./loop.server";

describe("attention and attendance base instructions", () => {
  it.each([false, true])("keeps honesty rules when style flag is %s", style => {
    const prompt = agentInstructions();
    expect(prompt).toContain("get_attention_items");
    expect(prompt).toContain("never infer attention from staff");
    expect(prompt).toContain("attendanceTracked is false");
    expect(prompt).toContain("never report zero clocked in");
    expect(prompt).toContain("no schedule is set");
    for (const phrase of ["get_attention_items", "attendanceTracked is false", "no schedule is set"]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
