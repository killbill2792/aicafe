import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, agentInstructions } from "./loop.server";

describe("attention and attendance base instructions", () => {
  it.each([false, true])("keeps honesty rules when style flag is %s", style => {
    const prompt = agentInstructions();
    expect(prompt).not.toContain("get_attention_items");
    expect(prompt).toContain("distinguish verified unresolved actions from possible derived gaps");
    expect(prompt).toContain("attendanceTracked is false");
    expect(prompt).toContain("never report zero clocked in");
    expect(prompt).toContain("no schedule is set");
    for (const phrase of ["research saved task and alert states", "attendanceTracked is false", "no schedule is set"]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
