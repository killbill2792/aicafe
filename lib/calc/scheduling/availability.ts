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

/** Hard total scheduled-minutes restriction for the specified LOCAL calendar day.
 * This is not an availability window: a positive cap must NEVER decide which
 * otherwise-available minutes are eligible. The planner must aggregate every
 * assigned shift portion on this date, including overnight spillovers.
 */
export type LocalDayHoursCap = { localDate: string; maxMinutes: number };

/**
 * Pure planner-facing hard cap check. Call with ALL scheduled shift portions
 * grouped by the calendar date where each minute is actually worked, not by
 * shift start date. Split shifts and overnight portions count toward the same
 * day cap. This does not select, trim or optimize scheduling windows.
 */
export function satisfiesLocalDayHoursCaps(
  portions: readonly { localDate: string; minutes: number }[],
  caps: readonly LocalDayHoursCap[],
): boolean {
  const totals = new Map<string, number>();
  for (const portion of portions) {
    if (!Number.isSafeInteger(portion.minutes) || portion.minutes < 0) return false;
    totals.set(portion.localDate, (totals.get(portion.localDate) ?? 0) + portion.minutes);
  }
  return caps.every(
    (cap) => Number.isSafeInteger(cap.maxMinutes) && cap.maxMinutes >= 0 &&
      (totals.get(cap.localDate) ?? 0) <= cap.maxMinutes,
  );
}

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
}): {
  windows: MinuteWindow[];
  /** Starting date's hard cap, retained for existing callers. */
  maxMinutes: number | null;
  /** Explicit per-local-day limits for this day AND overnight spillover date. */
  dailyHourCaps: LocalDayHoursCap[];
  precedence: "closed" | "replaced" | "recurring";
} {
  const day = new Date(input.date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== input.date) {
    throw new Error("Invalid local date");
  }
  // Compute NEXT LOCAL CALENDAR DATE rather than advancing any business
  // timezone instant. DST instants are explicitly deferred to PR 2.
  const nextDay = new Date(day.getTime() + 86_400_000);
  const nextDate = nextDay.toISOString().slice(0, 10);
  const confirmedFor = (localDate: string) => input.exceptions.filter(
    (row) => row.confirmation === "owner_confirmed" && row.local_date === localDate,
  );
  const hardCapFor = (rows: AvailabilityException[]): number | null => {
    const caps = rows.filter((row) => row.exception_type === "hours_cap" && row.max_minutes != null)
      .map((row) => row.max_minutes as number);
    return caps.length ? Math.min(...caps) : null;
  };
  const dayOfWeek = day.getUTCDay();
  const exceptions = confirmedFor(input.date);
  const following = confirmedFor(nextDate);
  const maxMinutes = hardCapFor(exceptions);
  const nextDayMaxMinutes = hardCapFor(following);
  const dailyHourCaps: LocalDayHoursCap[] = [
    ...(maxMinutes === null ? [] : [{ localDate: input.date, maxMinutes }]),
    ...(nextDayMaxMinutes === null ? [] : [{ localDate: nextDate, maxMinutes: nextDayMaxMinutes }]),
  ];
  const fullUnavailable = exceptions.some(
    (row) => (row.exception_type === "unavailable" && row.start_local == null) ||
      row.exception_type === "approved_leave",
  );
  if (fullUnavailable) return { windows: [], maxMinutes, dailyHourCaps, precedence: "closed" };

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

  // This projection uses the STARTING local date as its minute origin.
  // Overnight windows may reach 2880 (the following midnight). Next-date
  // closures and partial unavailability mask the spillover, while positive
  // hours caps are preserved ONLY as constraints in dailyHourCaps. A positive
  // cap cannot choose which available minutes the planner may assign.
  const followingIsClosed = following.some(
    (row) => row.exception_type === "approved_leave" ||
      (row.exception_type === "unavailable" && row.start_local == null) ||
      (row.exception_type === "hours_cap" && nextDayMaxMinutes === 0),
  );
  if (followingIsClosed) {
    masks.push({ start: 1440, end: 2880 });
  } else {
    // A next-day replace_day is the complete approved date-specific set.
    // Its complement blocks inherited overnight spillovers on that date.
    const nextReplacements = following.filter((row) => row.exception_type === "replace_day");
    if (nextReplacements.length > 0) {
      const allowed = nextReplacements.map((row) => asWindow(row as SchedulingWindow))
        .map((window) => ({ start: window.start, end: Math.min(window.end, 1440) }))
        .filter((window) => window.start < window.end);
      masks.push(...subtractWindows([{ start: 0, end: 1440 }], allowed)
        .map((window) => ({ start: window.start + 1440, end: window.end + 1440 })));
    }
    masks.push(...following.filter(
      (row) => row.exception_type === "unavailable" && row.start_local != null,
    ).map((row) => {
      const window = asWindow(row as SchedulingWindow);
      return { start: window.start + 1440, end: window.end + 1440 };
    }));
  }
  for (const row of input.restrictions ?? []) {
    if (row.confirmation === "owner_confirmed" && row.strength === "hard" &&
        row.preference === "avoid" && row.day_of_week === nextDay.getUTCDay() &&
        activeOnDate(nextDate, row)) {
      const window = asWindow(row);
      masks.push({ start: window.start + 1440, end: window.end + 1440 });
    }
  }
  // A zero-minute cap is the only cap that directly rules out all work on
  // a local date; it does not arbitrarily trim positive-cap availability.
  if (maxMinutes === 0) masks.push({ start: 0, end: 1440 });
  return {
    windows: subtractWindows([...base, ...adds], masks),
    maxMinutes,
    dailyHourCaps,
    precedence: replacements.length ? "replaced" : "recurring",
  };
}

export type CompensationProvenance = "unknown" | "known_paid" | "salary_conversion_pending" | "known_eligible_zero";

export type EmployeeWageSnapshot = {
  wage_period: string | null;
  wage_amount_cents: number | null;
  default_hourly_wage_cents: number | null;
};

/**
 * Validate every persisted compensation label against current employee wages.
 * Return 'unknown' rather than inferring a new attested state, or trusting
 * stale paid/salary/zero classifications. This mirrors the DB integrity
 * predicate, while keeping deterministic scheduling logic pure.
 */
export function compensationProvenance(
  recorded: { cash_cost_state: CompensationProvenance } | null,
  employee: EmployeeWageSnapshot | null,
): CompensationProvenance {
  if (!recorded || !employee) return "unknown";

  // Legacy rows may have NULL amounts. Only NULL and exact nonnegative
  // integer cents are structurally valid; negative, fractional, non-finite,
  // unsafe, or malformed runtime values cannot substantiate ANY known state.
  // Preserve unknown as unknown even if the employee data are malformed.
  if (recorded.cash_cost_state === "unknown") return "unknown";
  const period = employee.wage_period;
  const amount = employee.wage_amount_cents;
  const hourly = employee.default_hourly_wage_cents;
  const validCents = (value: unknown): value is number | null =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if ((period !== "hour" && period !== "month" && period !== "year") ||
      !validCents(amount) || !validCents(hourly)) return "unknown";

  const positiveAmount = (amount ?? 0) > 0;
  const positiveHourly = (hourly ?? 0) > 0;
  const salary = period === "month" || period === "year";

  switch (recorded.cash_cost_state) {
    case "known_eligible_zero":
      return !positiveAmount && !positiveHourly ? "known_eligible_zero" : "unknown";
    case "salary_conversion_pending":
      return salary && positiveAmount && !positiveHourly ? "salary_conversion_pending" : "unknown";
    case "known_paid":
      return positiveAmount && (!salary || positiveHourly) ? "known_paid" : "unknown";
    default:
      return "unknown";
  }
}
