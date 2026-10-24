import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BucketResult } from "@/lib/calc";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as React.ReactNode),
}));

import CostRecoveryStrip from "./CostRecoveryStrip";
const makeBucket = (code: string, pctCovered: number, coveredOn: string | null = null): BucketResult => ({
  code, amountCents:10000, isEstimate:false, pctCovered, centsToGo:10000,
  coveredOn, projectedCoveredOn:null,
});

describe("Home cost recovery line", () => {
  it("shows only the next unfinished cost and not a second bucket dashboard", () => {
    const html = renderToStaticMarkup(createElement(CostRecoveryStrip,{
      buckets:[makeBucket("rent",100,"2026-10-02"),makeBucket("water",45),makeBucket("software",0)],
      labels:{rent:"Rent",water:"Water",software:"Software"},
      coveredLabel:(label,date)=>`${label} covered ${date}`,
      emptyLabel:"Add bills",locale:"en",
    }));
    expect(html).toContain("Water 45%");
    expect(html).not.toContain("Software");
    expect(html).not.toContain("Rent covered");
    expect((html.match(/<p /g) ?? []).length).toBe(1);
  });

  it("never reports a numeric recovered percentage when required cost evidence is missing", () => {
    const html = renderToStaticMarkup(createElement(CostRecoveryStrip,{
      buckets:[makeBucket("rent",100,"2026-10-02"),makeBucket("water",45)],
      labels:{rent:"Rent",water:"Water"},
      coveredLabel:(label,date)=>`${label} covered ${date}`,
      emptyLabel:"Add bills",incompleteLabel:"Some costs are not verified yet",
      dataComplete:false,locale:"en",
    }));
    expect(html).toContain("Some costs are not verified yet");
    expect(html).not.toContain("Water 45%");
    expect(html).not.toContain("Rent covered");
    expect(html).toContain('href="/money"');
  });

  it("localizes dates and describes an empty cost setup rather than 0% covered", () => {
    const copy = {labels:{rent:"إيجار"},emptyLabel:"أضف الفواتير",locale:"ar"};
    const html = renderToStaticMarkup(createElement(CostRecoveryStrip,{
      buckets:[makeBucket("rent",100,"2026-10-02")],
      ...copy,coveredLabel:(label,date)=>`${label} ✓ ${date}`,
    }));
    expect(html).toContain("إيجار");
    expect(html).not.toContain("Oct 2");
    const empty = renderToStaticMarkup(createElement(CostRecoveryStrip,{
      buckets:[], ...copy, dataComplete:false, incompleteLabel:"غير مكتمل",
      coveredLabel:(label,date)=>`${label} ✓ ${date}`,
    }));
    expect(empty).toContain("أضف الفواتير");
    expect(empty).not.toContain("0%");
  });
});
