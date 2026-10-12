import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
describe("Home Supervisor is unobstructed", () => {
  it("never mounts AddCostFab on Home at mobile or desktop breakpoints", () => {
    const home = readFileSync("app/[locale]/page.tsx","utf8");
    const fab = readFileSync("components/shared/AddCostFab.tsx","utf8");
    expect(home).toContain("<SupervisorHomePanel");
    expect(home).not.toContain("<AddCostFab");
    expect(fab).toContain('href="/add-cost"');
  });
});
