import { describe, expect, it } from "vitest";
import { isOverstaffedSlot, mealBreakStatus, missingBillAlert, voidsAlert } from "./alerts";

describe("missingBillAlert", () => {
  it("fires when a category had a recurring bill but nothing this month", () => {
    expect(missingBillAlert({ hasRecurring: true, hadActualLastMonth: false, isMissingThisMonth: true })).toBe(true);
  });
  it("does not fire when the category has no history at all", () => {
    expect(missingBillAlert({ hasRecurring: false, hadActualLastMonth: false, isMissingThisMonth: true })).toBe(false);
  });
  it("does not fire once an estimate or actual exists this month", () => {
    expect(missingBillAlert({ hasRecurring: true, hadActualLastMonth: true, isMissingThisMonth: false })).toBe(false);
  });
});

describe("voidsAlert", () => {
  it("fires only above both the 2x-average and $100 thresholds", () => {
    expect(voidsAlert(25_000, 10_000)).toBe(true); // >2x and >$100
    expect(voidsAlert(15_000, 10_000)).toBe(false); // not >2x
    expect(voidsAlert(21_000, 1_000)).toBe(true); // >2x but must also clear $100 — 21,000 > 10,000 ✓
    expect(voidsAlert(2_500, 1_000)).toBe(false); // >2x but under $100
  });
});

describe("mealBreakStatus", () => {
  it("does not warn two hours into a 6:00 shift", () => {
    expect(mealBreakStatus({ clockIn: "2026-09-01T13:00:00Z", clockOut: null, hourlyWageCents: 2_000, breaks: [] }, new Date("2026-09-01T15:00:00Z"))).toMatchObject({ warn: false, missed: false });
  });
  it("warns at 4h30 with no break taken", () => {
    const timecard = { clockIn: "2026-09-01T13:00:00Z", clockOut: null, hourlyWageCents: 2_000, breaks: [] };
    const status = mealBreakStatus(timecard, new Date("2026-09-01T17:30:00Z"));
    expect(status.warn).toBe(true);
    expect(status.missed).toBe(false);
  });

  it("flags a missed break past 5h with a 1-hour wage penalty", () => {
    const timecard = { clockIn: "2026-09-01T13:00:00Z", clockOut: "2026-09-01T21:00:00Z", hourlyWageCents: 2_000, breaks: [] };
    const status = mealBreakStatus(timecard);
    expect(status.missed).toBe(true);
    expect(status.penaltyCents).toBe(2_000);
  });

  it("does not call a schedule-generated prediction a real missed break", () => {
    const status = mealBreakStatus({ clockIn: "2026-09-01T13:00:00Z", clockOut: "2026-09-01T21:00:00Z", hourlyWageCents: 2_000, breaks: [], scheduleId: "schedule-1", sourceType: "owner_schedule" });
    expect(status).toMatchObject({ warn: false, missed: false, penaltyCents: 0 });
  });

  it("treats a POS-confirmed row as actual even when it retains its schedule baseline", () => {
    const status = mealBreakStatus({ clockIn: "2026-09-01T13:00:00Z", clockOut: "2026-09-01T21:00:00Z", hourlyWageCents: 2_000, breaks: [], scheduleId: "schedule-1", sourceType: "connected_pos", sourceProvider: "square" });
    expect(status).toMatchObject({ warn: true, missed: true, penaltyCents: 2_000 });
  });

  it("is timezone-safe across an offset change because elapsed time uses instants", () => {
    const status = mealBreakStatus({ clockIn: "2026-11-01T06:00:00-07:00", clockOut: null, hourlyWageCents: 2_000, breaks: [] }, new Date("2026-11-01T10:30:00-08:00"));
    expect(status).toMatchObject({ warn: true, missed: true });
    expect(status.shiftHours).toBe(5.5);
  });

  it("does not flag a shift with a break that started before the end of hour 5", () => {
    const timecard = {
      clockIn: "2026-09-01T13:00:00Z",
      clockOut: "2026-09-01T21:00:00Z",
      hourlyWageCents: 2_000,
      breaks: [{ start: "2026-09-01T17:30:00Z", end: "2026-09-01T18:00:00Z", paid: false }],
    };
    expect(mealBreakStatus(timecard).missed).toBe(false);
  });
});

describe("isOverstaffedSlot", () => {
  it("flags an hour-of-week over 45% staff-to-sales on 3+ of the last 4 weeks", () => {
    expect(isOverstaffedSlot([0.5, 0.46, 0.2, 0.48])).toBe(true);
    expect(isOverstaffedSlot([0.5, 0.46, 0.2, 0.2])).toBe(false);
  });
});
