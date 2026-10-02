import { describe, expect, it } from "vitest";
import { allocateIntegerCentsByCategory, monthlyAmountForCategory, runningCostsForPeriodCents } from "./runningCosts";
import { roundHalfUpToCent } from "./money";

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

describe("allocateIntegerCentsByCategory", () => {
  it("sums to the rounded aggregate target even when independently rounding each category would not", () => {
    // Three $100/mo lines prorated for 1 day of a 31-day month: 10,000 / 31 = 322.5806...¢ each.
    // Math.round on each independently gives 323×3 = 969¢; the true aggregate 967.7419...¢ rounds
    // to 968¢ — the exact drift PR #6 review flagged.
    const raw = 10_000 / 31;
    const rawByCategory = new Map([
      ["rent", raw],
      ["water", raw],
      ["software", raw],
    ]);
    const targetCents = roundHalfUpToCent(raw * 3);
    expect(targetCents).toBe(968);

    const allocated = allocateIntegerCentsByCategory(rawByCategory, targetCents);
    const sum = [...allocated.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(968);
    for (const cents of allocated.values()) expect(Number.isInteger(cents)).toBe(true);
  });

  it("is deterministic: equal remainders break ties on category code, ascending", () => {
    const raw = 10_000 / 31;
    const rawByCategory = new Map([
      ["water", raw],
      ["rent", raw],
      ["software", raw],
    ]);
    // All three remainders are identical, so the 2 extra cents needed to reach 968 must go to the
    // two categories that sort first alphabetically: "rent" and "software", before "water".
    const allocated = allocateIntegerCentsByCategory(rawByCategory, 968);
    expect(allocated.get("rent")).toBe(323);
    expect(allocated.get("software")).toBe(323);
    expect(allocated.get("water")).toBe(322);
  });

  it("gives each category its exact share when the amounts already divide evenly", () => {
    const allocated = allocateIntegerCentsByCategory(new Map([["rent", 20_000], ["water", 500]]), 20_500);
    expect(allocated.get("rent")).toBe(20_000);
    expect(allocated.get("water")).toBe(500);
  });
});
