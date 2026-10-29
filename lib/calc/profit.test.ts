import { describe, expect, it } from "vitest";
import { averageOrderValueCents, staffCostCentsForPeriod, laborKnown, laborWageStatusFromTimecards } from "./profit";
import type { DailyFacts } from "./types";

describe("averageOrderValueCents", () => {
  it("rounds a non-whole division half-up to the cent, never leaking fractional cents", () => {
    // 1,000 / 3 = 333.333...¢ — must round to a whole cent, not stay fractional.
    const result = averageOrderValueCents(1_000, 3);
    expect(result).toBe(333);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("rounds a half-cent case up, matching the repository's half-up rule", () => {
    // 1,001 / 2 = 500.5¢ -> 501¢.
    expect(averageOrderValueCents(1_001, 2)).toBe(501);
  });

  it("is 0 when there are no orders, never a division-by-zero NaN/Infinity", () => {
    expect(averageOrderValueCents(5_000, 0)).toBe(0);
  });

  it("divides evenly when sales split evenly across orders", () => {
    expect(averageOrderValueCents(9_000, 3)).toBe(3_000);
  });
});

describe("partial payroll never becomes a final profit", () => {
  const day: DailyFacts = { date:"2026-10-22",netSalesCents:20000,ordersCount:10,
    drinksCount:12,ingredientsCents:2000,wagesCents:3500,staffTaxCents:420,
    laborWageStatus:"missing",cardFeesCents:200,voidsCents:0 };
  it("retains known cents without treating missing wages as a complete total",()=>{
    expect(day.wagesCents).toBe(3500);
    expect(staffCostCentsForPeriod([day])).toBeNull();
    expect(staffCostCentsForPeriod([{...day,laborWageStatus:"actual"}])).toBe(3920);
  });
});


describe("shared labor completeness",()=>{
  it("rejects known-only wages on missing days, not actual or estimated days",()=>{
    const day={wagesCents:3500,staffTaxCents:420,laborWageStatus:"missing" as const};
    expect(laborKnown(day)).toBe(false);
    expect(laborKnown({...day,laborWageStatus:"actual"})).toBe(true);
    expect(laborKnown({...day,laborWageStatus:"estimate"})).toBe(true);
    expect(laborKnown({...day,staffTaxCents:null})).toBe(false);
  });
});

describe("empty attendance does not certify zero labor",()=>{
  it("marks absent timecards and nullable wages as missing, preserving explicit zero pay",()=>{
    expect(laborWageStatusFromTimecards([])).toBe("missing");
    expect(laborWageStatusFromTimecards([
      {hourly_wage_cents:null,wage_source:"pos"},
      {hourly_wage_cents:1900,wage_source:"pos"}])).toBe("missing");
    expect(laborWageStatusFromTimecards([{hourly_wage_cents:0,wage_source:"pos"}])).toBe("actual");
    expect(laborWageStatusFromTimecards([{hourly_wage_cents:1900,wage_source:"estimate"}])).toBe("estimate");
  });
});
