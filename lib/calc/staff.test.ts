import { describe, expect, it } from "vitest";
import { paidHoursForTimecard, payrollTaxCents, wagesCentsForTimecard } from "./staff";

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

  it("payroll taxes are wages × the business's payroll tax rate", () => {
    expect(payrollTaxCents(69_600, 0.12)).toBeCloseTo(8_352, 6);
  });
});
