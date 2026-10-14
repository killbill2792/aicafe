// PR 1A pure effective availability projection: no DB, dates in local
// calendar notation and windows in local wall-clock minutes. DST instant
// validation and any labor optimizer are deliberately deferred to PR 2.
export type SchedulingWindow = {
  start_local: string;
  end_local: string;
  overnight: boolean;
};

export type RecurringAvailability = SchedulingWindow & {
  day_of_week: number;
  effective_from: string;
  effective_to?: string | null;
  confirmation: "unconfirmed" | "owner_confirmed";
};

export type AvailabilityException = {
  local_date: string;
  exception_type: "unavailable" | "approved_leave" | "replace_day" | "add_available" | "hours_cap";
  start_local?: string | null;
  end_local?: string | null;
  overnight?: boolean;
  max_minutes?: number | null;
  confirmation: "unconfirmed" | "owner_confirmed";
};

export type PreferenceWindow = SchedulingWindow & {
  day_of_week: number;
  preference: "prefer" | "avoid";
  strength: "soft" | "hard";
  effective_from: string;
  effective_to?: string | null;
  confirmation: "unconfirmed" | "owner_confirmed";
};

export type MinuteWindow = { start: number; end: number };

function minutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Invalid HH:mm");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function asWindow(value: SchedulingWindow): MinuteWindow {
  const start = minutes(value.start_local);
  const end = minutes(value.end_local) + (value.overnight ? 1440 : 0);
  if (end <= start || end > 2880) throw new Error("Invalid availability window");
  return { start, end };
}

function activeOnDate(date: string, row: { effective_from: string; effective_to?: string | null }) {
  return date >= row.effective_from && (!row.effective_to || date <= row.effective_to);
}

function mergeWindows(windows: MinuteWindow[]): MinuteWindow[] {
  const sorted = windows.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MinuteWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function subtractWindows(windows: MinuteWindow[], blocked: MinuteWindow[]): MinuteWindow[] {
  let current = mergeWindows(windows);
  for (const mask of mergeWindows(blocked)) {
    current = current.flatMap((w) => {
      if (mask.end <= w.start || mask.start >= w.end) return [w];
      const result: MinuteWindow[] = [];
      if (mask.start > w.start) result.push({ start: w.start, end: mask.start });
      if (mask.end < w.end) result.push({ start: mask.end, end: w.end });
      return result;
    });
  }
  return current;
}

export function effectiveAvailabilityForDate(input: {
  date: string;
  recurring: RecurringAvailability[];
  exceptions: AvailabilityException[];
  restrictions?: PreferenceWindow[];
}): { windows: MinuteWindow[]; maxMinutes: number | null; precedence: "closed" | "replaced" | "recurring" } {
  const day = new Date(input.date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== input.date) {
    throw new Error("Invalid local date");
  }
  const dayOfWeek = day.getUTCDay();
  const exceptions = input.exceptions.filter(
    (row) => row.confirmation === "owner_confirmed" && row.local_date === input.date,
  );
  const caps = exceptions.filter((row) => row.exception_type === "hours_cap" && row.max_minutes != null)
    .map((row) => row.max_minutes as number);
  const maxMinutes = caps.length ? Math.min(...caps) : null;
  const fullUnavailable = exceptions.some(
    (row) => (row.exception_type === "unavailable" && row.start_local == null) ||
      row.exception_type === "approved_leave",
  );
  if (fullUnavailable) return { windows: [], maxMinutes, precedence: "closed" };

  const replacements = exceptions.filter((row) => row.exception_type === "replace_day");
  const base = replacements.length
    ? replacements.map((row) => asWindow(row as SchedulingWindow))
    : input.recurring.filter(
      (row) => row.confirmation === "owner_confirmed" &&
        row.day_of_week === dayOfWeek && activeOnDate(input.date, row),
    ).map(asWindow);

  const adds = exceptions.filter((row) => row.exception_type === "add_available")
    .map((row) => asWindow(row as SchedulingWindow));
  const masks = exceptions.filter(
    (row) => row.exception_type === "unavailable" && row.start_local != null,
  ).map((row) => asWindow(row as SchedulingWindow));
  for (const row of input.restrictions ?? []) {
    if (row.confirmation === "owner_confirmed" &&
        row.strength === "hard" && row.preference === "avoid" &&
        row.day_of_week === dayOfWeek && activeOnDate(input.date, row)) masks.push(asWindow(row));
  }
  return {
    windows: subtractWindows([...base, ...adds], masks),
    maxMinutes,
    precedence: replacements.length ? "replaced" : "recurring",
  };
}

export type CompensationProvenance = "unknown" | "known_paid" | "salary_conversion_pending" | "known_eligible_zero";

export type EmployeeWageSnapshot = {
  wage_amount_cents: number | null;
  default_hourly_wage_cents: number | null;
};

/**
 * Fail-closed compensation provenance for scheduling projections. Even when a
 * stale attestation was written by an older importer or raced a wage change,
 * an employee with ANY recorded positive wage cannot be treated as zero cost.
 * Missing employee identity is unknown; missing wage rates require an explicit verified-zero attestation. The DB trigger
 * separately invalidates and audits the stored attestation transactionally.
 *
 * This is metadata validation, not a new payroll/wage calculation.
 */
export function compensationProvenance(
  recorded: { cash_cost_state: CompensationProvenance } | null,
  employee: EmployeeWageSnapshot | null,
): CompensationProvenance {
  if (!recorded) return "unknown";
  if (recorded.cash_cost_state === "known_eligible_zero") {
    // An explicit owner-attested zero is distinct from unknown wages: nullable
    // wage fields are allowed, but a missing employee snapshot or any positive
    // recorded amount invalidates using that attestation for planning.
    if (!employee ||
        (employee.wage_amount_cents ?? 0) > 0 ||
        (employee.default_hourly_wage_cents ?? 0) > 0) {
      return "unknown";
    }
  }
  return recorded.cash_cost_state;
}
