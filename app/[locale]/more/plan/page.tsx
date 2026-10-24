import { ArrowRight } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import BackHeader from "@/components/shared/BackHeader";
import Money from "@/components/shared/Money";
import PageShell from "@/components/shared/PageShell";
import ProfitGoalSimulator from "@/components/more/ProfitGoalSimulator";
import TryScenario from "@/components/scenario/TryScenario";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { sumCents, summarizeResolvedSoldProductCosts } from "@/lib/calc";
import { weekdayHourlyTarget } from "@/lib/calc/planGoals";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getProfitGoalSimulatorData } from "@/lib/data/getProfitGoalSimulatorData";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { buildBreakEvenViewModel } from "@/lib/viewmodels/breakEvenViewModel";
import { buildCostRecoveryViewModel } from "@/lib/viewmodels/moneyViewModel";

export const dynamic = "force-dynamic";
type PlanTab = "break-even" | "profit-goal" | "what-if";
const TABS: PlanTab[] = ["break-even", "profit-goal", "what-if"];

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireOwnBusiness();
  const { tab: queryTab } = await searchParams;
  const tab: PlanTab = TABS.includes(queryTab as PlanTab) ? queryTab as PlanTab : "break-even";
  const [t, money, economics, common, locale] = await Promise.all([
    getTranslations("BreakEven"), getTranslations("Money"), getTranslations("Economics"),
    getTranslations("Common"), getLocale(),
  ]);
  const snapshot = tab !== "profit-goal" ? await getSnapshot() : null;
  const recovery = snapshot ? buildCostRecoveryViewModel(snapshot) : null;
  const drinks = snapshot ? buildBreakEvenViewModel(snapshot) : null;
  const hourly = snapshot && drinks ? weekdayHourlyTarget(drinks.drinksNeededPerDay, snapshot.business.openHours, snapshot.todayDateStr) : null;
  const days = snapshot?.last28Days ?? [];
  const costs = snapshot ? summarizeResolvedSoldProductCosts(snapshot.breakEvenProductCosts ?? snapshot.menuItems) : null;
  const missing = [
    ...(snapshot && days.length < 7 ? [{ key: "sales", text: money("breakEvenNeedSales"), action: money("uploadSales"), href: "/more/uploads/sales" }] : []),
    ...(snapshot?.runningCostLines.filter(line => line.isMissing && line.isExpected).map(line => ({
      key: line.categoryCode, text: line.label, action: money("addBills"), href: missingCostDestination(line.categoryCode),
    })) ?? []),
    ...(costs?.missingProductCosts ? [{ key: "products", text: money("breakEvenNeedProductCosts"), action: money("addProductCosts"), href: "/menu" }] : []),
    ...(days.some(day => day.cardFeesStatus === "missing") ? [{ key: "fees", text: money("breakEvenNeedProcessingFees"), action: money("fixFees"), href: "/more/processing-fees" }] : []),
  ];
  const pricing = tab === "profit-goal" ? await getProfitGoalSimulatorData() : null;
  const moneyFormat = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  return <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
    <BackHeader title={t("planTitle")} subtitle={t("planSubtitle")} backHref="/more" backLabel={common("back")} />
    <nav aria-label={t("planTitle")} className="grid grid-cols-3 gap-1 rounded-2xl bg-surface p-1">
      {TABS.map(id => <Link key={id} href={`/more/plan?tab=${id}`} aria-current={tab === id ? "page" : undefined}
        className={`flex min-h-12 items-center justify-center rounded-xl px-2 text-center text-[15px] font-bold no-underline ${tab === id ? "bg-card text-ink shadow-sm" : "text-ink-muted"}`}>
        {id === "break-even" ? t("planBreakEven") : id === "profit-goal" ? t("planProfitGoal") : t("planWhatIf")}
      </Link>)}
    </nav>
    {tab === "break-even" && snapshot && recovery && drinks && hourly && <>
      <section className="rounded-card-lg bg-card p-5">
        <h2 className="text-[17px] font-bold">{money("monthlyBreakEven")}</h2>
        <div className="mt-2 font-headline text-[36px] font-bold">{recovery.breakEven.kind === "ready" ? <Money cents={recovery.breakEven.breakEvenSalesCents} /> : "—"}</div>
        {recovery.breakEvenUsesEstimates && recovery.breakEven.kind === "ready" && <p className="text-[15px] text-ink-muted">{money("estimateLower")}</p>}
        <p className="mt-2 text-[17px] text-ink-muted">{t("subtitle")}</p>
      </section>
      {recovery.breakEven.kind === "ready" && !drinks.unavailableReason && <section className="rounded-card-lg bg-card p-5">
        <p className="text-[17px] font-semibold">{t("everyDay")}</p>
        <div className="mt-2 font-headline text-[40px] font-bold text-staff">{numberFormat.format(drinks.drinksNeededPerDay)}</div>
        <p className="text-[17px] font-semibold">{t("drinksToCover")}</p>
        <p className="mt-2 text-[17px] text-ink-muted">{hourly.closed ? t("closedToday") : t("aboutPerHour", { count: numberFormat.format(hourly.perHour ?? 0) })}</p>
        {hourly.fallback && <Link href="/more/cafe-profile?focus=hours" className="mt-3 inline-flex min-h-12 items-center text-[17px] font-bold text-staff underline">{t("setCafeHours")}</Link>}
      </section>}
      {missing.length > 0 && <section className="rounded-card-lg bg-card p-5">
        <h2 className="text-[17px] font-bold">{t("missingPieces")}</h2>
        <div className="mt-3 flex flex-col gap-3">{missing.map(row => <div key={row.key} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface p-3">
          <span className="min-w-0 flex-1 text-[17px]">{row.text}</span>
          <Link href={row.href} className="inline-flex min-h-12 items-center rounded-full bg-accent px-4 text-[17px] font-bold text-on-accent no-underline">{row.action}</Link>
        </div>)}</div>
      </section>}
      {recovery.breakEven.kind === "unavailable" && missing.length === 0 && <p className="rounded-card-lg bg-card p-5 text-[17px]">{money("breakEvenUnavailable")}</p>}
      {recovery.breakEven.kind === "ready" && !drinks.unavailableReason && <section className="rounded-card-lg bg-card p-5">
        <h2 className="mb-3 text-[17px] font-bold">{t("whereFrom")}</h2>
        {[
          { label: t("rentBillsRow"), amount: drinks.runningPerDayCents, href: "/more/bills" },
          { label: t("plannedStaffRow"), amount: drinks.avgDailyStaffCostCents, href: "/staff" },
          { label: t("eachDrinkLeaves"), amount: drinks.avgMoneyLeftPerDrinkCents, href: "/menu" },
        ].map(row => <Link key={row.href} href={row.href} className="flex min-h-12 items-center gap-2 border-b border-line py-3 text-[17px] text-ink no-underline last:border-0">
          <span className="flex-1">{row.label}</span><span className="font-bold">{moneyFormat.format(row.amount / 100)}</span>
          <ArrowRight aria-hidden="true" size={18} className="shrink-0 rtl:rotate-180" />
        </Link>)}
      </section>}
    </>}
    {tab === "profit-goal" && pricing && <ProfitGoalSimulator data={pricing} labels={{
      currentMargin: economics("currentMargin"), currentMarginMissing: economics("currentMarginMissing"),
      actual: economics("actual"), estimated: economics("estimated"),
      targetMargin: economics("targetMargin"), targetMarginHint: economics("targetMarginHint"),
      simulationOnly: economics("simulationOnly"), assumption: economics("assumption"),
      readyMeetsTarget: economics("readyMeetsTarget"), readyNeedsIncrease: economics("readyNeedsIncrease"),
      largeChange: economics("largeChange"), unavailableSales: economics("unavailableSales"),
      unavailableFees: economics("unavailableFees"), unavailableCosts: economics("unavailableCosts"),
      unavailableOperating: economics("unavailableOperating"), targetTested: economics("targetTested"),
      item: economics("item"), productCost: economics("productCost"), productCostPct: economics("productCostPct"),
      currentPrice: economics("currentPrice"), simulatedPrice: economics("simulatedPrice"),
      change: economics("change"), unavailableItem: economics("unavailableItem"),
      invalid: economics("invalid"), targetNotFeasible: economics("targetNotFeasible"),
    }} />}
    {tab === "what-if" && snapshot && <section className="rounded-card-lg bg-card p-5">
      <TryScenario items={snapshot.menuItems.map(item => ({
        id: item.id, name: item.name, priceCents: item.priceCents, costStatus: item.costStatus,
        ingredientsCentsToday: item.ingredientsCentsToday, quantitySoldLast28Days: item.quantitySoldLast28Days,
      }))} base={recovery?.breakEven.kind === "ready" && !drinks?.unavailableReason ? {
        monthlyBillsCents: recovery.monthlyBillsCents, monthlyStaffCents: recovery.monthlyStaffCents,
        observedSalesCents: sumCents(days, d => d.netSalesCents), observedIngredientCents: costs!.totalCostCents,
        observedProcessingFeesCents: sumCents(days, d => d.cardFeesCents),
        daysInMonth: snapshot.daysInMonth, payrollTaxRate: snapshot.business.payrollTaxRate,
      } : null} />
    </section>}
  </PageShell>;
}
