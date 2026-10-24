import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("break-even chart icon contrast", () => {
  it("preserves the tested foreground/background pairs on the consolidated Plan screen", () => {
    const source = readFileSync("app/[locale]/more/plan/page.tsx", "utf8");
    expect(source).toContain("bg-running text-on-chart-running");
    expect(source).not.toContain("bg-running text-ink");
    expect(source).toContain("bg-staff text-on-chart-staff");
    expect(source).not.toContain("bg-staff text-ink");
  });
  it("links every displayed monthly cost source and uses the Money view model", () => {
    const source = readFileSync("app/[locale]/more/plan/page.tsx", "utf8");
    expect(source).toContain("buildCostRecoveryViewModel(snapshot)");
    for (const fragment of ["recovery.breakEven.monthlyBillsCents", "recovery.breakEven.monthlyStaffCents",
      "recovery.breakEven.ingredientCostsAtBreakEvenCents", "recovery.breakEven.processingFeesAtBreakEvenCents"]) {
      expect(source).toContain(fragment);
    }
  });
});
