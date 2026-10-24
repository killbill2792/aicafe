import { OPEN_HOURS_DAY_KEYS, regularHoursStateForDate, type OpenHours } from "@/lib/business/openHours";
import { calculateBreakEvenSales } from "./breakEvenSales";

/** Use the weekday's configured intervals, including split and overnight shifts. */
export function weekdayHourlyTarget(drinks: number, openHours: OpenHours | null | undefined, date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d));
  const key = Number.isFinite(weekday.getTime()) && weekday.toISOString().slice(0, 10) === date
    ? OPEN_HOURS_DAY_KEYS[weekday.getUTCDay()] : null;
  if (!key || !openHours || !Object.prototype.hasOwnProperty.call(openHours, key)) {
    return { hours: 12, fallback: true, closed: false, perHour: Number.isFinite(drinks) ? Math.ceil(drinks / 12) : null };
  }
  const intervals = (openHours[key] ?? []).map(([start, finish]) => {
    const [h1, m1] = start.split(":").map(Number);
    const [h2, m2] = finish.split(":").map(Number);
    const from = h1 * 60 + m1;
    let to = h2 * 60 + m2;
    if (to <= from) to += 1440;
    return [from, to] as const;
  }).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .sort((a, b) => a[0] - b[0]);
  if (!intervals.length) return { hours: 0, fallback: false, closed: true, perHour: null };
  let total = 0, start = intervals[0][0], end = intervals[0][1];
  for (const [a, b] of intervals.slice(1)) {
    if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  total += end - start;
  const hours = Math.min(24, total / 60);
  return { hours, fallback: false, closed: false,
    perHour: hours > 0 && Number.isFinite(drinks) ? Math.ceil(drinks / hours) : null };
}

/** Match Money's operating-day convention: only explicitly closed weekdays are excluded.
 * Unset hours must not silently assume the café is closed. */
export function countPlanOperatingDays(openHours: OpenHours | null | undefined, monthKey: string): number {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return 0;
  const [year, month] = monthKey.split("-").map(Number);
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const date = `${monthKey}-${String(d).padStart(2, "0")}`;
    if (regularHoursStateForDate(openHours, date) !== "closed") count++;
  }
  return count;
}

/** Sales coverage is a count of OPEN dates with POS evidence, not all calendar
 * dates. A successful zero-order sync on a closed day is actual data but is not
 * a day on which sales could have happened. Match the monthly open-day numerator. */
export function coveredPlanOperatingDays(
  days: readonly { date: string }[],
  openHours: OpenHours | null | undefined,
): number {
  return new Set(days.map(day => day.date)
    .filter(date => regularHoursStateForDate(openHours, date) !== "closed")).size;
}

/** Historical sales on a weekday now configured as closed cannot be extrapolated
 * safely using the current weekly schedule: the total item quantities do not
 * retain enough weekday detail to remove those exceptional sales. */
export function hasPlanSalesOnClosedDays(
  days: readonly { date: string; netSalesCents?: number; ordersCount?: number; drinksCount?: number }[],
  openHours: OpenHours | null | undefined,
): boolean {
  return days.some(day => regularHoursStateForDate(openHours, day.date) === "closed" &&
    ((day.netSalesCents ?? 0) !== 0 || (day.ordersCount ?? 0) > 0 || (day.drinksCount ?? 0) > 0));
}

/** Detect gaps on operating dates between the first and last covered date.
 * The menu-item RPC aggregates that whole interval, so treating only some
 * of those days as covered could put an unrelated quantity in the numerator. */
export function hasUncoveredPlanOperatingDates(
  days: readonly { date: string }[],
  openHours: OpenHours | null | undefined,
  /** Same inclusive end date passed to the item-quantity RPC. */
  asOfDate?: string,
): boolean {
  if (days.length === 0) return false;
  const covered = new Set(days.map(day => day.date));
  const sorted = [...covered].sort();
  const start = sorted[0];
  const end = asOfDate ?? sorted[sorted.length - 1];
  let cursor = Date.parse(start + "T12:00:00Z");
  const last = Date.parse(end + "T12:00:00Z");
  if (!Number.isFinite(cursor) || !Number.isFinite(last)) return true;
  for (; cursor <= last; cursor += 86_400_000) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    if (regularHoursStateForDate(openHours, date) !== "closed" && !covered.has(date)) return true;
  }
  return false;
}

/** A partial or absent week schedule cannot prove how many days the café normally opens. */
export function hasCompletePlanHours(openHours: OpenHours | null | undefined): boolean {
  return !!openHours && OPEN_HOURS_DAY_KEYS.every(key => Object.prototype.hasOwnProperty.call(openHours, key));
}

/** Hours which can realistically be removed from this month's open shifts.
 * The 2–5 PM preset only counts time the shop actually opens during that slot.
 * Unknown weekdays follow Money's "open unless explicitly closed" convention. */
export function monthlyReducibleStaffHours(params: {
  monthKey: string;
  openHours: OpenHours | null | undefined;
  hoursPerOpenDay: number;
  afternoonOnly?: boolean;
}): number | null {
  const { monthKey, openHours, hoursPerOpenDay, afternoonOnly = false } = params;
  if (!/^\d{4}-\d{2}$/.test(monthKey) || !Number.isFinite(hoursPerOpenDay) ||
      hoursPerOpenDay < 0 || hoursPerOpenDay > 24) return null;
  const [year, month] = monthKey.split("-").map(Number);
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let totalMinutes = 0;
  for (let day = 1; day <= calendarDays; day++) {
    const date = `${monthKey}-${String(day).padStart(2, "0")}`;
    if (regularHoursStateForDate(openHours, date) === "closed") continue;
    const key = OPEN_HOURS_DAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    const intervals = openHours?.[key];
    if (!intervals || intervals.length === 0) {
      totalMinutes += Math.min(hoursPerOpenDay * 60, afternoonOnly ? 180 : 720);
      continue;
    }
    const ranges = intervals.map(([open, close]) => {
      const [oh, om] = open.split(":").map(Number);
      const [ch, cm] = close.split(":").map(Number);
      const from = oh * 60 + om;
      let to = ch * 60 + cm;
      if (to <= from) to += 1440;
      return [from, to] as const;
    }).sort((a, b) => a[0] - b[0]);
    let unionMinutes = 0, start = ranges[0][0], end = ranges[0][1];
    for (const [nextStart, nextEnd] of ranges.slice(1)) {
      if (nextStart <= end) end = Math.max(end, nextEnd);
      else {
        unionMinutes += afternoonOnly
          ? Math.max(0, Math.min(1020, end) - Math.max(840, start))
          : end - start;
        start = nextStart; end = nextEnd;
      }
    }
    unionMinutes += afternoonOnly
      ? Math.max(0, Math.min(1020, end) - Math.max(840, start))
      : end - start;
    totalMinutes += Math.min(hoursPerOpenDay * 60, unionMinutes);
  }
  return totalMinutes / 60;
}

export type PlanScenarioBase = {
  monthlyBillsCents: number;
  monthlyStaffCents: number;
  observedSalesCents: number;
  observedIngredientCents: number;
  observedProcessingFeesCents: number;
  daysInMonth: number;
  /** Confirmed sales-covered OPERATING dates in the item quantity window. */
  salesDaysCovered: number;
  /** Café's scheduled open days in this month, matching Money's staff projection. */
  operatingDaysInMonth: number;
  monthKey: string;
  openHours: OpenHours | null | undefined;
  payrollTaxRate: number;
};
export type PlanScenarioItem = {
  id: string;
  name: string;
  priceCents: number;
  ingredientsCentsToday: number;
  quantitySoldLast28Days: number;
  costStatus: "READY" | "NO_RECIPE" | "MISSING_INGREDIENT_COST";
  category?: "drink" | "food";
  active?: boolean;
};

/** An illustrative scenario. Reuses Money's break-even function, with unchanged
 * unit volumes and card-fee cents. Staff wages are explicitly assumed. */
export function simulatePlanChange(input: {
  base: PlanScenarioBase;
  type: "price" | "ingredient" | "staff";
  item: PlanScenarioItem | null;
  newValueCents: number;
  staffHoursPerDay: number;
  /** True only for the explicit one-less-person 2–5 PM preset. */
  staffAfternoonOnly?: boolean;
  assumedHourlyWageCents: number;
  preset?: "allPrices" | "milk" | null;
  items?: readonly PlanScenarioItem[];
}) {
  const { base, type, item, newValueCents, staffHoursPerDay, assumedHourlyWageCents } = input;
  if (!Number.isFinite(base.observedSalesCents) || base.observedSalesCents <= 0 ||
      !Number.isSafeInteger(base.daysInMonth) || base.daysInMonth < 1 || base.daysInMonth > 31 ||
      !Number.isSafeInteger(base.salesDaysCovered) || base.salesDaysCovered < 0 || base.salesDaysCovered > 28 ||
      (type !== "staff" && base.salesDaysCovered < 7) ||
      !Number.isSafeInteger(base.operatingDaysInMonth) || base.operatingDaysInMonth < 1 ||
      base.operatingDaysInMonth > base.daysInMonth ||
      !Number.isFinite(base.payrollTaxRate) || base.payrollTaxRate < 0 ||
      !Number.isSafeInteger(newValueCents) || newValueCents < 0 ||
      !Number.isFinite(staffHoursPerDay) || staffHoursPerDay < 0 || staffHoursPerDay > 24 ||
      !Number.isSafeInteger(assumedHourlyWageCents) || assumedHourlyWageCents < 0) return null;
  if (type === "staff" && base.monthlyStaffCents <= 0) return null;
  if (input.preset) {
    if ((input.preset === "allPrices" && type !== "price") ||
        (input.preset === "milk" && type !== "ingredient") || !input.items?.length) return null;
  } else if (type !== "staff" && (!item || item.costStatus !== "READY" || item.quantitySoldLast28Days <= 0)) return null;
  const old = calculateBreakEvenSales(base);
  if (old.kind !== "ready") return null;
  let sales = base.observedSalesCents, ingredients = base.observedIngredientCents;
  let staff = base.monthlyStaffCents, profitDelta = 0;
  if (type === "staff") {
    // Round only once after the full month's hours and employer costs are applied.
    // Rounding the daily fractional-cent wage first accumulates false savings.
    const eligibleHours = monthlyReducibleStaffHours({
      monthKey: base.monthKey, openHours: base.openHours,
      hoursPerOpenDay: staffHoursPerDay, afternoonOnly: input.staffAfternoonOnly,
    });
    if (eligibleHours === null) return null;
    const monthlySaving = Math.min(staff, Math.round(
      eligibleHours * assumedHourlyWageCents * (1 + base.payrollTaxRate),
    ));
    staff -= monthlySaving;
    profitDelta = monthlySaving;
  } else {
    let change28Days: number;
    if (input.preset) {
      const soldItems = input.items!.filter(row => row.quantitySoldLast28Days > 0 && row.active !== false &&
        (input.preset === "allPrices" || row.category === "drink"));
      const units = soldItems.reduce((sum, row) => sum + row.quantitySoldLast28Days, 0);
      if (units <= 0) return null;
      // The old price chip changes every item's price by 25 cents.
      // The milk chip assumes 150 mL per drink and a $1 increase per 3,785 mL gallon.
      change28Days = input.preset === "allPrices"
        ? newValueCents * units
        : Math.round((newValueCents * 150 * units) / 3785);
    } else {
      const chosen = item!;
      const previous = type === "price" ? chosen.priceCents : chosen.ingredientsCentsToday;
      change28Days = Math.round((newValueCents - previous) * chosen.quantitySoldLast28Days);
    }
    if (type === "price") sales += change28Days;
    else ingredients += change28Days;
    // The item quantity RPC covers the observed dates, not necessarily 28 complete days.
    // Project an observed *per selling day* change across the café's operating days.
    // Dividing by 28 understates a new café with only 7–27 days of sales.
    profitDelta = Math.round(
      (type === "price" ? 1 : -1) * change28Days *
      base.operatingDaysInMonth / base.salesDaysCovered,
    );
  }
  if (sales <= 0 || ingredients < 0 || !Number.isSafeInteger(profitDelta)) return null;
  const next = calculateBreakEvenSales({ ...base, monthlyStaffCents: staff,
    observedSalesCents: sales, observedIngredientCents: ingredients });
  if (next.kind !== "ready") return null;
  return { monthlyBreakEvenCents: next.breakEvenSalesCents,
    breakEvenChangeCents: next.breakEvenSalesCents - old.breakEvenSalesCents,
    monthlyProfitChangeCents: profitDelta };
}
