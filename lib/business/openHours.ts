export const OPEN_HOURS_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type OpenHoursDayKey = (typeof OPEN_HOURS_DAY_KEYS)[number];
export type OpenHoursInterval = [string, string];
export type OpenHours = Partial<Record<OpenHoursDayKey, OpenHoursInterval[]>>;
export type RegularHoursState = "open" | "closed" | "unknown";
export type DayHoursInput =
  | { mode: "unset" }
  | { mode: "closed" }
  | { mode: "open"; open: string; close: string };
export type WeeklyHoursInput = Record<OpenHoursDayKey, DayHoursInput>;

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidLocalTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function normalizeOpenHours(value: unknown): OpenHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalized: OpenHours = {};
  let hasConfiguredDay = false;

  for (const key of OPEN_HOURS_DAY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    if (!Array.isArray(raw)) continue;

    if (raw.length === 0) {
      normalized[key] = [];
      hasConfiguredDay = true;
      continue;
    }

    const intervals: OpenHoursInterval[] = [];
    for (const interval of raw) {
      if (!Array.isArray(interval) || interval.length !== 2) continue;
      const [open, close] = interval;
      if (typeof open !== "string" || typeof close !== "string") continue;
      if (!isValidLocalTime(open) || !isValidLocalTime(close)) continue;
      intervals.push([open, close]);
    }
    if (intervals.length > 0) {
      normalized[key] = intervals;
      hasConfiguredDay = true;
    }
  }

  return hasConfiguredDay ? normalized : null;
}

export function regularHoursStateForDate(openHours: OpenHours | null | undefined, date: string): RegularHoursState {
  if (!openHours) return "unknown";
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return "unknown";
  const dayKey = OPEN_HOURS_DAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  if (!Object.prototype.hasOwnProperty.call(openHours, dayKey)) return "unknown";
  return (openHours[dayKey]?.length ?? 0) > 0 ? "open" : "closed";
}

export function openHoursToWeeklyInput(openHours: OpenHours | null | undefined): WeeklyHoursInput {
  return Object.fromEntries(
    OPEN_HOURS_DAY_KEYS.map((key) => {
      if (!openHours || !Object.prototype.hasOwnProperty.call(openHours, key)) return [key, { mode: "unset" }];
      const intervals = openHours[key] ?? [];
      if (intervals.length === 0) return [key, { mode: "closed" }];
      return [key, { mode: "open", open: intervals[0][0], close: intervals[0][1] }];
    }),
  ) as WeeklyHoursInput;
}

export function weeklyInputToOpenHours(input: WeeklyHoursInput): OpenHours | null {
  const openHours: OpenHours = {};
  let hasConfiguredDay = false;
  for (const key of OPEN_HOURS_DAY_KEYS) {
    const day = input[key];
    if (day.mode === "unset") continue;
    hasConfiguredDay = true;
    openHours[key] = day.mode === "closed" ? [] : [[day.open, day.close]];
  }
  return hasConfiguredDay ? openHours : null;
}
