import { TrendingDown, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";
import type { Period } from "@/lib/viewmodels/period";
import Money from "@/components/shared/Money";
import EstimatePill from "@/components/shared/EstimatePill";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import AddCostFab from "@/components/shared/AddCostFab";
import CostRecoveryStrip from "@/components/home/CostRecoveryStrip";
import TodayInCupsCard from "@/components/home/TodayInCupsCard";
import {
  AlertsTeaserCard,
  BreakEvenTeaserCard,
  MenuTeaserCard,
  ProfitCostsCard,
  StaffTeaserCard,
} from "@/components/home/SectionCards";
import { formatCents } from "@/lib/calc";
import { getPosConnectionStatus } from "@/lib/data/getPosConnectionStatus";
import ReconnectBanner from "@/components/shared/ReconnectBanner";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireUser();
  const { period: periodParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  const snapshot = await getSnapshot();
  const vm = buildHomeViewModel(snapshot, period);
  const profitVm = buildProfitAndCostsViewModel(snapshot, period);
  const t = await getTranslations("Home");
  const posStatus = await getPosConnectionStatus();

  const changeUp = vm.changeVsLastPeriodPct !== null && vm.changeVsLastPeriodPct >= 0;

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      {posStatus && posStatus.status !== "active" && <ReconnectBanner />}
      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="text-sm font-medium text-ink-muted">{snapshot.todayDateStr}</div>
          <div className="text-[22px] font-bold text-ink">{snapshot.business.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-2xl bg-good-tint px-2.5 py-1.5 text-[13px] font-bold text-good">
            <span className="h-2 w-2 rounded-full bg-good" />
            {t("live")}
          </span>
          <LanguageSwitch href="/" />
        </div>
      </header>

      <PeriodSwitch current={period} />

      <section className="flex flex-col gap-2.5 rounded-card-lg bg-good p-[22px] text-white">
        <div className="flex items-center justify-between">
          <span className="text-[17px] font-semibold">{t("ownerProfit")}</span>
          {vm.isEstimate && <EstimatePill tone="dark" label={t("estimatePill")} />}
        </div>
        <div className="font-headline text-money-md font-bold">
          <Money cents={vm.ownerProfitCents} />
        </div>
        {vm.changeVsLastPeriodPct !== null && (
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            {changeUp ? <TrendingUp aria-hidden="true" size={18} /> : <TrendingDown aria-hidden="true" size={18} />}
            <span>{t("changeVsLastPeriod", { pct: Math.abs(Math.round(vm.changeVsLastPeriodPct)), direction: changeUp ? t("more") : t("less") })}</span>
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-[104px] flex-1 flex-col gap-1 rounded-2xl bg-card p-3.5">
          <span className="text-[13px] font-semibold text-ink-muted">{t("sales")}</span>
          <span className="break-words text-xl font-extrabold">{formatCents(vm.salesCents)}</span>
          <span className="text-xs text-ink-muted">100%</span>
        </div>
        <div className="flex min-w-[104px] flex-1 flex-col gap-1 rounded-2xl bg-card p-3.5">
          <span className="text-[13px] font-semibold text-ink-muted">{t("totalCosts")}</span>
          <span className="break-words text-xl font-extrabold text-warn">{formatCents(vm.totalCostsCents)}</span>
          <span className="text-xs text-ink-muted">{t("ofSales", { pct: Math.round(vm.costsRatio * 100) })}</span>
        </div>
        <div className="flex min-w-[104px] flex-1 flex-col gap-1 rounded-2xl bg-card p-3.5">
          <span className="text-[13px] font-semibold text-ink-muted">{t("youKeep")}</span>
          <span className="break-words text-xl font-extrabold text-good">{formatCents(vm.ownerProfitCents)}</span>
          <span className="text-xs text-ink-muted">{t("ofSales", { pct: Math.round(vm.keepRatio * 100) })}</span>
        </div>
      </div>

      {vm.missingCategories.length > 0 && (
        <div className="rounded-2xl bg-warn-tint p-3.5 text-[15px] font-medium text-warn">
          {t("missingCostBanner", { category: vm.missingCategories[0].label })}
        </div>
      )}

      <CostRecoveryStrip
        buckets={vm.recovery.buckets}
        labels={Object.fromEntries(vm.buckets.map((b) => [b.code, snapshot.runningCostLines.find((l) => l.categoryCode === b.code)?.label ?? b.code]))}
        coveredLabel={(label, date) => t("coveredOn", { label, date })}
      />

      <TodayInCupsCard
        title={t("todayInCupsTitle")}
        perIconLabel={t("perIcon")}
        legend={vm.todayInCups.slices.map((s, i) => ({
          code: s.bucketCode,
          label: s.bucketCode === "yours" ? t("yours") : snapshot.runningCostLines.find((l) => l.categoryCode === s.bucketCode)?.label ?? s.bucketCode,
          color: ["#1E6B4B", "#6FA88C", "#9CC4AE"][i % 3],
        }))}
        slices={vm.todayInCups.slices}
        caption={
          vm.todayInCups.allYours
            ? t("everyCupYours")
            : t("todayInCupsCaption", { cups: snapshot.latestDay.drinksCount, amount: formatCents(vm.todayInCups.slices.reduce((s, x) => s + x.cents, 0)) })
        }
      />

      <ProfitCostsCard
        step={1}
        title={t("profitAndCosts")}
        ingredientsCents={profitVm.ingredientsCents}
        staffCents={profitVm.wagesCents + profitVm.staffTaxCents}
        runningCents={profitVm.totalCostsCents - profitVm.ingredientsCents - profitVm.wagesCents - profitVm.staffTaxCents}
        profitCents={profitVm.ownerProfitCents}
        labels={{ ingredients: t("ingredients"), staff: t("staff"), running: t("running"), profit: t("profit") }}
      />

      <StaffTeaserCard step={2} title={t("staffSection")} perMinuteCents={vm.staffCostPerMinuteNow} perMinuteLabel={t("perMinuteNow")} />

      <MenuTeaserCard
        step={3}
        title={t("menuSection")}
        bestLabel={t("bestEarner")}
        worstLabel={t("keepsLeast")}
        best={vm.bestItem ? { name: vm.bestItem.name, keptCents: vm.bestItem.priceCents - vm.bestItem.ingredientsCentsToday } : null}
        worst={vm.worstItem ? { name: vm.worstItem.name, keptCents: vm.worstItem.priceCents - vm.worstItem.ingredientsCentsToday } : null}
      />

      <BreakEvenTeaserCard
        step={4}
        title={t("breakEvenSection")}
        neededLabel={t("needDrinks", { count: vm.drinksNeeded })}
        averageLabel={t("youAverage", { count: vm.avgDrinksPerDay })}
        progressPct={(vm.avgDrinksPerDay / Math.max(1, vm.drinksNeeded)) * 100}
      />

      <AlertsTeaserCard
        step={5}
        title={t("alertsSection")}
        countLabel={t("newAlerts", { count: vm.alerts.count })}
        leakingCents={vm.alerts.leakingCents}
        leakingLabel={t("leakingThisMonth")}
      />

      <AddCostFab />
    </main>
  );
}
