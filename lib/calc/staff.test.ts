import { describe, expect, it } from "vitest";
import { hourlyWageCentsFromSalary, paidHoursForTimecard, payrollTaxCents, wagesCentsForTimecard, weeklyScheduledHours } from "./staff";

describe("staff", () => {
  it("counts paid hours across an unpaid break, and pays for a paid break", () => {
    const timecard = {
      clockIn: "2026-09-01T13:00:00Z", // 8h shift, 30-min unpaid break
      clockOut: "2026-09-01T21:30:00Z",
      hourlyWageCents: 2_000,
      breaks: [{ start: "2026-09-01T17:00:00Z", end: "2026-09-01T17:30:00Z", paid: false }],
    };
    expect(paidHoursForTimecard(timecard)).toBeCloseTo(8, 6);
    expect(wagesCentsForTimecard(timecard)).toBeCloseTo(16_000, 6);
  });

  it("an open shift counts paid hours up to `now`", () => {
    const timecard = {
      clockIn: "2026-09-01T13:00:00Z",
      clockOut: null,
      hourlyWageCents: 2_000,
      breaks: [],
    };
    const now = new Date("2026-09-01T15:00:00Z");
    expect(paidHoursForTimecard(timecard, now)).toBeCloseTo(2, 6);
  });

  it("a future clock-out (a scheduled shift still in progress) only counts hours up to `now`", () => {
    const timecard = {
      clockIn: "2026-09-01T13:00:00Z", // scheduled 13:00-21:00, but it's only 15:00 now
      clockOut: "2026-09-01T21:00:00Z",
      hourlyWageCents: 2_000,
      breaks: [],
    };
    const now = new Date("2026-09-01T15:00:00Z");
    expect(paidHoursForTimecard(timecard, now)).toBeCloseTo(2, 6);
    expect(wagesCentsForTimecard(timecard, now)).toBeCloseTo(4_000, 6);
  });

  it("payroll taxes are wages × the business's payroll tax rate", () => {
    expect(payrollTaxCents(69_600, 0.12)).toBeCloseTo(8_352, 6);
  });

  it("weeklyScheduledHours sums each day's hours minus its unpaid break", () => {
    const days = [
      { startTime: "08:00", endTime: "16:00", unpaidBreakMinutes: 30 }, // 7.5h
      { startTime: "09:00", endTime: "13:00", unpaidBreakMinutes: 0 }, // 4h
    ];
    expect(weeklyScheduledHours(days)).toBeCloseTo(11.5, 6);
  });

  it("hourlyWageCentsFromSalary passes an hourly wage through unchanged", () => {
    expect(hourlyWageCentsFromSalary(2_500, "hour", 40)).toBe(2_500);
  });

  it("hourlyWageCentsFromSalary converts a yearly salary using hours/week × 52", () => {
    // $52,000/year at 40 hrs/week = $25.00/hr
    expect(hourlyWageCentsFromSalary(5_200_000, "year", 40)).toBe(2_500);
  });

  it("hourlyWageCentsFromSalary converts a monthly salary the same way, ×12", () => {
    // $4,000/month at 40 hrs/week = $48,000/year ÷ 2,080 hrs = $23.08/hr (rounded)
    expect(hourlyWageCentsFromSalary(400_000, "month", 40)).toBe(2_308);
  });

  it("hourlyWageCentsFromSalary returns 0 for a salaried period with no hours to divide by", () => {
    expect(hourlyWageCentsFromSalary(5_200_000, "year", 0)).toBe(0);
  });

  it("weeklyScheduledHours treats an end time on/before the start time as crossing midnight", () => {
    const days = [{ startTime: "18:00", endTime: "01:00", unpaidBreakMinutes: 0 }]; // closing shift, 7h
    expect(weeklyScheduledHours(days)).toBeCloseTo(7, 6);
  });
});
