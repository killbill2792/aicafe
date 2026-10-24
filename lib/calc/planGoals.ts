import { OPEN_HOURS_DAY_KEYS, type OpenHours } from "@/lib/business/openHours";
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

export type PlanScenarioBase = {
  monthlyBillsCents: number;
  monthlyStaffCents: number;
  observedSalesCents: number;
  observedIngredientCents: number;
  observedProcessingFeesCents: number;
  daysInMonth: number;
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
};

/** An illustrative scenario. Reuses Money's break-even function, with unchanged
 * unit volumes and card-fee cents. Staff wages are explicitly assumed. */
export function simulatePlanChange(input: {
  base: PlanScenarioBase;
  type: "price" | "ingredient" | "staff";
  item: PlanScenarioItem | null;
  newValueCents: number;
  staffHoursPerDay: number;
  assumedHourlyWageCents: number;
  preset?: "allPrices" | "milk" | null;
  items?: readonly PlanScenarioItem[];
}) {
  const { base, type, item, newValueCents, staffHoursPerDay, assumedHourlyWageCents } = input;
  if (!Number.isFinite(base.observedSalesCents) || base.observedSalesCents <= 0 ||
      !Number.isSafeInteger(base.daysInMonth) || base.daysInMonth < 1 ||
      !Number.isFinite(base.payrollTaxRate) || base.payrollTaxRate < 0 ||
      !Number.isSafeInteger(newValueCents) || newValueCents < 0 ||
      !Number.isFinite(staffHoursPerDay) || staffHoursPerDay < 0 || staffHoursPerDay > 24 ||
      !Number.isSafeInteger(assumedHourlyWageCents) || assumedHourlyWageCents < 0) return null;
  if (input.preset) {
    if ((input.preset === "allPrices" && type !== "price") ||
        (input.preset === "milk" && type !== "ingredient") || !input.items?.length) return null;
  } else if (type !== "staff" && (!item || item.costStatus !== "READY" || item.quantitySoldLast28Days <= 0)) return null;
  const old = calculateBreakEvenSales(base);
  if (old.kind !== "ready") return null;
  let sales = base.observedSalesCents, ingredients = base.observedIngredientCents;
  let staff = base.monthlyStaffCents, profitDelta = 0;
  if (type === "staff") {
    const dailySaving = Math.round(staffHoursPerDay * assumedHourlyWageCents * (1 + base.payrollTaxRate));
    const monthlySaving = Math.min(staff, Math.round(dailySaving * base.daysInMonth));
    staff -= monthlySaving;
    profitDelta = monthlySaving;
  } else {
    let change28Days: number;
    if (input.preset) {
      const soldItems = input.items!.filter(row => row.quantitySoldLast28Days > 0 &&
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
    profitDelta = Math.round((type === "price" ? 1 : -1) * change28Days * base.daysInMonth / 28);
  }
  if (sales <= 0 || ingredients < 0 || !Number.isSafeInteger(profitDelta)) return null;
  const next = calculateBreakEvenSales({ ...base, monthlyStaffCents: staff,
    observedSalesCents: sales, observedIngredientCents: ingredients });
  if (next.kind !== "ready") return null;
  return { monthlyBreakEvenCents: next.breakEvenSalesCents,
    breakEvenChangeCents: next.breakEvenSalesCents - old.breakEvenSalesCents,
    monthlyProfitChangeCents: profitDelta };
}
