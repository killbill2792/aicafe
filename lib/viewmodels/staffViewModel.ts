import {
  mealBreakStatus,
  payrollTaxCents,
  ratio,
  staffCostLoadedCents,
  wagesCentsForTimecard,
  wagesCentsForTimecards,
} from "@/lib/calc";
import type { BusinessSnapshot, StaffShift } from "@/lib/data/types";
import { resolvedTimecardSource } from "@/lib/operating/staffAttendance";
import type { TimecardSourceType } from "@/lib/calc/types";

const HEALTHY_COST_PER_SALES_DOLLAR_CENTS = 30;
const HIGH_DAY_THRESHOLD_CENTS = 30;

export type StaffShiftVM = {
  employeeId: string;
  name: string;
  role: string | null;
  clockInIso: string;
  clockOutIso: string | null;
  hourlyWageCents: number;
  todayCostCents: number;
  breakFlag: "ok" | "due_soon" | "missed";
  breakDueIso: string | null;
  sourceType: TimecardSourceType;
  sourceProvider: string | null;
  expectedClockInIso: string | null;
  expectedClockOutIso: string | null;
};

export type StaffViewModel = {
  costPerMinuteCents: number;
  costPerHourCents: number;
  costTodayCents: number;
  onShift: StaffShiftVM[];
  todayShifts: StaffShiftVM[];
  dailyCostPerSalesDollarCents: { date: string; cents: number }[];
  healthyCostPerSalesDollarCents: number;
  worstDay: { date: string; cents: number } | null;
};

export function buildStaffViewModel(snapshot: BusinessSnapshot): StaffViewModel {
  const now = new Date(snapshot.staffNowIso);
  const payrollTaxRate = snapshot.business.payrollTaxRate;

  const onShiftShifts = snapshot.staffShiftsToday.filter((s) => {
    const clockIn = new Date(s.timecard.clockIn).getTime();
    if (clockIn > now.getTime()) return false;
    if (s.timecard.clockOut === null) return true;
    return now.getTime() <= new Date(s.timecard.clockOut).getTime();
  });

  const currentHourlyWageCents = onShiftShifts.reduce((sum, s) => sum + s.timecard.hourlyWageCents, 0);
  const currentHourlyLoadedCents = staffCostLoadedCents(
    currentHourlyWageCents,
    payrollTaxCents(currentHourlyWageCents, payrollTaxRate),
  );

  const wagesTodayCents = wagesCentsForTimecards(
    snapshot.staffShiftsToday.map((s) => s.timecard),
    now,
  );
  const costTodayCents = staffCostLoadedCents(wagesTodayCents, payrollTaxCents(wagesTodayCents, payrollTaxRate));

  const toVm = (s: StaffShift): StaffShiftVM => {
    const wages = wagesCentsForTimecard(s.timecard, now);
    const todayCostCents = staffCostLoadedCents(wages, payrollTaxCents(wages, payrollTaxRate));
    const mbs = mealBreakStatus(s.timecard, now);
    const breakFlag: StaffShiftVM["breakFlag"] = mbs.missed ? "missed" : mbs.warn ? "due_soon" : "ok";
    const breakDueIso =
      breakFlag === "ok" ? null : new Date(new Date(s.timecard.clockIn).getTime() + 5 * 3_600_000).toISOString();

    return {
      employeeId: s.employeeId,
      name: s.name,
      role: s.role,
      clockInIso: s.timecard.clockIn,
      clockOutIso: s.timecard.clockOut,
      hourlyWageCents: s.timecard.hourlyWageCents,
      todayCostCents,
      breakFlag,
      breakDueIso,
      sourceType: resolvedTimecardSource(s.timecard),
      sourceProvider: s.timecard.sourceProvider ?? null,
      expectedClockInIso: s.expectedSchedule?.clockIn ?? null,
      expectedClockOutIso: s.expectedSchedule?.clockOut ?? null,
    };
  };

  const todayShifts = snapshot.staffShiftsToday
    .map(toVm)
    .sort((a, b) => new Date(a.clockInIso).getTime() - new Date(b.clockInIso).getTime());
  const onShiftIds = new Set(onShiftShifts.map((s) => s.employeeId));
  const onShift = todayShifts.filter((shift) => onShiftIds.has(shift.employeeId));

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
    todayShifts,
    dailyCostPerSalesDollarCents,
    healthyCostPerSalesDollarCents: HEALTHY_COST_PER_SALES_DOLLAR_CENTS,
    worstDay,
  };
}
