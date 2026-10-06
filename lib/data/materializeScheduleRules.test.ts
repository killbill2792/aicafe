import { describe, expect, it } from "vitest";
import {
  localDatesInclusive,
  selectSchedulesForDate,
  type StaffScheduleMaterializationRow,
} from "./materializeScheduleRules";

function schedule(overrides: Partial<StaffScheduleMaterializationRow>): StaffScheduleMaterializationRow {
  return {
    id: "schedule-a",
    employee_id: "employee-a",
    day_of_week: 6,
    start_time: "08:00",
    end_time: "16:00",
    unpaid_break_minutes: 30,
    hourly_wage_cents: 2000,
    effective_from: "1970-01-01",
    effective_to: null,
    ...overrides,
  };
}

describe("schedule materialization dates", () => {
  it("includes Saturdays and Sundays exactly like weekdays", () => {
    expect(localDatesInclusive("2026-10-01", "2026-10-05")).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
  });
});

describe("selectSchedulesForDate", () => {
  it("selects a Saturday ongoing schedule", () => {
    expect(selectSchedulesForDate([schedule({})], "2026-10-03")).toHaveLength(1);
  });

  it("selects a Sunday schedule without any weekend special case", () => {
    const sunday = schedule({ id: "sun", day_of_week: 0 });
    expect(selectSchedulesForDate([sunday], "2026-10-04")[0]?.id).toBe("sun");
  });

  it("prefers a month-specific override over an ongoing schedule", () => {
    const ongoing = schedule({ id: "ongoing" });
    const october = schedule({
      id: "october",
      start_time: "09:00",
      effective_from: "2026-10-01",
      effective_to: "2026-10-31",
    });
    expect(selectSchedulesForDate([ongoing, october], "2026-10-03")[0]?.id).toBe("october");
  });

  it("does not use an expired month-specific schedule", () => {
    const september = schedule({
      id: "september",
      effective_from: "2026-09-01",
      effective_to: "2026-09-30",
    });
    expect(selectSchedulesForDate([september], "2026-10-03")).toEqual([]);
  });

  it("returns only one schedule per employee/day even if duplicate candidates overlap", () => {
    const first = schedule({ id: "a" });
    const second = schedule({ id: "b", effective_from: "2026-01-01" });
    expect(selectSchedulesForDate([first, second], "2026-10-03")).toHaveLength(1);
  });
});
