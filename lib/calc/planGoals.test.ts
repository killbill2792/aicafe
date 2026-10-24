import { describe, expect, it } from "vitest";
import { weekdayHourlyTarget, simulatePlanChange } from "./planGoals";
import { calculateBreakEvenSales } from "./breakEvenSales";

const base = {
  monthlyBillsCents: 300000,
  monthlyStaffCents: 300000,
  observedSalesCents: 1000000,
  observedIngredientCents: 300000,
  observedProcessingFeesCents: 30000,
  daysInMonth: 30,
  payrollTaxRate: 0.12,
};
const item = { id: "a", name: "Latte", priceCents: 500, ingredientsCentsToday: 120,
  quantitySoldLast28Days: 100, costStatus: "READY" as const };

describe("Plan goals", () => {
  it("uses weekday hours rather than a fixed 12-hour day", () => {
    const openHours = { fri: [["07:00", "15:00"]] as [string,string][] };
    expect(weekdayHourlyTarget(80, openHours, "2026-10-23")).toMatchObject({ hours: 8, perHour: 10, fallback: false });
    expect(weekdayHourlyTarget(80, null, "2026-10-23")).toMatchObject({ hours: 12, perHour: 7, fallback: true });
    expect(weekdayHourlyTarget(80, { fri: [] }, "2026-10-23")).toMatchObject({ closed: true, perHour: null });
  });
  it("counts overnight and overlapping periods once", () => {
    expect(weekdayHourlyTarget(80, { fri: [["20:00","02:00"],["22:00","01:00"]] as [string,string][] }, "2026-10-23")).toMatchObject({ hours: 6, perHour: 14 });
  });
  it("starts from the same monthly break-even as Money", () => {
    const money = calculateBreakEvenSales(base);
    expect(money.kind).toBe("ready");
    const simulation = simulatePlanChange({ base, type: "price", item, newValueCents: item.priceCents,
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    expect(simulation?.monthlyBreakEvenCents).toBe(money.kind === "ready" ? money.breakEvenSalesCents : null);
    expect(simulation?.breakEvenChangeCents).toBe(0);
    expect(simulation?.monthlyProfitChangeCents).toBe(0);
  });
  it("makes higher ingredient costs worse and fewer staff hours cheaper", () => {
    const ingredient = simulatePlanChange({ base, type: "ingredient", item, newValueCents: 150,
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    const staff = simulatePlanChange({ base, type: "staff", item: null, newValueCents: 0,
      staffHoursPerDay: 2, assumedHourlyWageCents: 1950 });
    expect(ingredient?.breakEvenChangeCents).toBeGreaterThan(0);
    expect(ingredient?.monthlyProfitChangeCents).toBeLessThan(0);
    expect(staff?.breakEvenChangeCents).toBeLessThan(0);
    expect(staff?.monthlyProfitChangeCents).toBeGreaterThan(0);
  });
});
