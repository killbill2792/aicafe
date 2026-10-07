import { formatInTimeZone } from "date-fns-tz";
import { Plus, UserRoundCheck, UsersRound } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getEmployees } from "@/lib/data/getEmployees";
import { buildStaffViewModel, type StaffShiftVM } from "@/lib/viewmodels/staffViewModel";
import { formatCents } from "@/lib/calc";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import Money from "@/components/shared/Money";
import StaffCostBars, { shortWeekday } from "@/components/staff/StaffCostBars";
import PageShell from "@/components/shared/PageShell";
import PayrollCostCard from "@/components/staff/PayrollCostCard";
import { getPayrollCostSettings } from "@/lib/data/getPayrollCostSettings";

export const dynamic = "force-dynamic";

function providerName(provider: string | null): string {
  if (!provider) return "POS";
  if (provider.toLowerCase() === "square") return "Square";
  if (provider.toLowerCase() === "toast") return "Toast";
  if (provider.toLowerCase() === "clover") return "Clover";
  return provider;
}

export default async function StaffPage() {
  await requireOwnBusiness();
  const t = await getTranslations("Staff");
  const locale = await getLocale();

  const [snapshot, payrollSettings, employees] = await Promise.all([
    getSnapshot(),
    getPayrollCostSettings(),
    getEmployees(),
  ]);
  const vm = buildStaffViewModel(snapshot);
  const clockLabel = (iso: string) => formatInTimeZone(iso, snapshot.business.timezone, "H:mm");
  const nowMs = new Date(snapshot.staffNowIso).getTime();
  const shiftByEmployee = new Map(vm.todayShifts.map((shift) => [shift.employeeId, shift]));

  const activeEmployees = employees.filter((employee) => employee.active);
  const roster =
    activeEmployees.length > 0
      ? activeEmployees.map((employee) => ({
          id: employee.id,
          name: employee.name,
          role: employee.role,
          shift: shiftByEmployee.get(employee.id) ?? null,
        }))
      : vm.todayShifts.map((shift) => ({
          id: shift.employeeId,
          name: shift.name,
          role: shift.role,
          shift,
        }));

  const sourceLabel = (shift: StaffShiftVM) => {
    if (shift.sourceType === "owner_manual_schedule") return t("sourceOwnerSchedule");
    if (shift.sourceType === "owner_manual") return t("sourceOwnerManual");
    if (shift.sourceType === "ai_cafe") return t("sourceAiCafe");
    return t("sourcePos", { provider: providerName(shift.sourceProvider) });
  };

  const statusLabel = (shift: StaffShiftVM | null) => {
    if (!shift) return t("noShiftToday");
    const start = new Date(shift.clockInIso).getTime();
    const end = shift.clockOutIso ? new Date(shift.clockOutIso).getTime() : Number.POSITIVE_INFINITY;
    if (nowMs < start) return t("laterToday");
    if (nowMs <= end) {
      return shift.sourceType === "owner_manual_schedule" ? t("scheduledNow") : t("workingNow");
    }
    return t("finishedToday");
  };

  const timeRange = (shift: StaffShiftVM) =>
    `${clockLabel(shift.clockInIso)}–${shift.clockOutIso ? clockLabel(shift.clockOutIso) : t("openShift")}`;

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-xl font-bold text-ink">{t("title")}</div>
          <div className="text-sm font-medium text-ink-muted">{t("subtitle")}</div>
        </div>
        <LanguageSwitch href="/staff" />
      </header>

      <section className={`flex flex-col gap-3.5 rounded-card-lg p-5 ${vm.onShift.length > 0 ? "bg-good text-white" : "border border-line bg-[#EDE5D9] text-ink"}`}>
        <div className="flex items-center gap-3">
          <span className={`flex h-12 w-12 items-center justify-center rounded-full ${vm.onShift.length > 0 ? "bg-white/15" : "bg-card"}`}>
            {vm.onShift.length > 0 ? <UserRoundCheck aria-hidden="true" /> : <UsersRound aria-hidden="true" />}
          </span>
          <div>
            <strong className="block text-xl">
              {vm.onShift.length > 0 ? t("activeShiftHero", { count: vm.onShift.length }) : t("noOneOnShiftHero")}
            </strong>
            {vm.onShift.length > 0 && (
              <span className={`text-sm ${vm.onShift.length > 0 ? "text-white/85" : "text-ink-muted"}`}>
                {vm.onShift.map((shift) => shift.name).join(", ")}
              </span>
            )}
          </div>
        </div>
        {vm.onShift.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 rounded-2xl bg-black/10 p-3">
              <strong className="font-headline text-4xl"><Money cents={vm.costPerHourCents} /></strong>
              <span className="ms-2 text-sm font-semibold">{t("perHourRightNow")}</span>
              <span className="mt-1 block text-sm text-white/85">{t("perMinuteSecondary", { amount: formatCents(vm.costPerMinuteCents) })}</span>
            </div>
            <div className="col-span-2 flex items-center justify-between rounded-2xl bg-black/10 p-3">
              <span className="text-sm font-semibold">{t("staffCostToday")}</span>
              <strong className="text-xl"><Money cents={vm.costTodayCents} /></strong>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-2xl bg-card p-3">
            <span className="text-sm font-semibold text-ink-muted">{t("staffCostToday")}</span>
            <strong className="font-headline text-3xl text-ink"><Money cents={vm.costTodayCents} /></strong>
          </div>
        )}
      </section>

      <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div>
            <h2 className="text-[17px] font-bold text-ink">{t("todayTeam")}</h2>
            <p className="text-[13px] text-ink-muted">{t("todayTeamHint")}</p>
          </div>
          <Link href="/more/manage-staff" className="flex min-h-12 items-center gap-2 rounded-full bg-ink px-4 text-sm font-bold text-paper no-underline">
            <Plus aria-hidden="true" size={19} /> {t("addStaff")}
          </Link>
        </div>

        {roster.length === 0 ? (
          <p className="py-4 text-[15px] text-ink-muted">{t("noStaffYet")}</p>
        ) : (
          roster.map((person) => {
            const shift = person.shift;
            return (
              <div key={person.id} className="flex gap-3 border-b border-line py-4 last:border-b-0">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-good-tint text-[17px] font-extrabold text-staff">
                  {person.name.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-bold text-ink">{person.name} · {person.role ?? t("staffRole")}</p>
                      <p className="text-sm font-semibold text-ink-muted">{statusLabel(shift)}</p>
                    </div>
                    {shift && (
                      <span className="rounded-full bg-paper px-2.5 py-1 text-xs font-bold text-ink-muted">
                        {sourceLabel(shift)}
                      </span>
                    )}
                  </div>

                  {shift && shift.sourceType !== "owner_manual_schedule" && shift.expectedClockInIso && shift.expectedClockOutIso ? (
                    <div className="mt-2 grid gap-1 text-sm text-ink-muted">
                      <p>{t("scheduledTime", { time: `${clockLabel(shift.expectedClockInIso)}–${clockLabel(shift.expectedClockOutIso)}` })}</p>
                      <p className="font-semibold text-ink">{t("actualTime", { time: timeRange(shift) })}</p>
                    </div>
                  ) : shift ? (
                    <p className="mt-2 text-sm font-semibold text-ink">{timeRange(shift)}</p>
                  ) : (
                    <p className="mt-2 text-sm text-ink-muted">{t("noShiftToday")}</p>
                  )}

                  {shift && shift.sourceType !== "owner_manual_schedule" && shift.breakFlag !== "ok" && (
                    <p className={`mt-1 text-[13px] font-semibold ${shift.breakFlag === "missed" ? "text-warn" : "text-ink-muted"}`}>
                      {t(shift.breakFlag === "missed" ? "breakMissed" : "breakDue", { time: clockLabel(shift.breakDueIso!) })}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      <PayrollCostCard
        settings={payrollSettings}
        labels={{
          title: t("payrollCostsTitle"),
          body: t("payrollCostsBody"),
          field: t("payrollCostsField"),
          hint: t("payrollCostsHint"),
          source: t("payrollSource"),
          ownerSource: t("payrollSourceOwner"),
          estimateSource: t("payrollSourceEstimate"),
          quickbooksSource: t("payrollSourceQuickBooks"),
          importedSource: t("payrollSourceImported"),
          connectedSource: t("payrollSourceConnected"),
          actualUsing: t("payrollActualUsing"),
          fallbackNote: t("payrollFallbackNote"),
          save: t("payrollSave"),
          saving: t("payrollSaving"),
          saved: t("payrollSaved"),
          invalid: t("payrollInvalid"),
        }}
      />

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[17px] font-bold">{t("costPerSalesDollar")}</span>
          <span className="text-[13px] text-ink-muted">{t("healthyLine", { cents: vm.healthyCostPerSalesDollarCents })}</span>
        </div>
        <StaffCostBars days={vm.dailyCostPerSalesDollarCents} healthyCents={vm.healthyCostPerSalesDollarCents} locale={locale} todayLabel={t("today")} />
        <p className="rounded-xl bg-warn-tint p-3 text-sm font-medium leading-snug text-[#6E2A07]">
          {vm.worstDay ? t("worstDayInsight", { date: shortWeekday(vm.worstDay.date, locale), cents: Math.round(vm.worstDay.cents) }) : t("allHealthyInsight")}
        </p>
      </section>
    </PageShell>
  );
}
