import {
  mealBreakStatus,
  payrollTaxCents,
  ratio,
  staffCostLoadedCents,
  wagesCentsForTimecard,
  wagesCentsForTimecards,
} from "@/lib/calc";
import type { BusinessSnapshot } from "@/lib/data/types";

const HEALTHY_COST_PER_SALES_DOLLAR_CENTS = 30;
const HIGH_DAY_THRESHOLD_CENTS = 30;

export type StaffShiftVM = {
  employeeId: string;
  name: string;
  role: string | null;
  clockInIso: string;
  hourlyWageCents: number;
  todayCostCents: number;
  breakFlag: "ok" | "due_soon" | "missed";
  breakDueIso: string | null;
};

export type StaffViewModel = {
  costPerMinuteCents: number;
  costPerHourCents: number;
  costTodayCents: number;
  onShift: StaffShiftVM[];
  dailyCostPerSalesDollarCents: { date: string; cents: number }[];
  healthyCostPerSalesDollarCents: number;
  worstDay: { date: string; cents: number } | null;
};

export function buildStaffViewModel(snapshot: BusinessSnapshot): StaffViewModel {
  const now = new Date(snapshot.staffNowIso);
  const payrollTaxRate = snapshot.business.payrollTaxRate;

  const onShiftShifts = snapshot.staffShiftsToday.filter((s) => s.timecard.clockOut === null);

  const currentHourlyWageCents = onShiftShifts.reduce((sum, s) => sum + s.timecard.hourlyWageCents, 0);
  const currentHourlyLoadedCents = staffCostLoadedCents(currentHourlyWageCents, payrollTaxCents(currentHourlyWageCents, payrollTaxRate));

  const wagesTodayCents = wagesCentsForTimecards(
    snapshot.staffShiftsToday.map((s) => s.timecard),
    now,
  );
  const costTodayCents = staffCostLoadedCents(wagesTodayCents, payrollTaxCents(wagesTodayCents, payrollTaxRate));

  const onShift: StaffShiftVM[] = onShiftShifts
    .map((s) => {
      const wages = wagesCentsForTimecard(s.timecard, now);
      const todayCostCents = staffCostLoadedCents(wages, payrollTaxCents(wages, payrollTaxRate));
      const mbs = mealBreakStatus(s.timecard, now);
      const tookBreak = s.timecard.breaks.length > 0;
      const breakFlag: StaffShiftVM["breakFlag"] = tookBreak ? "ok" : mbs.missed ? "missed" : mbs.warn ? "due_soon" : "ok";
      const breakDueIso = tookBreak ? null : new Date(new Date(s.timecard.clockIn).getTime() + 5 * 3_600_000).toISOString();

      return {
        employeeId: s.employeeId,
        name: s.name,
        role: s.role,
        clockInIso: s.timecard.clockIn,
        hourlyWageCents: s.timecard.hourlyWageCents,
        todayCostCents,
        breakFlag,
        breakDueIso,
      };
    })
    .sort((a, b) => new Date(a.clockInIso).getTime() - new Date(b.clockInIso).getTime());

  const dailyCostPerSalesDollarCents = snapshot.last7Days.map((d) => ({
    date: d.date,
    cents: ratio(d.wagesCents + d.staffTaxCents, d.netSalesCents) * 100,
  }));

  const worstDay = dailyCostPerSalesDollarCents.reduce<{ date: string; cents: number } | null>((worst, day) => {
    if (day.cents <= HIGH_DAY_THRESHOLD_CENTS) return worst;
    if (!worst || day.cents > worst.cents) return day;
    return worst;
  }, null);

  return {
    costPerMinuteCents: currentHourlyLoadedCents / 60,
    costPerHourCents: currentHourlyLoadedCents,
    costTodayCents,
    onShift,
    dailyCostPerSalesDollarCents,
    healthyCostPerSalesDollarCents: HEALTHY_COST_PER_SALES_DOLLAR_CENTS,
    worstDay,
  };
}
