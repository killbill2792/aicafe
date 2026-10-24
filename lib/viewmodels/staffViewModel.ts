import {
  mealBreakStatus,
  payrollTaxCents,
  ratio,
  staffCostLoadedCents,
  wagesCentsForTimecard,
  wagesCentsForTimecards,
} from "@/lib/calc";
import type { BusinessSnapshot, StaffShift } from "@/lib/data/types";
import { formatInTimeZone } from "date-fns-tz";

const HEALTHY_COST_PER_SALES_DOLLAR_CENTS = 30;
const HIGH_DAY_THRESHOLD_CENTS = 30;

/** The active/inactive roster is authoritative, not timecards or imported names. */
export type StaffRosterMember = {
  id: string;
  name: string;
  active: boolean;
  role?: string | null;
};

export type StaffShiftVM = {
  employeeId: string;
  name: string;
  role: string | null;
  clockInIso: string;
  hourlyWageCents: number;
  todayCostCents: number;
  breakFlag: "ok" | "due_soon" | "missed";
  breakDueIso: string | null;
  sourceType: "owner_schedule" | "owner_manual" | "connected_pos" | "imported" | "ai_cafe";
  sourceProvider: string | null;
};

export type StaffViewModel = {
  costPerMinuteCents: number;
  costPerHourCents: number;
  costTodayCents: number;
  onShift: StaffShiftVM[];
  /** A timecard dated today could not be tied to a unique roster member. */
  hasUnmatchedTimecards: boolean;
  dailyCostPerSalesDollarCents: { date: string; cents: number }[];
  healthyCostPerSalesDollarCents: number;
  worstDay: { date: string; cents: number } | null;
};

/** Pass the current roster for owner-facing "On shift now". Legacy projections without
 * roster data retain their existing behavior until their data contract includes one. */
export function buildStaffViewModel(
  snapshot: BusinessSnapshot,
  team?: readonly StaffRosterMember[],
): StaffViewModel {
  const now = new Date(snapshot.staffNowIso);
  const payrollTaxRate = snapshot.business.payrollTaxRate;

  // The snapshot can include historical, imported, and schedule-predicted timecards.
  // Count only unique current team members with an open clock-in today or an active
  // owner-scheduled interval. All date comparisons use the cafe's local calendar.
  const today = formatInTimeZone(now, snapshot.business.timezone, "yyyy-MM-dd");
  const currentTime = now.getTime();
  const rosterById = new Map(team?.map((member) => [member.id, member]) ?? []);
  const rosterByName = new Map<string, StaffRosterMember[]>();
  const normalizedName = (name: string) => name.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();

  for (const member of team ?? []) {
    const name = normalizedName(member.name);
    rosterByName.set(name, [...(rosterByName.get(name) ?? []), member]);
  }

  const findMember = (shift: StaffShift): StaffRosterMember | null => {
    if (!team) {
      // Compatibility for call sites without a separately loaded team roster.
      return { id: shift.employeeId, name: shift.name, active: true, role: shift.role };
    }
    // Stable employee IDs take precedence. Never reassign a removed employee's
    // timecard to a new person who happens to have the same display name.
    const byId = rosterById.get(shift.employeeId);
    if (byId) return byId;
    const matches = rosterByName.get(normalizedName(shift.name)) ?? [];
    // A duplicate display name is ambiguous and must not be guessed.
    return matches.length === 1 ? matches[0] : null;
  };

  const todayShifts = snapshot.staffShiftsToday.filter((shift) => {
    const clockIn = new Date(shift.timecard.clockIn);
    return Number.isFinite(clockIn.getTime())
      && formatInTimeZone(clockIn, snapshot.business.timezone, "yyyy-MM-dd") === today;
  });
  const matchedToday = todayShifts.map((shift) => ({ shift, member: findMember(shift) }));
  const hasUnmatchedTimecards = !!team && matchedToday.some(({ member }) => member === null);
  const byMember = new Map<string, { shift: StaffShift; member: StaffRosterMember }>();

  for (const { shift, member } of matchedToday) {
    if (!member?.active) continue;
    const startedAt = new Date(shift.timecard.clockIn).getTime();
    if (startedAt > currentTime) continue;
    const { clockOut, scheduleId, sourceType } = shift.timecard;
    const scheduled = !!scheduleId || sourceType === "owner_schedule";
    // A closed actual timecard is not proof the person is still working.
    // A scheduled timecard has a planned end, so it counts only while inside
    // its interval. Open attendance counts only when its clock-in was today.
    if (clockOut !== null && (!scheduled || !(new Date(clockOut).getTime() > currentTime))) continue;
    const existing = byMember.get(member.id);
    const isOpen = clockOut === null;
    const existingOpen = existing?.shift.timecard.clockOut === null;
    if (!existing || (isOpen && !existingOpen)
      || (isOpen === existingOpen && startedAt > new Date(existing.shift.timecard.clockIn).getTime())) {
      byMember.set(member.id, { shift, member });
    }
  }
  const onShiftShifts = [...byMember.values()].sort(
    (a, b) => new Date(a.shift.timecard.clockIn).getTime() - new Date(b.shift.timecard.clockIn).getTime(),
  );

  const currentHourlyWageCents = onShiftShifts.reduce((sum, { shift }) => sum + shift.timecard.hourlyWageCents, 0);
  const currentHourlyLoadedCents = staffCostLoadedCents(currentHourlyWageCents, payrollTaxCents(currentHourlyWageCents, payrollTaxRate));

  const wagesTodayCents = wagesCentsForTimecards(
    snapshot.staffShiftsToday.map((s) => s.timecard),
    now,
  );
  const costTodayCents = staffCostLoadedCents(wagesTodayCents, payrollTaxCents(wagesTodayCents, payrollTaxRate));

  const onShift: StaffShiftVM[] = onShiftShifts
    .map(({ shift: s, member }) => {
      const wages = wagesCentsForTimecard(s.timecard, now);
      const todayCostCents = staffCostLoadedCents(wages, payrollTaxCents(wages, payrollTaxRate));
      const mbs = mealBreakStatus(s.timecard, now);
      const breakFlag: StaffShiftVM["breakFlag"] = mbs.missed ? "missed" : mbs.warn ? "due_soon" : "ok";
      const breakDueIso = breakFlag === "ok" ? null : new Date(new Date(s.timecard.clockIn).getTime() + 5 * 3_600_000).toISOString();

      return {
        employeeId: member.id,
        name: member.name,
        role: member.role ?? s.role,
        clockInIso: s.timecard.clockIn,
        hourlyWageCents: s.timecard.hourlyWageCents,
        todayCostCents,
        breakFlag,
        breakDueIso,
        sourceType: s.timecard.sourceType ?? (s.timecard.scheduleId ? "owner_schedule" : "owner_manual"),
        sourceProvider: s.timecard.sourceProvider ?? null,
      };
    });

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
    hasUnmatchedTimecards,
    dailyCostPerSalesDollarCents,
    healthyCostPerSalesDollarCents: HEALTHY_COST_PER_SALES_DOLLAR_CENTS,
    worstDay,
  };
}
