import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
describe("themeable expense icon details", () => {
  it("preserves caller-provided detail and silhouette CSS variables", () => {
    const source=readFileSync("components/icons/ExpenseIconDefs.tsx", "utf8");
    expect(source).toContain("var(--detail, rgb(var(--c-surface)))");
    expect(source).toContain("var(--sil, rgb(var(--c-text)))");
  });
  it("keeps plain icon fills theme-aware on both modes", () => {
    const plain=readFileSync("components/icons/PlainIcon.tsx", "utf8");
    const bills=readFileSync("components/bills/BillsManager.tsx", "utf8");
    expect(plain).toContain('detailColor = "rgb(var(--c-surface))"');
    expect(bills).not.toContain('color="#2A1D14"');
    expect(bills).toContain('color="currentColor"');
  });
  it("uses theme fill gradients and a logical position for the check badge",()=>{
    const source=readFileSync("components/icons/FillIcon.tsx", "utf8");
    expect(source).toContain("rgb(var(--c-pos))");
    expect(source).toContain("-end-1");
    expect(source).not.toContain("-right-1");
  });
});
