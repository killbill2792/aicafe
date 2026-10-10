import { TrendingDown, TrendingUp } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";
import { buildTodayGlanceViewModel } from "@/lib/viewmodels/todayGlance";
import { hasEstimatedTodayCosts } from "@/lib/viewmodels/homeSnapshotQuality";
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
import SupervisorHomePanel from "@/components/home/SupervisorHomePanel";
import HomeTaskSections, { type HomeTaskPreviewItem } from "@/components/home/HomeTaskSections";
import { formatCents } from "@/lib/calc";
import { getPosConnectionStatus } from "@/lib/data/getPosConnectionStatus";
import ReconnectBanner from "@/components/shared/ReconnectBanner";
import GettingStartedCard from "@/components/home/GettingStartedCard";
import MarginGoalCard from "@/components/home/MarginGoalCard";
import PageShell from "@/components/shared/PageShell";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { buildOperationsTeamViewModel, projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import { syncAndGetOperatingTasks } from "@/lib/data/operatingTasks";
import { priceReviewDirection, priceReviewHref } from "@/lib/viewmodels/priceReviewTask";
import type { ExpenseCategoryCode } from "@/lib/constants";
import type { AgentId, OperatingTask } from "@/lib/operating/tasks";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

function operatingTaskHref(task: OperatingTask): string {
  if (task.kind === "price_review" && task.entityId) return priceReviewHref(task.entityId);
  if (task.kind === "staff_coverage") {
    const query = new URLSearchParams();
    if (task.entityId) query.set("employee", task.entityId);
    const shiftDate = task.payload.shiftDate ?? task.payload.businessDate;
    if (typeof shiftDate === "string") query.set("date", shiftDate);
    return `/more/manage-staff${query.size ? `?${query}` : ""}`;
  }
  if (task.kind === "data_quality") return missingCostDestination(String(task.payload.categoryCode) as ExpenseCategoryCode);
  if (task.kind === "money_update") return "/more/bills";
  // Supply questions need the existing Team inbox; an ingredient-cost upload is not a
  // response to a staff/member stock check, and this UI must never imply it is.
  if (task.kind === "supply_check") {
    const status = task.status === "handled" ? "handled" : task.status === "watching" ? "watching" : "needs_you";
    return `/operations?status=${status}&agent=maya`;
  }
  return "/operations";
}

function newestTaskTime(task: OperatingTask): number {
  const timestamp = Date.parse(task.resolvedAt ?? task.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const signedInUser = await requireOwnBusiness();
  const requestedLocale = await getLocale();
  const locale = requestedLocale === "es" || requestedLocale === "ar" ? requestedLocale : "en";
  const chatReadiness = await getSupervisorChatReadiness(Boolean(signedInUser));
  const { period: periodParam } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  const [snapshot, menu] = await Promise.all([getSnapshot(), getMenuControlCenter()]);
  const vm = buildHomeViewModel(snapshot, period);
  // Today is already the active viewmodel on the default Home period. Avoid recomputing
  // expensive cost-recovery projections just to render the compact snapshot.
  const todayVm = period === "today" ? vm : buildHomeViewModel(snapshot, "today");
  const profitVm = buildProfitAndCostsViewModel(snapshot, period);
  const glance = buildTodayGlanceViewModel(snapshot);
  const [t, tCommon, tOperations, tCategories, tChat] = await Promise.all([
    getTranslations("Home"),
    getTranslations("Common"),
    getTranslations("Operations"),
    getTranslations("Categories"),
    getTranslations("SupervisorChat"),
  ]);
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

  const agentNames: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const taskPreview = (task: OperatingTask): HomeTaskPreviewItem => {
    const itemName = String(task.payload.itemName ?? "").replace(" · ", " ");
    let title: string;

    if (task.status === "handled" && task.kind === "price_review") {
      // Handled covers both "keep current" and a separately verified price application.
      // Never describe a verified price change as a decision to keep the old price.
      title = tOperations(
        task.payload.priceAppliedToPos === true
          ? "homeVerifiedPriceApplied"
          : task.payload.ownerChoice === "keep_price"
            ? "homeHandledPrice"
            : "homePriceReviewClosed",
        { item: itemName },
      );
    } else if (task.status === "handled" && task.kind === "staff_coverage") {
      title = tOperations(task.payload.scheduleApplied === true ? "homeHandledCoverage" : "homeCoverageReviewed");
    } else if (task.status === "handled") {
      title = tOperations("homeTaskHandled");
    } else if (task.kind === "price_review" && task.status === "watching" && task.payload.awaitingPriceApplication === true) {
      title = tOperations("homePriceAwaitingVerification", { item: itemName });
    } else if (task.kind === "price_review" && task.status === "watching" && typeof task.payload.snoozeMode === "string") {
      title = tOperations("homePriceReviewLater", { item: itemName });
    } else if (task.kind === "price_review") {
      const direction = priceReviewDirection(Number(task.payload.currentPriceCents), Number(task.payload.suggestedPriceCents));
      title = tOperations(direction === "low" ? "priceTaskSentenceLow" : "priceTaskSentenceHigh", { item: itemName });
    } else if (task.kind === "data_quality") {
      title = tOperations("missingCategory", { category: tCategories(String(task.payload.categoryCode) as ExpenseCategoryCode) });
    } else if (task.kind === "staff_coverage") {
      title = tOperations("staffTaskNamed", { issue: String(task.payload.issue ?? task.payload.requestType ?? tOperations("staffCoverageIssue")) });
    } else if (task.kind === "money_update") {
      title = tOperations("homeMoneyUpdate");
    } else if (task.kind === "supply_check" && task.status === "needs_response") {
      title = tOperations("homeSupplyNeedsResponse", { item: String(task.payload.itemName ?? tOperations("homeSupplies")) });
    } else {
      title = tOperations("mayaWatching");
    }

    return { id: task.id, agentId: task.agentId, agentName: agentNames[task.agentId], title, href: operatingTaskHref(task) };
  };

  const needsYouPreview = [...team.needsYou]
    .sort((a, b) => {
      const aRank = a.status === "needs_owner" ? 0 : 1;
      const bRank = b.status === "needs_owner" ? 0 : 1;
      return aRank - bRank || newestTaskTime(b) - newestTaskTime(a);
    })
    .slice(0, 2)
    .map(taskPreview);
  const handledPreview = [...team.handled].sort((a, b) => newestTaskTime(b) - newestTaskTime(a)).slice(0, 2).map(taskPreview);
  const watchingPreview = [...team.watching].sort((a, b) => newestTaskTime(b) - newestTaskTime(a)).slice(0, 2).map(taskPreview);

  const todayOwnerProfit =
    todayVm.ownerProfitDisplay.kind === "unavailable"
      ? t("ownerProfitWaitingShort")
      : formatCents(todayVm.ownerProfitDisplay.ownerProfitCents);
  const todayEstimateSuffix = hasEstimatedTodayCosts(snapshot) ? ` · ${t("estimatePill")}` : "";
  const todayPartialSuffix = todayVm.ownerProfitDisplay.kind === "partial" ? ` · ${t("partialPill")}` : "";

  return (
    <PageShell wide className="flex flex-col gap-4 px-4 pb-4 pt-6">
      {posStatus && posStatus.status !== "active" && <ReconnectBanner />}

      <header className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-sm font-medium text-ink-muted">{snapshot.todayDateStr}</div>
          <div className="truncate text-[22px] font-bold text-ink">{snapshot.business.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex min-h-10 items-center gap-1.5 rounded-2xl bg-good-tint px-2.5 py-1.5 text-[13px] font-bold text-good">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)] lg:items-start">
        <SupervisorHomePanel
          locale={locale}
          chatEnabled={chatReadiness.enabled}
          chatUnavailableReason={chatReadiness.reason}
          chatCopy={{
            live: tChat("chatLive"),
            threads: tChat("chatThreads"),
            newThread: tChat("chatNew"),
            empty: tChat("chatEmpty"),
            loading: tChat("chatLoading"),
            sending: tChat("chatSending"),
            retry: tChat("chatRetry"),
            unavailable: tChat("chatUnavailable"),
            more: tChat("chatMore"),
            you: tChat("chatYou"),
            supervisor: tChat("chatSupervisor"),
            source: tChat("chatSource"),
            listening: tChat("listening"),
            voiceReview: tChat("voiceReview"),
            voiceUnavailable: tChat("voiceUnavailable"),
            voiceStop: tChat("voiceStop"),
            voiceProcessing: tChat("voiceProcessing"),
            voicePermissionDenied: tChat("voicePermissionDenied"),
            voiceNoSpeech: tChat("voiceNoSpeech"),
            voiceError: tChat("voiceError"),
            voiceCanceled: tChat("voiceCanceled"),
            attachmentSaved: tChat("attachmentSaved"),
            attachmentNotice: tChat("attachmentNotice"),
            attachmentUpload: tChat("attachmentUpload"),
            statusDisabled: tChat("statusDisabled"),
            statusDatabase: tChat("statusDatabase"),
            statusWriter: tChat("statusWriter"),
            statusOwner: tChat("statusOwner"),
            statusStorage: tChat("statusStorage"),
          }}
          copy={{
            eyebrow: t("supervisorEyebrow"),
            heading: t("supervisorHeading"),
            intro: t("supervisorIntro"),
            teamButton: t("teamButton"),
            askAnything: t("askAnything"),
            composerLabel: t("composerLabel"),
            addAttachment: t("addAttachment"),
            voiceInput: t("voiceInput"),
            sendMessage: t("sendMessage"),
            comingSoon: t("conversationComingSoon"),
            suggestions: [
              t("suggestionHowDoing"),
              t("suggestionAttention"),
              t("suggestionStaff"),
              t("suggestionPrices"),
            ],
          }}
        />

        <TodayAtAGlanceCard
          title={t("todaySnapshotTitle")}
          stats={[
            { label: t("glanceSales"), value: formatCents(glance.salesCents) },
            { label: `${t("ownerProfit")}${todayEstimateSuffix}${todayPartialSuffix}`, value: todayOwnerProfit },
            { label: t("glanceOrders"), value: String(glance.ordersCount) },
            { label: `${t("totalCosts")}${todayEstimateSuffix}`, value: formatCents(todayVm.totalCostsCents) },
          ]}
          secondaryStat={glance.drinksCount > 0 ? t("glanceDrinks", { count: glance.drinksCount }) : null}
          caption={glanceCopy.caption}
          icon={glanceCopy.icon}
        />
      </div>

      <HomeTaskSections
        seeAll={t("taskSeeAll")}
        sections={[
          {
            title: tOperations("needsYou"),
            empty: tOperations("needsYouEmpty"),
            href: "/operations?status=needs_you",
            items: needsYouPreview,
            count: team.needsYou.length,
          },
          {
            title: tOperations("handled"),
            empty: tOperations("handledEmpty"),
            href: "/operations?status=handled",
            items: handledPreview,
            count: team.handled.length,
          },
          {
            title: tOperations("watching"),
            empty: tOperations("watchingEmpty"),
            href: "/operations?status=watching",
            items: watchingPreview,
            count: team.watching.length,
          },
        ]}
      />

      <section className="mt-1 flex flex-col gap-3.5" aria-labelledby="business-overview-title">
        <div className="px-1">
          <h2 id="business-overview-title" className="font-headline text-3xl font-bold text-ink">{t("businessOverviewTitle")}</h2>
          <p className="mt-1 text-[17px] text-ink-muted">{t("businessOverviewIntro")}</p>
        </div>

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

        <MarginGoalCard
          currentMargin={vm.operatingMargin}
          currentMarginQuality={vm.operatingMarginQuality}
          labels={{
            title: t("marginGoalTitle"),
            current: t("currentOperatingMargin"),
            unavailable: t("marginUnavailable"),
            currentActual: t("marginBasedOnCurrentData"),
            currentEstimated: t("marginIncludesEstimates"),
            edit: t("tryProfitGoal"),
            explanation: t("marginExplanation"),
          }}
        />

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
      </section>

      <AddCostFab />
    </PageShell>
  );
}
