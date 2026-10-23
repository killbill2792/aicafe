import { describe, expect, it } from "vitest";
import { STYLE_RULES, styleReport } from "./style";
import { chatExperienceFlags } from "./flags";

describe("answer style rules", () => {
  it("covers every owner-facing rule and stays small enough to cache cheaply", () => {
    for (const rule of ["Answer first", "2-3 sentences", "next step", "No filler", "missing", "language", "propose tool"])
      expect(STYLE_RULES).toContain(rule);
    // ~4 chars per token: keep the always-sent prefix under ~200 tokens.
    expect(STYLE_RULES.length).toBeLessThan(800);
    expect(STYLE_RULES).not.toMatch(/\d{4}-\d{2}-\d{2}/u); // never per-turn data in the cached prefix
  });
  it("reports length and filler without exempting ordinary prose", () => {
    expect(styleReport("Sales are $1,200 this week. Add Monday's receipts to fill the gap.")).toMatchObject({ sentences: 2, tooLong: false, filler: false });
    expect(styleReport("Great question! One. Two. Three. Four. Five.")).toMatchObject({ tooLong: true, filler: true });
  });
  it("exempts tables and schedules from the length rule", () => {
    const table = "| Day | Staff |\n|---|---|\n| Mon | Ana |\n| Tue | Leo |";
    expect(styleReport(table).exempt).toBe(true);
    expect(styleReport("- Mon: Ana. Opens.\n- Tue: Leo. Closes.\n- Wed: Ana. Opens.\n- Thu: Sam. Closes. Then more.").tooLong).toBe(false);
  });
});

describe("chat experience flags", () => {
  it("ships dark by default and turns on per feature", () => {
    expect(chatExperienceFlags({})).toEqual({ style: false, jobs: false, memory: false });
    expect(chatExperienceFlags({ CHAT_STYLE_V2: "1", CHAT_JOBS: "true", CHAT_MEMORY: "0" }))
      .toEqual({ style: true, jobs: true, memory: false });
  });
});
