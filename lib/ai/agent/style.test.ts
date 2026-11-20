import { describe, expect, it } from "vitest";
import { STYLE_RULES, styleReport } from "./style";

describe("answer style rules", () => {
  it("covers every owner-facing rule and stays small enough to cache cheaply", () => {
    for (const rule of ["Answer first", "adapt the depth", "not a fixed length", "Markdown headings", "tables", "whenever they help", "next step", "only when useful", "No filler", "missing", "language", "propose tool"])
      expect(STYLE_RULES).toContain(rule);
    expect(STYLE_RULES).not.toMatch(/(?:2-3 sentences|at most 1-2|End with one next step|owner asked for)/u);
    // ~4 chars per token: keep the always-sent prefix compact.
    expect(STYLE_RULES.length).toBeLessThan(1000);
    expect(STYLE_RULES).not.toMatch(/\d{4}-\d{2}-\d{2}/u); // never per-turn data in the cached prefix
  });
  it("reports length and filler without exempting ordinary prose", () => {
    expect(styleReport("Sales are $1,200 this week. Add Monday's receipts to fill the gap.")).toMatchObject({ sentences: 2, tooLong: false, filler: false });
    expect(styleReport("Great question! One. Two. Three. Four. Five.")).toMatchObject({ tooLong: true, filler: true });
  });
  it("excludes tables and schedules from the historical length diagnostic", () => {
    const table = "| Day | Staff |\n|---|---|\n| Mon | Ana |\n| Tue | Leo |";
    expect(styleReport(table).exempt).toBe(true);
    expect(styleReport("- Mon: Ana. Opens.\n- Tue: Leo. Closes.\n- Wed: Ana. Opens.\n- Thu: Sam. Closes. Then more.").tooLong).toBe(false);
  });
});
