import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("legacy Plan URLs", () => {
  for (const [route, tab] of [
    ["break-even", "break-even"],
    ["economics", "profit-goal"],
    ["try-scenario", "what-if"],
  ]) {
    it(`redirects /more/${route} to the localized Plan tab ${tab}`, () => {
      const source = readFileSync(`app/[locale]/more/${route}/page.tsx`, "utf8");
      expect(source).toContain('import { redirect } from "@/i18n/navigation"');
      expect(source).toContain('locale: await getLocale()');
      expect(source).toContain('pathname: "/more/plan"');
      expect(source).toContain(`tab: "${tab}"`);
    });
  }
  it("keeps the monthly Money figure wired to the same view model as Plan", () => {
    const money = readFileSync("components/money/CostRecoveryView.tsx", "utf8");
    const plan = readFileSync("app/[locale]/more/plan/page.tsx", "utf8");
    expect(money).toContain("buildCostRecoveryViewModel(snapshot)");
    expect(plan).toContain("buildCostRecoveryViewModel(snapshot)");
    expect(money).toContain("vm.breakEven.breakEvenSalesCents");
    expect(plan).toContain("recovery.breakEven.breakEvenSalesCents");
    expect(money).toContain('href="/more/plan"');
  });
});
