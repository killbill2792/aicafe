import { describe, expect, it } from "vitest";
import {
  compensationProvenance,
  effectiveAvailabilityForDate,
  type RecurringAvailability,
  type AvailabilityException,
} from "./availability";

const confirmed = "owner_confirmed" as const;
const recurring = (day_of_week: number, start_local: string, end_local: string): RecurringAvailability => ({
  day_of_week, start_local, end_local, overnight: false,
  effective_from: "2026-01-01", effective_to: null, confirmation: confirmed,
});
const exception = (
  local_date: string,
  exception_type: AvailabilityException["exception_type"],
  start_local?: string,
  end_local?: string,
): AvailabilityException => ({
  local_date, exception_type, start_local, end_local, overnight: false, confirmation: confirmed,
});

describe("Olivia PR 1A: pure effective availability", () => {
  it("supports multiple windows on the same weekday without filling the unavailable gap", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14", recurring: [
        recurring(3, "07:00", "11:00"), recurring(3, "16:00", "20:00"),
      ], exceptions: [],
    });
    expect(result.windows).toEqual([{ start: 420, end: 660 }, { start: 960, end: 1200 }]);
  });

  it("uses five separate Mon–Fri windows, not one continuous interval", () => {
    const days = [1, 2, 3, 4, 5].map((day) => recurring(day, "09:00", "17:00"));
    for (const date of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
      expect(effectiveAvailabilityForDate({ date, recurring: days, exceptions: [] }).windows)
        .toEqual([{ start: 540, end: 1020 }]);
    }
    expect(effectiveAvailabilityForDate({ date: "2026-10-17", recurring: days, exceptions: [] }).windows).toEqual([]);
  });

  it("date-specific replace_day supersedes only that Tuesday and can have multiple blocks", () => {
    const days = [recurring(2, "09:00", "17:00")];
    const exceptions = [
      exception("2026-10-13", "replace_day", "08:00", "10:00"),
      exception("2026-10-13", "replace_day", "11:00", "12:00"),
    ];
    expect(effectiveAvailabilityForDate({ date: "2026-10-13", recurring: days, exceptions }).windows)
      .toEqual([{ start: 480, end: 600 }, { start: 660, end: 720 }]);
    expect(effectiveAvailabilityForDate({ date: "2026-10-20", recurring: days, exceptions }).windows)
      .toEqual([{ start: 540, end: 1020 }]);
  });

  it("unavailable days and approved leave override any recurring or replacement blocks", () => {
    for (const absence of ["unavailable", "approved_leave"] as const) {
      expect(effectiveAvailabilityForDate({
        date: "2026-10-13", recurring: [recurring(2, "09:00", "17:00")],
        exceptions: [
          exception("2026-10-13", "replace_day", "08:00", "12:00"),
          exception("2026-10-13", absence),
        ],
      })).toMatchObject({ windows: [], precedence: "closed" });
    }
  });

  it("subtracts partial unavailability and hard restrictions without changing soft preferences", () => {
    const base = { date: "2026-10-14", recurring: [recurring(3, "07:00", "20:00")] };
    expect(effectiveAvailabilityForDate({
      ...base, exceptions: [exception("2026-10-14", "unavailable", "11:00", "16:00")],
      restrictions: [{
        ...recurring(3, "07:00", "09:00"), preference: "avoid", strength: "soft",
      }, {
        ...recurring(3, "18:00", "20:00"), preference: "avoid", strength: "hard",
      }],
    }).windows).toEqual([{ start: 420, end: 660 }, { start: 960, end: 1080 }]);
  });

  it("preserves the next-day boundary of a confirmed overnight window", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [],
    }).windows).toEqual([{ start: 1320, end: 1560 }]);
  });

  it("ignores unconfirmed owner-reported statements until the owner confirms them", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "09:00", "17:00"), confirmation: "unconfirmed" }],
      exceptions: [],
    }).windows).toEqual([]);
  });

  it("stores an independent date-level hard hours cap, including zero", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [recurring(3, "09:00", "17:00")],
      exceptions: [{ ...exception("2026-10-14", "hours_cap"), max_minutes: 240 }],
    })).toMatchObject({ windows: [{ start: 540, end: 1020 }], maxMinutes: 240 });
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14", recurring: [], exceptions: [
        { ...exception("2026-10-14", "hours_cap"), max_minutes: 0 },
      ],
    }).maxMinutes).toBe(0);
  });

  it("rejects invalid local dates and non-overnight reverse windows", () => {
    expect(() => effectiveAvailabilityForDate({
      date: "2026-02-30", recurring: [], exceptions: [],
    })).toThrow();
    expect(() => effectiveAvailabilityForDate({
      date: "2026-10-14", recurring: [recurring(3, "22:00", "02:00")], exceptions: [],
    })).toThrow();
  });

  it("never treats unknown or salary-pending wages as eligible zero", () => {
    const noWage = { wage_amount_cents: null, default_hourly_wage_cents: null };
    expect(compensationProvenance(null, noWage)).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "unknown" }, noWage)).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" }, {
      wage_amount_cents: 200000, default_hourly_wage_cents: 0,
    })).toBe("salary_conversion_pending");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, {
      wage_amount_cents: 0, default_hourly_wage_cents: 0,
    })).toBe("known_eligible_zero");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, null)).toBe("unknown");
    // Explicit attestation is valid with null legacy rate fields; unknown
    // employee identity is not. This preserves zero-versus-unknown provenance.
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, noWage))
      .toBe("known_eligible_zero");
  });

  it("fails closed after a zero-cost attestation if the Staff wage-update path records a positive wage", () => {
    const attestedZero = { cash_cost_state: "known_eligible_zero" } as const;
    const beforeStaffEdit = { wage_amount_cents: 0, default_hourly_wage_cents: 0 };
    const afterStaffHourlyEdit = { wage_amount_cents: 1800, default_hourly_wage_cents: 1800 };
    const afterStaffSalaryEdit = { wage_amount_cents: 200000, default_hourly_wage_cents: 0 };
    expect(compensationProvenance(attestedZero, beforeStaffEdit)).toBe("known_eligible_zero");
    expect(compensationProvenance(attestedZero, afterStaffHourlyEdit)).toBe("unknown");
    expect(compensationProvenance(attestedZero, afterStaffSalaryEdit)).toBe("unknown");
    // Checking the cached hourly amount is also required if the wage amount
    // is missing in a legacy employee row.
    expect(compensationProvenance(attestedZero, {
      wage_amount_cents: null, default_hourly_wage_cents: 1800,
    })).toBe("unknown");
  });
});
