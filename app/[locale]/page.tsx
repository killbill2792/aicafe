

import { getLocale, getTranslations } from "next-intl/server";
import { getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";




import PeriodSwitch from "@/components/shared/PeriodSwitch";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import CostRecoveryStrip from "@/components/home/CostRecoveryStrip";

import SupervisorHomePanel from "@/components/home/SupervisorHomePanel";
import {getCafeAccess} from "@/lib/access/access.server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

import { homeMoneyQuality } from "@/components/home/homeMoneyQuality";




import { formatCents } from "@/lib/calc";





import PageShell from "@/components/shared/PageShell";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";



import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
import HomeTaskSections from "@/components/home/HomeTaskSections";
import type { Period } from "@/lib/viewmodels/period";


// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string; thread?: string; experiment?: string }> }) {
  const signedInUser = await requireOwnBusiness();
  const requestedLocale = await getLocale();
  const locale = requestedLocale === "es" || requestedLocale === "ar" ? requestedLocale : "en";
  const chatReadiness = await getSupervisorChatReadiness(Boolean(signedInUser));
  const cafeAccess=signedInUser ? await getCafeAccess(await getActiveBusinessId(signedInUser.id)) : null;
  const { period: periodParam,thread:initialThread,experiment:initialExperiment } = await searchParams;
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  // Match Money’s selected-period evidence; the default month snapshot cannot prove Today or Week ingredient coverage.
  const [snapshot, menu] = await Promise.all([getSnapshot(period), getMenuControlCenter()]);
  const vm = buildHomeViewModel(snapshot, period);
  // Money and Supervisor agree on known costs and their evidence. Home must not
  // bypass that canonical completeness gate when showing owner profit.
  const moneyVm = buildProfitAndCostsViewModel(snapshot, period);
  const [t, tCategories, tChat, tExperiment] = await Promise.all([
    getTranslations("Home"),getTranslations("Categories"),
    getTranslations("SupervisorChat"),getTranslations("SupervisorExperiment"),
  ]);
  const tAccess=await getTranslations("FreeAccess");
  const items=await getAttentionItems({period,locale,snapshot,menu});
  const labelFor = (code: string) => code === "yours" ? t("yours") :
    EXPENSE_CATEGORY_CODES.includes(code as ExpenseCategoryCode)
      ? tCategories(code as ExpenseCategoryCode)
      : snapshot.runningCostLines.find(l => l.categoryCode === code)?.label ?? code;
  const number = (value:number) => new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(value);
  // Compare owner profit only when both periods have independently proven costs.
  const { costCompleteness, hasPartial, canShowProfit, profitChangePct: pctChange, hasEstimatedCosts } =
    homeMoneyQuality(vm, moneyVm);
  const percentage = (value:number) => number(Math.round(value*100));
  const money = (cents:number) => formatCents(cents,locale);
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
          <p className="break-words font-headline text-xl font-bold text-ink">{vm.coverage.actualDays===0?"—":money(moneyVm.salesCents)}</p>
        </div>
        <div className="min-w-0 rounded-2xl bg-paper p-3">
          <p className="text-[15px] font-bold text-ink-muted">{t(costCompleteness === "complete" ? "totalCosts" : "knownCosts")}</p>
          <p className="break-words font-headline text-xl font-bold text-warn">{costCompleteness === "unavailable" ? "—" : money(moneyVm.totalCostsCents)}</p>
        </div>
        <div className="min-w-0 rounded-2xl bg-paper p-3">
          <p className="text-[15px] font-bold text-ink-muted">{t("youKeep")}</p>
          <p className="break-words font-headline text-xl font-bold text-ink">{canShowProfit ? money(moneyVm.ownerProfitCents) : "—"}</p>
          {canShowProfit && moneyVm.salesCents>0 && <p className="text-[13px] text-ink-muted">{t("ofSales",{pct:percentage(vm.keepRatio)})}</p>}
          {!canShowProfit && vm.coverage.actualDays>0 && <p className="text-[13px] text-ink-muted">{t("costsIncomplete")}</p>}
          {changeLabel&&<p className="mt-1 text-[13px] leading-tight text-ink-muted">{changeLabel}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[15px] text-ink-muted">
        {hasPartial&&<span className="rounded-full bg-warn-tint px-2 py-1 font-bold text-warn">{t("partialPill")}</span>}
        {hasEstimatedCosts&&<span className="rounded-full bg-surface2 px-2 py-1">{t("estimatePill")}</span>}
      </div>
      <CostRecoveryStrip buckets={vm.recovery.buckets}
        labels={Object.fromEntries(vm.buckets.map(b=>[b.code,labelFor(b.code)]))}
        coveredLabel={(label,date)=>t("coveredOn",{label,date})} locale={locale} emptyLabel={t("glanceNoBills")}
        dataComplete={canShowProfit} incompleteLabel={t("costsIncomplete")}/>
    </section>
    <HomeTaskSections items={items.map(item=>({id:item.id,title:item.displayTitle,href:item.href,actionLabel:item.actionLabel,impactCents:item.impactCents}))} title={t("needsAttention")} empty={t("attentionEmpty")} seeAll={t("taskSeeAll")}/>
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
