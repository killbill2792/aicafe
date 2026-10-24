import { describe, expect, it } from "vitest";
import { countPlanOperatingDays, coveredPlanOperatingDays, hasCompletePlanHours, hasPlanSalesOnClosedDays, hasUncoveredPlanOperatingDates, monthlyReducibleStaffHours, weekdayHourlyTarget, simulatePlanChange } from "./planGoals";
import { calculateBreakEvenSales } from "./breakEvenSales";

const base = {
  monthlyBillsCents: 300000,
  monthlyStaffCents: 300000,
  observedSalesCents: 1000000,
  observedIngredientCents: 300000,
  observedProcessingFeesCents: 30000,
  daysInMonth: 30,
  monthKey: "2026-04",
  openHours: null,
  salesDaysCovered: 28,
  operatingDaysInMonth: 30,
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
  it("price preset changes every sold item, while milk changes only sold drinks", () => {
    const products = [
      { ...item, category: "drink" as const, quantitySoldLast28Days: 100 },
      { ...item, id: "b", category: "drink" as const, quantitySoldLast28Days: 200 },
      { ...item, id: "c", category: "food" as const, quantitySoldLast28Days: 50 },
    ];
    const one = simulatePlanChange({ base, type: "price", item: products[0], newValueCents: 525,
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    const all = simulatePlanChange({ base, type: "price", item: null, newValueCents: 25,
      preset: "allPrices", items: products, staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    const milk = simulatePlanChange({ base, type: "ingredient", item: null, newValueCents: 100,
      preset: "milk", items: products, staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    expect(all?.monthlyProfitChangeCents).toBeGreaterThan(one!.monthlyProfitChangeCents);
    expect(milk?.monthlyProfitChangeCents).toBe(Math.round(-Math.round(300 * 150 * 100 / 3785) * 30 / 28));
  });
  it("normalizes seven covered sales days rather than pretending the item units cover 28", () => {
    const sevenDay = { ...base, salesDaysCovered: 7, operatingDaysInMonth: 22 };
    const amount = simulatePlanChange({ base: sevenDay, type: "price", item, newValueCents: 525,
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    const observedCents = 25 * item.quantitySoldLast28Days;
    expect(amount?.monthlyProfitChangeCents).toBe(Math.round(observedCents * 22 / 7));
    expect(amount?.breakEvenChangeCents).toBeLessThan(0);
    const cost = simulatePlanChange({ base: sevenDay, type: "ingredient", item, newValueCents: 145,
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    expect(cost?.monthlyProfitChangeCents).toBe(-Math.round(observedCents * 22 / 7));
    const fullWindow = simulatePlanChange({ base: { ...sevenDay, salesDaysCovered: 28 },
      type: "price", item, newValueCents: 525, staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    expect(fullWindow?.monthlyProfitChangeCents).toBe(Math.round(observedCents * 22 / 28));
  });
  it("does not count zero-order closed dates as historical selling days (Codex P1)", () => {
    const closedWeekends = { sat: [] as [string, string][], sun: [] as [string, string][] };
    const days = Array.from({ length: 28 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, i + 1)).toISOString().slice(0, 10),
    }));
    // Square marks every day actual, including Saturday/Sunday zero-order syncs.
    expect(days).toHaveLength(28);
    expect(coveredPlanOperatingDays(days, closedWeekends)).toBe(20);
    expect(hasUncoveredPlanOperatingDates(days, closedWeekends)).toBe(false);
    const scenario = simulatePlanChange({
      base: { ...base, salesDaysCovered: coveredPlanOperatingDays(days, closedWeekends),
        operatingDaysInMonth: 22, daysInMonth: 31 },
      type: "price", item: { ...item, quantitySoldLast28Days: 2000 },
      newValueCents: 525, staffHoursPerDay: 0, assumedHourlyWageCents: 1950,
    });
    expect(scenario?.monthlyProfitChangeCents).toBe(55_000); // $500 over 20 open days -> $550 over 22
  });
  it("withholds projections when the old sales history contradicts today's closed schedule", () => {
    const weekends = { sat: [] as [string,string][], sun: [] as [string,string][] };
    expect(hasPlanSalesOnClosedDays([
      { date: "2026-10-10", netSalesCents: 50000, ordersCount: 10 },
    ], weekends)).toBe(true);
    expect(hasPlanSalesOnClosedDays([
      { date: "2026-10-10", netSalesCents: 0, ordersCount: 0 },
      { date: "2026-10-12", netSalesCents: 50000, ordersCount: 10 },
    ], weekends)).toBe(false);
  });
  it("does not count intermittent imported coverage as a complete item quantity window", () => {
    const monFri = { sat: [] as [string, string][], sun: [] as [string, string][] };
    expect(hasUncoveredPlanOperatingDates([
      { date: "2026-10-12" }, { date: "2026-10-13" }, { date: "2026-10-15" },
    ], monFri)).toBe(true); // Wednesday should have been covered
    expect(hasUncoveredPlanOperatingDates([
      { date: "2026-10-09" }, { date: "2026-10-12" },
    ], monFri)).toBe(false); // weekend closure is not missing data
    expect(coveredPlanOperatingDays([
      { date: "2026-10-09" }, { date: "2026-10-10" }, { date: "2026-10-12" },
    ], monFri)).toBe(2);
    // The POS item-quantity RPC ends at today, even if yesterday was the last
    // confirmed rollup. A missing current open day must not be invisible.
    expect(hasUncoveredPlanOperatingDates([{ date: "2026-10-12" }],
      monFri, "2026-10-13")).toBe(true);
    expect(hasUncoveredPlanOperatingDates([{ date: "2026-10-09" }],
      monFri, "2026-10-11")).toBe(false);
  });
  it("uses the same café operating-day rule as Money for staff changes", () => {
    // October 2026 has 22 Monday-to-Friday operating days.
    const monthDays = countPlanOperatingDays({ sat: [], sun: [] }, "2026-10");
    expect(monthDays).toBe(22);
    expect(countPlanOperatingDays(null, "2026-10")).toBe(31);
    expect(countPlanOperatingDays({ sat: [], sun: [], fri: [] }, "2026-10")).toBe(17);
    const staff = simulatePlanChange({ base: { ...base, daysInMonth: 31, monthKey: "2026-10",
        openHours: { sat: [], sun: [] }, operatingDaysInMonth: monthDays },
      type: "staff", item: null, newValueCents: 0, staffHoursPerDay: 3, assumedHourlyWageCents: 1950 });
    const dailySaving = Math.round(3 * 1950 * 1.12);
    expect(staff?.monthlyProfitChangeCents).toBe(dailySaving * monthDays);
    expect(staff?.monthlyProfitChangeCents).not.toBe(dailySaving * 31);
    expect(staff?.breakEvenChangeCents).toBeLessThan(0);
  });
  it("does not invent an effect for a café closed all month and flags incomplete hours", () => {
    expect(hasCompletePlanHours(null)).toBe(false);
    expect(hasCompletePlanHours({ sun: [] })).toBe(false);
    expect(hasCompletePlanHours({
      sun: [], mon: [["07:00", "15:00"]], tue: [["07:00", "15:00"]],
      wed: [["07:00", "15:00"]], thu: [["07:00", "15:00"]],
      fri: [["07:00", "15:00"]], sat: [],
    })).toBe(true);
    const unavailable = simulatePlanChange({ base: { ...base, operatingDaysInMonth: 0 },
      type: "price", item, newValueCents: 525, staffHoursPerDay: 0,
      assumedHourlyWageCents: 1950 });
    expect(unavailable).toBeNull();
  });
  it("never claims 2–5 PM staffing savings on morning-only shifts", () => {
    const morning = { mon: [["06:00", "12:00"]] as [string,string][], tue: [["06:00", "12:00"]] as [string,string][],
      wed: [["06:00", "12:00"]] as [string,string][], thu: [["06:00", "12:00"]] as [string,string][],
      fri: [["06:00", "12:00"]] as [string,string][], sat: [] as [string,string][], sun: [] as [string,string][] };
    expect(monthlyReducibleStaffHours({ monthKey: "2026-10", openHours: morning, hoursPerOpenDay: 3, afternoonOnly: true })).toBe(0);
    const noSavings = simulatePlanChange({ base: { ...base, daysInMonth: 31, monthKey: "2026-10",
      openHours: morning, operatingDaysInMonth: 22 },
      type: "staff", item: null, newValueCents: 0, staffHoursPerDay: 3,
      staffAfternoonOnly: true, assumedHourlyWageCents: 1950 });
    expect(noSavings?.monthlyProfitChangeCents).toBe(0);
    const afternoon = { ...morning, fri: [["15:00", "16:00"]] as [string,string][] };
    // October 2026 has five Fridays, just one eligible hour each.
    expect(monthlyReducibleStaffHours({ monthKey: "2026-10", openHours: afternoon, hoursPerOpenDay: 3, afternoonOnly: true })).toBe(5);
    expect(monthlyReducibleStaffHours({ monthKey: "2026-10", openHours: morning, hoursPerOpenDay: 12 })).toBe(132);
  });
  it("rounds partial-hour loaded staff costs once at the month total", () => {
    const fractional = simulatePlanChange({
      base: { ...base, daysInMonth: 31, monthKey: "2026-10",
        openHours: { sat: [], sun: [] }, operatingDaysInMonth: 22, payrollTaxRate: 0.123 },
      type: "staff", item: null, newValueCents: 0, staffHoursPerDay: 0.5,
      assumedHourlyWageCents: 1999,
    });
    expect(fractional?.monthlyProfitChangeCents).toBe(
      Math.round(0.5 * 1999 * 1.123 * 22),
    );
  });
  it("does not project profit for too little observed sales coverage", () => {
    expect(simulatePlanChange({ base: { ...base, salesDaysCovered: 0 },
      type: "price", item, newValueCents: 525, staffHoursPerDay: 0,
      assumedHourlyWageCents: 1950 })).toBeNull();
  });
  it("excludes archived sales items from future-price presets", () => {
    const same = simulatePlanChange({ base, type: "price", item: null, newValueCents: 25,
      preset: "allPrices", items: [{ ...item, category: "drink", active: true },
        { ...item, id: "old", category: "drink", active: false, quantitySoldLast28Days: 900 }],
      staffHoursPerDay: 0, assumedHourlyWageCents: 1950 });
    expect(same?.monthlyProfitChangeCents).toBe(Math.round(25 * 100 * 30 / 28));
  });
  it("does not claim staff-hour savings without any recorded staff cost", () => {
    expect(simulatePlanChange({ base: { ...base, monthlyStaffCents: 0 },
      type: "staff", item: null, newValueCents: 0,
      staffHoursPerDay: 3, assumedHourlyWageCents: 1950 })).toBeNull();
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
