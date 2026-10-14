import { describe, expect, it } from "vitest";
import {
  compensationProvenance,
  effectiveAvailabilityForDate,
  normalizeSchedulingWallTime,
  satisfiesLocalDayHoursCaps,
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
  it("accepts exact-minute PostgreSQL HH:mm:ss and zero-fraction wall times", () => {
    for (const [input, expected] of [
      ["07:00", "07:00"], ["07:00:00", "07:00"],
      ["07:00:00.000000", "07:00"], ["23:59:00", "23:59"],
    ]) expect(normalizeSchedulingWallTime(input)).toBe(expected);
    for (const invalid of ["07:00:01", "07:00:00.000001", "24:00:00",
      "07:60:00", "7:00:00", "07:00:01.0", "07:00:00+00"]) {
      expect(() => normalizeSchedulingWallTime(invalid)).toThrow();
    }
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00:00", "02:00:00"), overnight: true }],
      exceptions: [exception("2026-10-15", "unavailable", "00:00:00", "01:00:00")],
    }).windows).toEqual([
      { start: 1320, end: 1440 }, { start: 1500, end: 1560 },
    ]);
  });

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

  it("excludes Thursday 00:00–01:00 from Wednesday 22:00–Thursday 02:00", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [exception("2026-10-15", "unavailable", "00:00", "01:00")],
    });
    expect(result.windows).toEqual([{ start: 1320, end: 1440 }, { start: 1500, end: 1560 }]);
  });

  it("next-day full leave or unavailable removes only the after-midnight spillover", () => {
    for (const kind of ["approved_leave", "unavailable"] as const) {
      expect(effectiveAvailabilityForDate({
        date: "2026-10-14",
        recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
        exceptions: [exception("2026-10-15", kind)],
      }).windows).toEqual([{ start: 1320, end: 1440 }]);
    }
  });

  it("honors both nights' exceptions for split overnight blocks without merging gaps", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [
        recurring(3, "20:00", "22:00"),
        { ...recurring(3, "23:00", "01:30"), overnight: true },
      ],
      exceptions: [
        exception("2026-10-14", "unavailable", "23:30", "23:45"),
        exception("2026-10-15", "unavailable", "00:30", "01:00"),
      ],
    }).windows).toEqual([
      { start: 1200, end: 1320 },
      { start: 1380, end: 1410 },
      { start: 1425, end: 1470 },
      { start: 1500, end: 1530 },
    ]);
  });

  it("next-day hard avoidance blocks after midnight, soft avoidance does not", () => {
    const base = {
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [],
    };
    const restriction = {
      ...recurring(4, "00:00", "01:00"), preference: "avoid" as const,
      strength: "hard" as const,
    };
    expect(effectiveAvailabilityForDate({
      ...base, restrictions: [restriction],
    }).windows).toEqual([{ start: 1320, end: 1440 }, { start: 1500, end: 1560 }]);
    expect(effectiveAvailabilityForDate({
      ...base, restrictions: [{ ...restriction, strength: "soft" }],
    }).windows).toEqual([{ start: 1320, end: 1560 }]);
  });

  it("next-day replacement only permits the explicitly replaced local windows", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [exception("2026-10-15", "replace_day", "00:30", "01:30")],
    }).windows).toEqual([{ start: 1320, end: 1440 }, { start: 1470, end: 1530 }]);
  });

  it("preserves midnight and interval-end boundaries and ignores unconfirmed closures", () => {
    const run = (end: string, exceptions: AvailabilityException[]) =>
      effectiveAvailabilityForDate({
        date: "2026-10-14",
        recurring: [{ ...recurring(3, "22:00", end), overnight: true }],
        exceptions,
      }).windows;
    expect(run("00:00", [exception("2026-10-15", "unavailable", "00:00", "01:00")]))
      .toEqual([{ start: 1320, end: 1440 }]);
    expect(run("01:00", [exception("2026-10-15", "unavailable", "01:00", "02:00")]))
      .toEqual([{ start: 1320, end: 1500 }]);
    expect(run("02:00", [{ ...exception("2026-10-15", "approved_leave"), confirmation: "unconfirmed" }]))
      .toEqual([{ start: 1320, end: 1560 }]);
    expect(run("02:00", [{ ...exception("2026-10-15", "hours_cap"), max_minutes: 0 }]))
      .toEqual([{ start: 1320, end: 1440 }]);
  });

  it("looks across year boundaries using the following calendar date", () => {
    expect(effectiveAvailabilityForDate({
      date: "2026-12-31",
      recurring: [{ ...recurring(4, "23:00", "02:00"), overnight: true }],
      exceptions: [exception("2027-01-01", "unavailable", "00:30", "01:30")],
    }).windows).toEqual([
      { start: 1380, end: 1470 }, { start: 1530, end: 1560 },
    ]);
  });

  it("carries a positive Thursday 60-minute cap without inventing permitted time slots", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [{ ...exception("2026-10-15", "hours_cap"), max_minutes: 60 }],
    });
    // All two Thursday hours remain candidate availability; planner must
    // enforce the cumulative sixty-minute hard cap on LOCAL Thursday.
    expect(result).toMatchObject({
      windows: [{ start: 1320, end: 1560 }],
      maxMinutes: null,
      dailyHourCaps: [{ localDate: "2026-10-15", maxMinutes: 60 }],
    });
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-14", minutes: 120 },
      { localDate: "2026-10-15", minutes: 60 },
    ], result.dailyHourCaps)).toBe(true);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-15", minutes: 61 },
    ], result.dailyHourCaps)).toBe(false);
  });

  it("enforces the Thursday cap across overnight spillover and other split shifts", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [
        recurring(3, "18:00", "20:00"),
        { ...recurring(3, "22:00", "02:00"), overnight: true },
      ],
      exceptions: [
        { ...exception("2026-10-14", "hours_cap"), max_minutes: 180 },
        { ...exception("2026-10-15", "hours_cap"), max_minutes: 60 },
      ],
    });
    expect(result.windows).toEqual([
      { start: 1080, end: 1200 }, { start: 1320, end: 1560 },
    ]);
    expect(result.maxMinutes).toBe(180);
    expect(result.dailyHourCaps).toEqual([
      { localDate: "2026-10-14", maxMinutes: 180 },
      { localDate: "2026-10-15", maxMinutes: 60 },
    ]);
    // A second, Thursday-starting shift also consumes Thursday's SAME cap.
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-15", minutes: 35 },
      { localDate: "2026-10-15", minutes: 25 },
    ], result.dailyHourCaps)).toBe(true);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-15", minutes: 35 },
      { localDate: "2026-10-15", minutes: 26 },
    ], result.dailyHourCaps)).toBe(false);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-14", minutes: 181 },
    ], result.dailyHourCaps)).toBe(false);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-14", minutes: -1 },
    ], result.dailyHourCaps)).toBe(false);
  });

  it("zero-minute next-day cap rejects all work and masks only that day", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [{ ...exception("2026-10-15", "hours_cap"), max_minutes: 0 }],
    });
    expect(result.windows).toEqual([{ start: 1320, end: 1440 }]);
    expect(result.dailyHourCaps).toEqual([{ localDate: "2026-10-15", maxMinutes: 0 }]);
    expect(satisfiesLocalDayHoursCaps([], result.dailyHourCaps)).toBe(true);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-15", minutes: 1 },
    ], result.dailyHourCaps)).toBe(false);
  });

  it("does not confuse a next-day positive cap with a leave or partial block", () => {
    const base = { date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "03:00"), overnight: true }] };
    const positiveCap = { ...exception("2026-10-15", "hours_cap"), max_minutes: 60 };
    const partial = effectiveAvailabilityForDate({
      ...base,
      exceptions: [
        positiveCap,
        exception("2026-10-15", "unavailable", "00:30", "01:30"),
      ],
    });
    expect(partial.windows).toEqual([
      { start: 1320, end: 1470 }, { start: 1530, end: 1620 },
    ]);
    expect(partial.dailyHourCaps).toEqual([{ localDate: "2026-10-15", maxMinutes: 60 }]);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2026-10-15", minutes: 90 },
    ], partial.dailyHourCaps)).toBe(false);
    const onLeave = effectiveAvailabilityForDate({
      ...base,
      exceptions: [positiveCap, exception("2026-10-15", "approved_leave")],
    });
    expect(onLeave.windows).toEqual([{ start: 1320, end: 1440 }]);
    expect(onLeave.dailyHourCaps).toEqual([{ localDate: "2026-10-15", maxMinutes: 60 }]);
  });

  it("aggregates multiple confirmed caps by minimum, ignores unconfirmed caps", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [
        { ...exception("2026-10-15", "hours_cap"), max_minutes: 180 },
        { ...exception("2026-10-15", "hours_cap"), max_minutes: 60 },
        { ...exception("2026-10-15", "hours_cap"), max_minutes: 0, confirmation: "unconfirmed" },
      ],
    });
    expect(result.windows).toEqual([{ start: 1320, end: 1560 }]);
    expect(result.dailyHourCaps).toEqual([{ localDate: "2026-10-15", maxMinutes: 60 }]);
  });

  it("preserves next-year local-date caps across New Year's midnight", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-12-31",
      recurring: [{ ...recurring(4, "23:00", "02:00"), overnight: true }],
      exceptions: [{ ...exception("2027-01-01", "hours_cap"), max_minutes: 45 }],
    });
    expect(result.windows).toEqual([{ start: 1380, end: 1560 }]);
    expect(result.dailyHourCaps).toEqual([{ localDate: "2027-01-01", maxMinutes: 45 }]);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2027-01-01", minutes: 25 },
      { localDate: "2027-01-01", minutes: 20 },
    ], result.dailyHourCaps)).toBe(true);
    expect(satisfiesLocalDayHoursCaps([
      { localDate: "2027-01-01", minutes: 46 },
    ], result.dailyHourCaps)).toBe(false);
  });

  it("a zero cap on the starting date cannot arbitrarily close the following date", () => {
    const result = effectiveAvailabilityForDate({
      date: "2026-10-14",
      recurring: [{ ...recurring(3, "22:00", "02:00"), overnight: true }],
      exceptions: [{ ...exception("2026-10-14", "hours_cap"), max_minutes: 0 }],
    });
    expect(result.windows).toEqual([{ start: 1440, end: 1560 }]);
    expect(result.maxMinutes).toBe(0);
    expect(result.dailyHourCaps).toEqual([{ localDate: "2026-10-14", maxMinutes: 0 }]);
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

  const wages = (wage_period: string | null, wage_amount_cents: number | null,
    default_hourly_wage_cents: number | null) =>
    ({ wage_period, wage_amount_cents, default_hourly_wage_cents });

  it("preserves explicit verified zero but never infers free labor from missing provenance", () => {
    expect(compensationProvenance(null, wages("hour", null, null))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "unknown" }, wages("hour", 0, 0))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, wages("hour", null, null)))
      .toBe("known_eligible_zero");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, null)).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" }, wages("hour", 1800, 1800)))
      .toBe("unknown");
  });

  it("revalidates ALL four states against canonical Staff wage updates", () => {
    const cases: {
      state: "known_paid" | "salary_conversion_pending" | "known_eligible_zero" | "unknown";
      period: string;
      amount: number | null;
      hourly: number | null;
      expected: string;
    }[] = [
      { state: "known_paid", period: "hour", amount: 1800, hourly: 1800, expected: "known_paid" },
      { state: "known_paid", period: "hour", amount: 0, hourly: 0, expected: "unknown" },
      { state: "known_paid", period: "month", amount: 200000, hourly: 0, expected: "unknown" },
      { state: "known_paid", period: "month", amount: 200000, hourly: 2400, expected: "known_paid" },
      { state: "salary_conversion_pending", period: "month", amount: 200000, hourly: 0, expected: "salary_conversion_pending" },
      { state: "salary_conversion_pending", period: "year", amount: 2400000, hourly: 0, expected: "salary_conversion_pending" },
      { state: "salary_conversion_pending", period: "hour", amount: 1800, hourly: 1800, expected: "unknown" },
      { state: "salary_conversion_pending", period: "month", amount: 200000, hourly: 2400, expected: "unknown" },
      { state: "known_eligible_zero", period: "hour", amount: 0, hourly: 0, expected: "known_eligible_zero" },
      { state: "known_eligible_zero", period: "hour", amount: 1800, hourly: 1800, expected: "unknown" },
      { state: "known_eligible_zero", period: "month", amount: 200000, hourly: 0, expected: "unknown" },
      { state: "unknown", period: "hour", amount: 1800, hourly: 1800, expected: "unknown" },
      { state: "unknown", period: "month", amount: 200000, hourly: 0, expected: "unknown" },
    ];
    for (const row of cases) {
      expect(compensationProvenance(
        { cash_cost_state: row.state },
        wages(row.period, row.amount, row.hourly),
      )).toBe(row.expected);
    }
    expect(compensationProvenance({ cash_cost_state: "known_paid" }, null)).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" }, null)).toBe("unknown");
  });


  it("accepts null or zero recorded cents only with explicit known-eligible-zero evidence", () => {
    for (const [amount, hourly] of [
      [null, null], [0, 0], [null, 0], [0, null],
    ] as const) {
      expect(compensationProvenance(
        { cash_cost_state: "known_eligible_zero" }, wages("hour", amount, hourly),
      )).toBe("known_eligible_zero");
      expect(compensationProvenance(null, wages("hour", amount, hourly))).toBe("unknown");
      expect(compensationProvenance(
        { cash_cost_state: "known_paid" }, wages("hour", amount, hourly),
      )).toBe("unknown");
    }
  });

  it("fails closed when EITHER wage column becomes negative (including Staff import updates)", () => {
    for (const [amount, hourly] of [
      [-1, 0], [0, -1], [-100, null], [null, -100],
      [-1, -1], [-100, 1800], [1800, -100],
    ] as const) {
      for (const state of [
        "known_eligible_zero", "known_paid", "salary_conversion_pending",
      ] as const) {
        expect(compensationProvenance(
          { cash_cost_state: state }, wages("hour", amount, hourly),
        )).toBe("unknown");
      }
    }
    expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" },
      wages("month", 210000, -1))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "known_paid" },
      wages("year", 2300000, -1))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "unknown" },
      wages("hour", -1, -1))).toBe("unknown");
  });

  it("rejects malformed runtime wages rather than coercing them into paid or verified-zero", () => {
    const invalidCents: unknown[] = [Number.NaN, Infinity, -Infinity, 0.5,
      1.5, Number.MAX_SAFE_INTEGER + 1, "0", "2000", undefined, {}, []];
    for (const bad of invalidCents) {
      const malformed = bad as number;
      expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" },
        wages("hour", malformed, 0))).toBe("unknown");
      expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" },
        wages("hour", 0, malformed))).toBe("unknown");
      expect(compensationProvenance({ cash_cost_state: "known_paid" },
        wages("hour", 1800, malformed))).toBe("unknown");
      expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" },
        wages("month", 200000, malformed))).toBe("unknown");
    }
    for (const period of [null, "weekly", "", "Hour", "DAY"]) {
      expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" },
        wages(period, 0, 0))).toBe("unknown");
      expect(compensationProvenance({ cash_cost_state: "known_paid" },
        wages(period, 1800, 1800))).toBe("unknown");
    }
    expect(compensationProvenance(
      { cash_cost_state: "invalid-state" as "known_paid" }, wages("hour", 1800, 1800),
    )).toBe("unknown");
  });

  it("keeps valid salary-pending, paid and unknown states separate", () => {
    expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" },
      wages("month", 200000, null))).toBe("salary_conversion_pending");
    expect(compensationProvenance({ cash_cost_state: "known_paid" },
      wages("hour", 1800, 0))).toBe("known_paid");
    expect(compensationProvenance({ cash_cost_state: "known_paid" },
      wages("year", 2400000, 2500))).toBe("known_paid");
    expect(compensationProvenance({ cash_cost_state: "salary_conversion_pending" },
      wages("year", 2400000, 2500))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "known_eligible_zero" },
      wages("month", 200000, null))).toBe("unknown");
    expect(compensationProvenance({ cash_cost_state: "unknown" },
      wages("hour", 1800, 1800))).toBe("unknown");
  });
});
