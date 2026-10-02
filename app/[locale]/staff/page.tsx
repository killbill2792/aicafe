import { formatInTimeZone } from "date-fns-tz";
import { Plus } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildStaffViewModel } from "@/lib/viewmodels/staffViewModel";
import { formatCents } from "@/lib/calc";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import Money from "@/components/shared/Money";
import StaffCostBars, { shortWeekday } from "@/components/staff/StaffCostBars";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function StaffPage() {
  await requireOwnBusiness();
  const t = await getTranslations("Staff");
  const locale = await getLocale();

  const snapshot = await getSnapshot();
  const vm = buildStaffViewModel(snapshot);
  const clockLabel = (iso: string) => formatInTimeZone(iso, snapshot.business.timezone, "H:mm");

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-xl font-bold text-ink">{t("title")}</div>
          <div className="text-sm font-medium text-ink-muted">{t("subtitle")}</div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/more/manage-staff" className="flex min-h-12 items-center gap-2 rounded-full bg-ink px-4 text-sm font-bold text-paper no-underline">
            <Plus aria-hidden="true" size={19} /> {t("addStaff")}
          </Link>
          <LanguageSwitch href="/staff" />
        </div>
      </header>

      <section className="flex flex-col gap-3.5 rounded-card-lg bg-staff p-5 text-white">
        <span className="text-[15px] font-semibold opacity-90">{t("rightNowCosts")}</span>
        <div className="flex flex-wrap gap-2">
          <StatTile value={formatCents(vm.costPerMinuteCents)} label={t("aMinute")} />
          <StatTile value={formatCents(vm.costPerHourCents)} label={t("anHour")} />
          <StatTile value={formatCents(vm.costTodayCents)} label={t("todaySoFar")} />
        </div>
      </section>

      <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-4">
        <span className="pb-1.5 text-[17px] font-bold">{t("onShiftNow")}</span>
        {vm.onShift.length === 0 ? (
          <p className="py-3 text-[15px] text-ink-muted">{t("noOneOnShift")}</p>
        ) : (
          vm.onShift.map((s) => (
            <div key={s.employeeId} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-good-tint text-[17px] font-extrabold text-staff">
                {s.name.charAt(0)}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-base font-bold">
                  {s.name} · {s.role ?? t("staffRole")}
                </span>
                {s.breakFlag !== "ok" ? (
                  <span className={`text-[13px] font-semibold ${s.breakFlag === "missed" ? "text-warn" : "text-ink-muted"}`}>
                    {t("sinceShort", { time: clockLabel(s.clockInIso) })} · {t(s.breakFlag === "missed" ? "breakMissed" : "breakDue", { time: clockLabel(s.breakDueIso!) })}
                  </span>
                ) : (
                  <span className="text-[13px] text-ink-muted">
                    {t("sinceWage", { time: clockLabel(s.clockInIso), wage: formatCents(s.hourlyWageCents) })}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="text-lg font-bold">
                  <Money cents={s.todayCostCents} />
                </span>
                <span className="text-xs text-ink-muted">{t("today")}</span>
              </div>
            </div>
          ))
        )}
      </section>

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

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-[104px] flex-1 flex-col items-center gap-0.5 rounded-2xl bg-white/10 px-1.5 py-3">
      <span className="whitespace-nowrap font-headline text-[28px] font-bold leading-none">{value}</span>
      <span className="text-xs opacity-90">{label}</span>
    </div>
  );
}
