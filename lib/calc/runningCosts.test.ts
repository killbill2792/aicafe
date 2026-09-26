import { describe, expect, it } from "vitest";
import { monthlyAmountForCategory, runningCostsForPeriodCents } from "./runningCosts";

describe("monthlyAmountForCategory", () => {
  it("uses actual expenses when any exist this month", () => {
    const result = monthlyAmountForCategory(
      [{ amountCents: 1_000, status: "actual" }, { amountCents: 500, status: "actual" }],
      { amountCents: 2_000, isEstimate: false },
    );
    expect(result).toEqual({ amountCents: 1_500, isEstimate: false, isMissing: false });
  });

  it("labels the category an estimate if any actual entry is estimated", () => {
    const result = monthlyAmountForCategory([{ amountCents: 1_000, status: "estimated" }], null);
    expect(result.isEstimate).toBe(true);
  });

  it("falls back to the recurring estimate when nothing was recorded this month", () => {
    const result = monthlyAmountForCategory([], { amountCents: 78_000, isEstimate: true });
    expect(result).toEqual({ amountCents: 78_000, isEstimate: true, isMissing: false });
  });

  it("is missing when there's no actual and no recurring row at all", () => {
    const result = monthlyAmountForCategory([], null);
    expect(result).toEqual({ amountCents: 0, isEstimate: false, isMissing: true });
  });
});

describe("runningCostsForPeriodCents", () => {
  it("prorates a full 30-day September at $9,600/mo to $320.00/day", () => {
    const cents = runningCostsForPeriodCents(
      [{ categoryCode: "all", monthKey: "2026-09", amountCents: 960_000, isEstimate: false, isMissing: false }],
      "2026-09-01",
      "2026-09-01",
    );
    expect(cents).toBeCloseTo(32_000, 6);
  });

  it("splits a period across two calendar months", () => {
    // Sep has 30 days, Oct has 31. A period from Sep 29 to Oct 2 covers 2 days of Sep, 2 of Oct.
    const cents = runningCostsForPeriodCents(
      [
        { categoryCode: "rent", monthKey: "2026-09", amountCents: 300_000, isEstimate: false, isMissing: false },
        { categoryCode: "rent", monthKey: "2026-10", amountCents: 310_000, isEstimate: false, isMissing: false },
      ],
      "2026-09-29",
      "2026-10-02",
    );
    // Sep: 300,000/30 × 2 = 20,000. Oct: 310,000/31 × 2 = 20,000.
    expect(cents).toBeCloseTo(40_000, 0);
  });
});
