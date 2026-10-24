import {readUsageVariance} from "@/lib/data/usageVariance.server";
import {usageWeekEnding} from "@/lib/calc/usageDates";
import { getLocale, getTranslations } from "next-intl/server";
import { getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";

import { daysForPeriod, type Period } from "@/lib/viewmodels/period";

import PeriodSwitch from "@/components/shared/PeriodSwitch";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import CostRecoveryStrip from "@/components/home/CostRecoveryStrip";

import SupervisorHomePanel from "@/components/home/SupervisorHomePanel";
import {getCafeAccess} from "@/lib/access/access.server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import HomeTaskSections, { type HomeTaskPreviewItem } from "@/components/home/HomeTaskSections";
import { homeAttentionHref, type HomeAttentionItem } from "@/components/home/homeAttention";
import { getOpenAlerts } from "@/lib/data/getAlerts";
import { describeAlert } from "@/components/alerts/alertContent";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import { formatCents } from "@/lib/calc";
import { getPosConnectionStatus } from "@/lib/data/getPosConnectionStatus";

import { gettingStartedAttention } from "@/components/home/GettingStartedCard";

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
  if(task.kind==="price_experiment_report"){
    const thread=task.payload.threadId,proposal=task.payload.proposalId;
    if(typeof thread==="string"&&typeof proposal==="string")
      return "/?thread="+encodeURIComponent(thread)+"&experiment="+encodeURIComponent(proposal);
    return "/operations?agent=alex&status=needs_you&task="+encodeURIComponent(task.id);
  }
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

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string; thread?: string; experiment?: string }> }) {
  const signedInUser = await requireOwnBusiness();
  const requestedLocale = await getLocale();
  const locale = requestedLocale === "es" || requestedLocale === "ar" ? requestedLocale : "en";
  const chatReadiness = await getSupervisorChatReadiness(Boolean(signedInUser));
  const cafeAccess=signedInUser ? await getCafeAccess(await getActiveBusinessId(signedInUser.id)) : null;
  const { period: periodParam,thread:initialThread,experiment:initialExperiment } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  const [snapshot, menu] = await Promise.all([getSnapshot(), getMenuControlCenter()]);
  const usagePeriod=usageWeekEnding(snapshot.todayDateStr);
  const usageOver=await readUsageVariance({from:usagePeriod.from,to:usagePeriod.to}).then(r=>r.rows.filter(x=>x.status==="over")).catch(()=>[]);
  const vm = buildHomeViewModel(snapshot, period);
  const [t, tOperations, tCategories, tChat, tExperiment, tAlerts, tReconnect] = await Promise.all([
    getTranslations("Home"),
    getTranslations("Operations"),
    getTranslations("Categories"),
    getTranslations("SupervisorChat"),
    getTranslations("SupervisorExperiment"),
    getTranslations("Alerts"),
    getTranslations("Reconnect"),
  ]);
  const tAccess=await getTranslations("FreeAccess");
  const posStatus = await getPosConnectionStatus();
  const derivedTeam = buildOperationsTeamViewModel(snapshot, menu);
  const persistedTasks = await syncAndGetOperatingTasks([...derivedTeam.needsYou, ...derivedTeam.handled, ...derivedTeam.watching]);
  const team = projectOperatingTasks(persistedTasks.tasks);

  const labelFor = (code: string) => (code === "yours" ? t("yours") : snapshot.runningCostLines.find(l => l.categoryCode === code)?.label ?? code);
  const agentNames: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const taskPreview = (task: OperatingTask): HomeTaskPreviewItem => {
    const itemName = String(task.payload.itemName ?? "").replace(" · ", " ");
    let title: string;

    if(task.kind==="price_experiment_report"){
      title=tExperiment("reportTask",{item:itemName});
    }else if (task.status === "handled" && task.kind === "price_review") {
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

  const [alerts, unmatched] = await Promise.all([getOpenAlerts(), getCatalogMatchReview()]);
  const alertItems: HomeAttentionItem[] = alerts.map(alert => {
    const description = describeAlert(alert, tAlerts, code => tCategories(code as ExpenseCategoryCode));
    return { id: "alert:" + alert.id, title: description.title, actionLabel: description.actionLabel,
      href: homeAttentionHref({ kind: "alert", href: description.actionHref }), impactCents: alert.impactCents };
  });
  // Alerts for a missing bill and unmatched catalog items describe the same work.
  const coveredBills = new Set(alerts.filter(a => a.kind === "missing_bill").map(a => String(a.payload.categoryCode ?? "")));
  const missingFeeDays = daysForPeriod(snapshot, period).filter(day => day.netSalesCents > 0 && day.cardFeesStatus === "missing").length;
  const items: HomeAttentionItem[] = [
    ...(vm.isGettingStarted ? gettingStartedAttention({
      connectRegister: t("gettingStartedConnectRegister"), uploadSales: t("gettingStartedUploadSales"),
      addBills: t("gettingStartedAddBills"), addStaff: t("gettingStartedAddStaff"),
      actionLabel: t("attentionFix"),
    }) : []),
    ...(missingFeeDays > 0 ? [{
      id:"fees",title:t("attentionFeesMissing",{count:missingFeeDays}),actionLabel:t("attentionAddFees"),
      href:homeAttentionHref({kind:"fees" as const}),impactCents:null
    }] : []),
    ...vm.missingCategories.filter(line => !coveredBills.has(line.categoryCode)).map(line => ({
      id: "bill:" + line.categoryCode, title: t("missingCostBannerText", {category: tCategories(line.categoryCode)}),
      actionLabel: t("missingCostBannerAction"), href: homeAttentionHref({kind:"bill" as const,category:line.categoryCode}), impactCents: null
    })),
    ...(vm.coverage.actualDays < vm.coverage.expectedDays ? [{
      id:"missing-sales", title:t("attentionSalesMissing",{count:vm.coverage.expectedDays-vm.coverage.actualDays}),
      actionLabel:posStatus?.provider==="toast" ? t("attentionSyncToast") : t("attentionUploadSales"),
      href:homeAttentionHref({kind:"missing_sales" as const,toastConnected:posStatus?.provider==="toast"}),impactCents:null
    }] : []),
    ...(unmatched.length>0 && !alerts.some(a=>a.kind==="unmatched_sales_items") ? [{
      id:"unmatched",title:t("attentionUnmatched",{count:unmatched.length}),actionLabel:t("attentionMatch"),
      href:homeAttentionHref({kind:"unmatched" as const}),impactCents:null
    }]:[]),
    ...(usageOver.length>0 ? [{
      id:"pantry",title:t("usageOverAlert"),actionLabel:t("usageReview"),
      href:homeAttentionHref({kind:"pantry" as const}),impactCents:null
    }]:[]),
    ...(posStatus && posStatus.status!=="active" ? [{
      id:"reconnect",title:tReconnect("banner"),actionLabel:tReconnect("action"),
      href:homeAttentionHref({kind:"reconnect" as const,provider:posStatus.provider}),impactCents:null
    }]:[]),
    ...alertItems,
    ...team.needsYou.filter(task=>!(task.kind==="data_quality" && coveredBills.has(String(task.payload.categoryCode))) &&
      !(task.kind==="data_quality" && vm.missingCategories.some(line=>line.categoryCode===task.payload.categoryCode)))
      .map(task=>({...taskPreview(task),actionLabel:t("attentionFix"),impactCents:
        typeof task.payload.impactCents==="number" ? task.payload.impactCents :
        typeof task.payload.estimatedAmountCents==="number" ? task.payload.estimatedAmountCents : null})),
  ];
  const number = (value:number) => new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(value);
  const pctChange = vm.changeVsLastPeriodPct;
  const percentage = (value:number) => number(Math.round(value*100));
  const money = (cents:number) => formatCents(cents,locale);
  const hasPartial = vm.coverage.actualDays < vm.coverage.expectedDays;
  const changeLabel = pctChange===null ? null : t("changeVsLastPeriod",{
    pct:number(Math.abs(Math.round(pctChange))),direction:pctChange>=0?t("more"):t("less")});
  return <PageShell wide className="flex flex-col gap-4 px-3 pb-4 pt-3 md:px-4 md:pt-4">
    {cafeAccess&&(cafeAccess.remind||!cafeAccess.active)&&<p role="status" className="rounded-xl border border-amber-300 p-4 text-[17px]">
      {cafeAccess.remind ? tAccess("renewSoon",{date:cafeAccess.accessEnd??""}) : tAccess("expired")}
      {" "}<Link href="/pricing" className="underline">{tAccess("haveCode")}</Link>
    </p>}
    <section aria-label={t("keyNumbers")} className="rounded-card-lg bg-card p-4">
      <PeriodSwitch current={period}/>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="min-w-0 rounded-2xl bg-paper p-3">
          <p className="text-[15px] font-bold text-ink-muted">{t("sales")}</p>
          <p className="break-words font-headline text-xl font-bold text-ink">{hasPartial&&vm.coverage.actualDays===0?"—":money(vm.salesCents)}</p>
        </div>
        <div className="min-w-0 rounded-2xl bg-paper p-3">
          <p className="text-[15px] font-bold text-ink-muted">{t("totalCosts")}</p>
          <p className="break-words font-headline text-xl font-bold text-warn">{money(vm.totalCostsCents)}</p>
        </div>
        <div className="min-w-0 rounded-2xl bg-paper p-3">
          <p className="text-[15px] font-bold text-ink-muted">{t("youKeep")}</p>
          <p className="break-words font-headline text-xl font-bold text-ink">{vm.ownerProfitDisplay.kind==="unavailable"?"—":money(vm.ownerProfitDisplay.ownerProfitCents)}</p>
          {vm.ownerProfitDisplay.kind!=="unavailable"&&vm.salesCents>0&&<p className="text-[13px] text-ink-muted">{t("ofSales",{pct:percentage(vm.keepRatio)})}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[15px] text-ink-muted">
        {changeLabel&&<span>{changeLabel}</span>}
        {hasPartial&&<span className="rounded-full bg-warn-tint px-2 py-1 font-bold text-warn">{t("partialPill")}</span>}
        {vm.isEstimate&&<span className="rounded-full bg-surface2 px-2 py-1">{t("estimatePill")}</span>}
      </div>
      <CostRecoveryStrip buckets={vm.recovery.buckets}
        labels={Object.fromEntries(vm.buckets.map(b=>[b.code,labelFor(b.code)]))}
        coveredLabel={(label,date)=>t("coveredOn",{label,date})} locale={locale}/>
    </section>
    <HomeTaskSections items={items} title={t("needsAttention")} empty={t("attentionEmpty")} seeAll={t("taskSeeAll")}/>
    <SupervisorHomePanel
      initialThreadId={initialThread} initialProposalId={initialExperiment}
          experimentCopy={{open:tExperiment("open"),close:tExperiment("close"),product:tExperiment("product"),increase:tExperiment("increase"),preview:tExperiment("preview"),propose:tExperiment("propose"),approve:tExperiment("approve"),apply:tExperiment("apply"),done:tExperiment("done"),report:tExperiment("report"),waiting:tExperiment("waiting"),loading:tExperiment("loading"),error:tExperiment("error"),condition:tExperiment("condition"),confirmNote:tExperiment("confirmNote"),reportNote:tExperiment("reportNote"),selectProposal:tExperiment("selectProposal"),statusDraft:tExperiment("statusDraft"),statusApproved:tExperiment("statusApproved"),statusManual:tExperiment("statusManual"),statusMonitoring:tExperiment("statusMonitoring"),statusExecuting:tExperiment("statusExecuting"),statusRejected:tExperiment("statusRejected"),statusInProgress:tExperiment("statusInProgress"),statusComplete:tExperiment("statusComplete"),statusInsufficient:tExperiment("statusInsufficient")}}
          locale={locale}
      languageSwitch={<LanguageSwitch href="/" compact />}
      chatEnabled={chatReadiness.enabled} canUseAi={cafeAccess?.active??true}
      chatUnavailableReason={chatReadiness.reason}
          chatCopy={{
            newMessage: tChat("newMessage"),
            live: tChat("chatLive"),
            threads: tChat("chatThreads"),
            newThread: tChat("chatNew"),
            empty: tChat("chatEmpty"),
            loading: tChat("chatLoading"),
            sending: tChat("chatSending"),
            statusAlexReading: tChat("chatStatusAlexReading"),
            statusLeoReading: tChat("chatStatusLeoReading"),
            statusOliviaReading: tChat("chatStatusOliviaReading"),
            statusMayaReading: tChat("chatStatusMayaReading"),
            statusSupervisorReading: tChat("chatStatusSupervisorReading"),
            statusSupervisorAnswering: tChat("chatStatusSupervisorAnswering"),
            retry: tChat("chatRetry"),
            answerFailed: tChat("answerFailed"), retryAnswer: tChat("retryAnswer"),
            todaySummary: tChat("todaySummary"),
            unverified: tChat("unverified"),
            provenanceOwner:tChat("provenanceOwner"),provenanceEstimate:tChat("provenanceEstimate"),provenanceUnchecked:tChat("provenanceUnchecked"),
            provenanceBreakEven:tChat("provenanceBreakEven"),provenanceSalesGap:tChat("provenanceSalesGap"),
            provenanceLegend:tChat("provenanceLegend"),provenanceOverhead:tChat("provenanceOverhead"),
            feedbackUp: tChat("feedbackUp"), feedbackDown: tChat("feedbackDown"),
            feedbackSaved: tChat("feedbackSaved"), feedbackError: tChat("feedbackError"),
            ownerInputDismiss:tChat("ownerInputDismiss"),
            ownerInputConfirm:tChat("ownerInputConfirm"),
            ownerInputOther:tChat("ownerInputOther"),
            ownerInputAnswer:tChat("ownerInputAnswer"),
            snapshotExpand: tChat("snapshotExpand"), snapshotCollapse: tChat("snapshotCollapse"),
            recording: tChat("recording"), transcribing: tChat("transcribing"),
            unavailable: tChat("chatUnavailable"),
            more: tChat("chatMore"),
            you: tChat("chatYou"),
            supervisor: tChat("chatSupervisor"),
            source: tChat("chatSource"),
            sourceCafe: tChat("sourceCafe"),
            sourcePricing: tChat("sourcePricing"),
            sourceTasks: tChat("sourceTasks"),
            sourceRules: tChat("sourceRules"),
            sourceVerified: tChat("sourceVerified"),
            listening: tChat("listening"),
            voiceReview: tChat("voiceReview"),
            voiceUnavailable: tChat("voiceUnavailable"),
            voiceStop: tChat("voiceStop"),
            voiceProcessing: tChat("voiceProcessing"),
            voicePermissionDenied: tChat("voicePermissionDenied"),
            voiceNoSpeech: tChat("voiceNoSpeech"),
            voiceServiceUnavailable: tChat("voiceServiceUnavailable"),
            voiceNetworkError: tChat("voiceNetworkError"),
            voiceTooLong: tChat("voiceTooLong"),
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
            emptyHeading: tChat("emptyHeading"),
            emptyIntro: tChat("emptyIntro"),
            historyTitle: tChat("historyTitle"),
            closeHistory: tChat("closeHistory"),
            startNewChat: tChat("startNewChat"),
            reviewHint: tChat("reviewHint"),
            taskOpen: tChat("taskOpen"),
            needsYou: tChat("needsYou"),
            handled: tChat("handled"),
            watching: tChat("watching"),
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
    <Link href="/operations?status=handled" className="min-h-12 self-start text-[17px] font-semibold text-good underline">{t("attentionHandled")}</Link>
  </PageShell>;
}
