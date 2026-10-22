import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("break-even chart icon contrast", () => {
  it("uses the tested matching foreground for the running-cost fill", () => {
    const source = readFileSync("app/[locale]/more/break-even/page.tsx", "utf8");
    expect(source).toContain("bg-running text-on-chart-running");
    expect(source).not.toContain("bg-running text-ink");
    expect(source).toContain("bg-staff text-on-chart-staff");
  });
});
