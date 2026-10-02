import { TrendingDown, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";
import { buildTodayGlanceViewModel } from "@/lib/viewmodels/todayGlance";
import { profitToneBgClass, profitToneTextClass } from "@/lib/viewmodels/profitTone";
import type { Period } from "@/lib/viewmodels/period";
import Money from "@/components/shared/Money";
import EstimatePill from "@/components/shared/EstimatePill";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import AddCostFab from "@/components/shared/AddCostFab";
import CostRecoveryStrip from "@/components/home/CostRecoveryStrip";
import TodayAtAGlanceCard from "@/components/shared/TodayAtAGlanceCard";
import { todayGlanceCopy } from "@/components/shared/todayGlanceCopy";
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
import GettingStartedCard from "@/components/home/GettingStartedCard";
import PageShell from "@/components/shared/PageShell";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { buildOperationsTeamViewModel, projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import { syncAndGetOperatingTasks } from "@/lib/data/operatingTasks";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requireOwnBusiness();
  const { period: periodParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  const [snapshot, menu] = await Promise.all([getSnapshot(), getMenuControlCenter()]);
  const vm = buildHomeViewModel(snapshot, period);
  const profitVm = buildProfitAndCostsViewModel(snapshot, period);
  const glance = buildTodayGlanceViewModel(snapshot);
  const t = await getTranslations("Home");
  const tCommon = await getTranslations("Common");
  const tOperations = await getTranslations("Operations");
  const posStatus = await getPosConnectionStatus();
  const derivedTeam = buildOperationsTeamViewModel(snapshot, menu);
  const persistedTasks = await syncAndGetOperatingTasks([...derivedTeam.needsYou, ...derivedTeam.handled, ...derivedTeam.watching]);
  const team = projectOperatingTasks(persistedTasks.tasks);

  const changeUp = vm.changeVsLastPeriodPct !== null && vm.changeVsLastPeriodPct >= 0;
  const heroTone = vm.ownerProfitDisplay.kind === "unavailable" ? "neutral" : vm.ownerProfitDisplay.tone;
  const labelFor = (code: string) => (code === "yours" ? t("yours") : snapshot.runningCostLines.find((l) => l.categoryCode === code)?.label ?? code);
  const glanceCopy = todayGlanceCopy(glance, t, tCommon, labelFor);
  const coverageNote =
    vm.coverage.actualDays < vm.coverage.expectedDays
      ? period === "today"
        ? tCommon("noSalesToday")
        : period === "week"
          ? tCommon("salesCoverageWeek", { actual: vm.coverage.actualDays, expected: vm.coverage.expectedDays })
          : tCommon("salesCoverageMonth", { actual: vm.coverage.actualDays, expected: vm.coverage.expectedDays })
      : null;

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
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

      {vm.isGettingStarted && (
        <GettingStartedCard
          labels={{
            title: t("gettingStartedTitle"),
            body: t("gettingStartedBody"),
            connectRegister: t("gettingStartedConnectRegister"),
            uploadSales: t("gettingStartedUploadSales"),
            addBills: t("gettingStartedAddBills"),
            addStaff: t("gettingStartedAddStaff"),
          }}
        />
      )}

      <PeriodSwitch current={period} />

      {coverageNote && <p className="mx-1 text-sm text-ink-muted">{coverageNote}</p>}

      <section className={`flex flex-col gap-2.5 rounded-card-lg p-[22px] text-white ${profitToneBgClass(heroTone)}`}>
        <div className="flex items-center justify-between">
          <span className="text-[17px] font-semibold">{t("ownerProfit")}</span>
          <div className="flex items-center gap-1.5">
            {vm.isEstimate && <EstimatePill tone="dark" label={t("estimatePill")} />}
            {vm.ownerProfitDisplay.kind === "partial" && <EstimatePill tone="dark" label={t("partialPill")} />}
          </div>
        </div>
        {vm.ownerProfitDisplay.kind === "unavailable" ? (
          <div className="text-2xl font-bold">{t("ownerProfitWaiting")}</div>
        ) : (
          <div className="font-headline text-money-md font-bold">
            <Money cents={vm.ownerProfitDisplay.ownerProfitCents} />
          </div>
        )}
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
          {vm.ownerProfitDisplay.kind === "unavailable" ? (
            <span className="text-sm font-semibold text-ink-muted">{t("ownerProfitWaitingShort")}</span>
          ) : (
            <>
              <span className={`break-words text-xl font-extrabold ${profitToneTextClass(vm.ownerProfitDisplay.tone)}`}>
                {formatCents(vm.ownerProfitDisplay.ownerProfitCents)}
              </span>
              <span className="text-xs text-ink-muted">{t("ofSales", { pct: Math.round(vm.keepRatio * 100) })}</span>
            </>
          )}
        </div>
      </div>

      {vm.missingCategories.length > 0 && (
        <Link
          href={missingCostDestination(vm.missingCategories[0].categoryCode)}
          className="flex items-center justify-between gap-2 rounded-2xl bg-warn-tint p-3.5 text-[15px] font-medium text-warn no-underline"
        >
          <span>{t("missingCostBannerText", { category: vm.missingCategories[0].label })}</span>
          <span className="shrink-0 font-bold underline">{t("missingCostBannerAction")}</span>
        </Link>
      )}

      <CostRecoveryStrip
        buckets={vm.recovery.buckets}
        labels={Object.fromEntries(vm.buckets.map((b) => [b.code, snapshot.runningCostLines.find((l) => l.categoryCode === b.code)?.label ?? b.code]))}
        coveredLabel={(label, date) => t("coveredOn", { label, date })}
      />

      <TodayAtAGlanceCard
        title={t("glanceTitle")}
        stats={[
          { label: t("glanceSales"), value: formatCents(glance.salesCents) },
          { label: t("glanceOrders"), value: String(glance.ordersCount) },
          { label: t("glanceAvgOrder"), value: formatCents(glance.avgOrderValueCents) },
          { label: t("glanceMoneyLeft"), value: formatCents(glance.moneyLeftCents) },
        ]}
        secondaryStat={glance.drinksCount > 0 ? t("glanceDrinks", { count: glance.drinksCount }) : null}
        caption={glanceCopy.caption}
        icon={glanceCopy.icon}
      />

      <Link href="/operations" className="flex min-h-20 items-center justify-between gap-3 rounded-card-lg border border-[#D5C7B5] bg-[#EEE5D8] p-[18px] text-ink no-underline">
        <span><span className="block text-sm font-bold text-ink-muted">{tOperations("brandLabel")}</span><span className="block text-xl font-bold">{tOperations("teamTitle")}</span><span className="mt-1 block text-[15px] text-ink-muted">{tOperations("summaryCounts", { needs: team.needsYou.length, handled: team.handled.length, watching: team.watching.length })}</span></span>
        <span className="font-bold text-good">{tOperations("openTeam")}</span>
      </Link>

      <div className="grid gap-3 md:grid-cols-2">
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
        best={vm.bestItem ? { name: vm.bestItem.name, keptCents: vm.bestItem.priceCents - vm.bestItem.ingredientsCentsToday, description: t("keepsAfterIngredients", { amount: formatCents(vm.bestItem.priceCents - vm.bestItem.ingredientsCentsToday) }) } : null}
        worst={vm.worstItem ? { name: vm.worstItem.name, keptCents: vm.worstItem.priceCents - vm.worstItem.ingredientsCentsToday, description: t("keepsAfterIngredients", { amount: formatCents(vm.worstItem.priceCents - vm.worstItem.ingredientsCentsToday) }) } : null}
      />

      <BreakEvenTeaserCard
        step={4}
        title={t("breakEvenSection")}
        neededLabel={t("needDrinks", { count: Number.isFinite(vm.drinksNeeded) ? vm.drinksNeeded : "—" })}
        averageLabel={t("youAverage", { count: vm.avgDrinksPerDay })}
        progressPct={(vm.avgDrinksPerDay / Math.max(1, vm.drinksNeeded)) * 100}
        unavailableLabel={vm.breakEvenUnavailableReason === "missing_costs" ? t("breakEvenMissingCosts", { categories: vm.missingCategories.map((line) => line.label).join(", ") }) : vm.breakEvenUnavailableReason === "missing_sales" ? t("breakEvenMissingSales") : undefined}
      />

      <AlertsTeaserCard
        step={5}
        title={t("alertsSection")}
        countLabel={t("newAlerts", { count: vm.alerts.count })}
        leakingCents={vm.alerts.leakingCents}
        leakingLabel={t("leakingThisMonth")}
      />
      </div>

      <AddCostFab />
    </PageShell>
  );
}
