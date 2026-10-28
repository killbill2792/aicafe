

import { getLocale, getTranslations } from "next-intl/server";
import { getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";




import LanguageSwitch from "@/components/shared/LanguageSwitch";

import SupervisorHomePanel from "@/components/home/SupervisorHomePanel";
import {getCafeAccess} from "@/lib/access/access.server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

import { homeMoneyQuality } from "@/components/home/homeMoneyQuality";




import { formatCents } from "@/lib/calc";





import PageShell from "@/components/shared/PageShell";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";



import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
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
  const [t, tChat, tCommon] = await Promise.all([
    getTranslations("Home"), getTranslations("SupervisorChat"), getTranslations("Common"),
  ]);
  const tAccess=await getTranslations("FreeAccess");
  const items=await getAttentionItems({period,locale,snapshot,menu});
  const { costCompleteness, hasPartial, canShowProfit, hasEstimatedCosts, profitChangePct } = homeMoneyQuality(vm,moneyVm);
  const money=(cents:number)=>formatCents(cents,locale);
  const sales=vm.coverage.actualDays===0?"—":money(moneyVm.salesCents);
  const costs=costCompleteness==="unavailable"||moneyVm.totalCostsCents===null?"—":money(moneyVm.totalCostsCents);
  const kept=canShowProfit&&moneyVm.ownerProfitCents!==null?money(moneyVm.ownerProfitCents):"—";
  // Restore the gated comparisons from the old Home strip; never imply a
  // verified margin or previous-period change when either side is incomplete.
  const number=(value:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(value);
  const shareCaption=canShowProfit&&moneyVm.salesCents>0
    ?t("ofSales",{pct:number(Math.round(vm.keepRatio*100))}):null;
  const comparisonCaption=profitChangePct===null?null:t("changeVsLastPeriod",{
    pct:number(Math.abs(Math.round(profitChangePct))),
    direction:profitChangePct>=0?t("more"):t("less"),
  });
  return <PageShell wide className="flex flex-col gap-4 px-3 pb-4 pt-3 md:px-4 md:pt-4">
    {cafeAccess&&(cafeAccess.remind||!cafeAccess.active)&&<p role="status" className="rounded-xl border border-amber-300 p-4 text-[17px]">
      {cafeAccess.remind ? tAccess("renewSoon",{date:cafeAccess.accessEnd??""}) : tAccess("expired")}
      {" "}<Link href="/pricing" className="underline">{tAccess("haveCode")}</Link>
    </p>}
    <SupervisorHomePanel
      chatStartData={{
        period,sales,costs,kept,attention:items,
        partial:hasPartial,estimated:hasEstimatedCosts,
        incomplete:!canShowProfit && vm.coverage.actualDays>0,
        shareCaption,comparisonCaption,
      }}
      chatStartCopy={{
        keyNumbers:t("keyNumbers"),sales:t("sales"),knownCosts:t("knownCosts"),
        youKeep:t("youKeep"),partial:t("partialPill"),estimate:t("estimatePill"),
        incomplete:t("costsIncomplete"),details:t("chatStartDetails"),
        seeAll:t("chatStartSeeAll",{count:items.length}),allGood:t("chatStartAllGood"),
        summary:t("chatStartSummary",{period:tCommon(period),sales,kept,count:items.length}),
        roles:{alex:t("chatStartAlexRole"),leo:t("chatStartLeoRole"),
          maya:t("chatStartMayaRole"),olivia:t("chatStartOliviaRole")},
        experimentPrompt:t("chatStartExperimentPrompt"),suggestionsLabel:t("askAnything"),
        handledLabel:t("attentionHandled"),
      }}
      initialThreadId={initialThread} initialProposalId={initialExperiment}
          locale={locale}
      languageSwitch={<LanguageSwitch href="/" compact />}
      chatEnabled={chatReadiness.enabled} canUseAi={cafeAccess?.active??true}
      chatUnavailableReason={chatReadiness.reason}
          chatCopy={{
        photoRequest:tChat("photoRequest"),
        clarifyFillError:tChat("clarifyFillError"),
        clarifyCountSummary:tChat("clarifyCountSummary"),clarifyPurchaseSummary:tChat("clarifyPurchaseSummary"),
        clarifyOther:tChat("clarifyOther"),clarifySend:tChat("clarifySend"),
        clarifyYouChose:tChat("clarifyYouChose"),clarifySkipped:tChat("clarifySkipped"),
        clarifyOtherPlaceholder:tChat("clarifyOtherPlaceholder"),
        howIGotThis:tChat("howIGotThis"),howCalculated:tChat("howCalculated"),
        explainMissing:tChat("explainMissing"),
        pricingLaborPrefix:tChat("pricingLaborPrefix"),pricingBillsPrefix:tChat("pricingBillsPrefix"),
        explainYouToldMe:tChat("explainYouToldMe"),
        explainEstimate:tChat("explainEstimate"),explainSold:tChat("explainSold"),
        explainMultiply:tChat("explainMultiply"),explainSum:tChat("explainSum"),
        explainDivide:tChat("explainDivide"),explainRatio:tChat("explainRatio"),
        explainProrate:tChat("explainProrate"),explainSubtract:tChat("explainSubtract"),
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
  </PageShell>;
}
