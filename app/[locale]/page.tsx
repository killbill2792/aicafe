

import { getLocale, getTranslations } from "next-intl/server";
import { getSupervisorChatReadiness } from "@/lib/ai/conversations/enabled.server";
import { Link } from "@/i18n/navigation";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { buildProfitAndCostsViewModel } from "@/lib/viewmodels/moneyViewModel";




import LanguageSwitch from "@/components/shared/LanguageSwitch";

import SupervisorHomePanel from "@/components/home/SupervisorHomePanel";
import type {HomeStartPayload} from "@/components/home/DeferredChatStart";
import {getCafeAccess} from "@/lib/access/access.server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";

import { homeMoneyQuality } from "@/components/home/homeMoneyQuality";




import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import {readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";





import PageShell from "@/components/shared/PageShell";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";



import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
import type { Period } from "@/lib/viewmodels/period";
import {readOperatingBoard} from "@/lib/operating/board.server";
import {boardHref} from "@/lib/operating/board";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {readSavedTodayLive,currentTodayBusinessDay,readHomeTodayLiveFallback} from "@/lib/data/todayLive.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {liveSalesView,needsHomeLiveReading,needsHomeLiveFallback} from "@/components/home/liveSales";
import {timeReader} from "@/lib/perf/timeReader.server";


// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

function isPeriod(value: string | undefined): value is Period {
  return value === "today" || value === "week" || value === "month";
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ period?: string; thread?: string; experiment?: string }> }) {
  // Authorize the owner before starting any café-scoped data read or streaming the chat.
  const signedInUser = await timeReader("Home","requireOwnBusiness",requireOwnBusiness);
  const [requestedLocale, {period:periodParam,thread:initialThread,experiment:initialExperiment}] = await Promise.all([
    timeReader("Home","getLocale",getLocale), searchParams,
  ]);
  const locale = requestedLocale === "es" || requestedLocale === "ar" ? requestedLocale : "en";
  const period: Period = isPeriod(periodParam) ? periodParam : "today";

  // Start the existing canonical reads early; neither one gates the chat surface.
  const corePromise = Promise.all([
    timeReader("Home","getSnapshot",()=>getSnapshot(period)),
    timeReader("Home","getMenuControlCenter",()=>getMenuControlCenter({includeSalesEvidence:false})),
  ]).catch(()=>null);
  const businessIdPromise = signedInUser
    ? timeReader("Home","getActiveBusinessId",()=>getActiveBusinessId(signedInUser.id))
    : Promise.resolve(null);
  const identityPromise = signedInUser
    ? timeReader("Home","readSupervisorCafeIdentity",async()=>{
      const businessId = await businessIdPromise;
      return businessId ? readSupervisorCafeIdentity(businessId) : null;
    })
    : Promise.resolve(null);
  // Chat enablement, access and currency must be verified before composing messages.
  const [chatReadiness,cafeAccess,identity,t,tChat,tCommon,tAccess,tGoals,tEvents] = await Promise.all([
    timeReader("Home","getSupervisorChatReadiness",()=>getSupervisorChatReadiness(Boolean(signedInUser))),
    signedInUser ? timeReader("Home","getCafeAccess",async()=>{
      const businessId = await businessIdPromise;
      return businessId ? getCafeAccess(businessId) : null;
    }) : Promise.resolve(null),
    identityPromise,
    timeReader("Home","getTranslations.Home",()=>getTranslations("Home")),
    timeReader("Home","getTranslations.SupervisorChat",()=>getTranslations("SupervisorChat")),
    timeReader("Home","getTranslations.Common",()=>getTranslations("Common")),
    timeReader("Home","getTranslations.FreeAccess",()=>getTranslations("FreeAccess")),
    timeReader("Home","getTranslations.Goals",()=>getTranslations("Goals")),
    timeReader("Home","getTranslations.EventsPanel",()=>getTranslations("EventsPanel")),
  ]);
  const cafeCurrency = identity?.currency??null;
  const chatStartPromise: Promise<HomeStartPayload | null> = (async()=>{
    try {
      const core = await corePromise;
      if (!core) throw new Error("canonical_home_reads_failed");
      const [snapshot, menu] = core;
      // All figures come from the same selected-period canonical snapshot as Money and chat.
      const vm = buildHomeViewModel(snapshot, period);
      const moneyVm = buildProfitAndCostsViewModel(snapshot, period);
      const [items,businessId] = await Promise.all([
        timeReader("Home","getAttentionItems",()=>getAttentionItems({period,locale,snapshot,menu})),
        businessIdPromise,
      ]);
      const board=businessId&&identity&&signedInUser
        ?await timeReader("Home","readOperatingBoard",async()=>readOperatingBoard(await createServerSupabaseClient(),
          {businessId,ownerUserId:signedInUser.id},identity.asOf)):null;
  const { costCompleteness, hasPartial, canShowProfit, hasEstimatedCosts, profitChangePct } = homeMoneyQuality(vm,moneyVm);
  const money=(cents:number)=>formatCafeCurrency(cents,locale,cafeCurrency).text;
  // The existence of a rollup row does not mean today's closeout was imported.
  // Match Toast's business date (which can be yesterday before closeout), not UTC.
  const liveDb=period==="today"&&businessId
    ?await timeReader("Home","createServerSupabaseClient",createServerSupabaseClient):null;
  const liveDay=liveDb&&businessId
    ?await timeReader("Home","currentTodayBusinessDay",()=>currentTodayBusinessDay(
      createAdminSupabaseClient(),businessId)).catch(()=>{
      console.error("home.today_live.business_day_failed");return null;
    }):null;
  const recordedDays=[...(snapshot.previousMonthRecordedDays??snapshot.previousMonthDays),
    ...(snapshot.monthRecordedDays??snapshot.monthActualDays)];
  const needsLive=Boolean(liveDb&&businessId)&&needsHomeLiveReading(liveDay,recordedDays);
  let live:Awaited<ReturnType<typeof readSavedTodayLive>>=null;
  if(needsLive&&liveDb&&businessId){
    live=await timeReader("Home","readSavedTodayLive",()=>readSavedTodayLive(liveDb,businessId))
      .catch(()=>{console.error("home.today_live.saved_read_failed");return null;});
    if(needsHomeLiveFallback(live,liveDay)){
      // A bounded retry through the existing canonical live reading.
      live=await timeReader("Home","todaySoFarForBusiness",()=>readHomeTodayLiveFallback(
        createAdminSupabaseClient(),businessId)).catch(()=>{
        console.error("home.today_live.fallback_error");return null;
      });
    }
  }
  const liveView=needsLive?liveSalesView(live,identity?.timezone??null,locale,liveDay):null;
  const sales=liveView?(liveView.netSalesCents===null?"—":money(liveView.netSalesCents))
    :vm.coverage.actualDays===0?"—":money(moneyVm.salesCents);
  const salesCaption=liveView?[t(liveView.fresh?"liveSales":"liveSalesStale",{time:liveView.time}),
    ...(liveView.unreadOrders>0?[t("liveSalesUnread",{count:liveView.unreadOrders})]:[])].join(" · "):null;
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
  })+(vm.comparisonState.kind==="available"&&vm.comparisonState.partialPeriod?" · "+tCommon("partialPeriod"):"");

      return {
        data: {

        period,sales,costs,kept,attention:items,
        partial:hasPartial,estimated:hasEstimatedCosts,
        incomplete:!canShowProfit && vm.coverage.actualDays>0,
        shareCaption,comparisonCaption,salesCaption,
        board:board?{
          running:board.running.map(r=>({key:r.proposalId,
            href:boardHref(r),
            text:r.event?tEvents("boardEventRunning",{title:r.productName}):r.goal?(r.day!==null&&r.day>=1?tGoals("boardGoal",{title:r.productName,day:number(r.day),days:number(r.days??0)})
                :tGoals("boardGoalStarts",{title:r.productName}))
              :r.stage==="waitingOnOwner"?t("boardWaiting",{item:r.productName,price:money(r.newPriceCents)})
              :r.day!==null&&r.day>=1?t("boardMonitoring",{item:r.productName,old:money(r.oldPriceCents),
                new:money(r.newPriceCents),day:number(r.day),days:number(r.days??0)})
              :t("boardMonitoringStarts",{item:r.productName,old:money(r.oldPriceCents),new:money(r.newPriceCents)})})),
          reports:board.recentReports.map(r=>({key:r.proposalId,
            href:boardHref(r),
            text:r.event?tEvents("boardEventReport",{title:r.productName}):r.goal?(r.status==="insufficient_evidence"||r.goal.met===null?tGoals("boardGoalInsufficient",{title:r.productName})
                :r.goal.met?tGoals("boardGoalMet",{title:r.productName}):tGoals("boardGoalMissed",{title:r.productName}))
              :r.status==="insufficient_evidence"?t("boardReportInsufficient",{item:r.productName})
              :r.recommendation==="keep"?t("boardReportKeep",{item:r.productName})
              :r.recommendation==="revert"?t("boardReportRevert",{item:r.productName})
              :t("boardReportAdjust",{item:r.productName})})),
        }:undefined,
              },
        copy: {

        keyNumbers:t("keyNumbers"),sales:t("sales"),knownCosts:t("knownCosts"),
        youKeep:t("youKeep"),partial:t("partialPill"),estimate:t("estimatePill"),
        incomplete:t("costsIncomplete"),details:t("chatStartDetails"),
        seeAll:t("chatStartSeeAll",{count:items.length}),allGood:t("chatStartAllGood"),
        summary:t("chatStartSummary",{period:tCommon(period),sales,kept,count:items.length}),
        roles:{alex:t("chatStartAlexRole"),leo:t("chatStartLeoRole"),
          maya:t("chatStartMayaRole"),olivia:t("chatStartOliviaRole")},
        experimentPrompt:t("chatStartExperimentPrompt"),suggestionsLabel:t("askAnything"),
        handledLabel:t("attentionHandled"),
        boardRunning:t("boardRunning"),boardReports:t("boardReports"),
              },
      };
    } catch {
      // Keep the owner-authenticated chat usable; never fabricate missing money.
      console.error("home.summary.read_failed");
      return null;
    }
  })();
  return <PageShell wide className="flex flex-col gap-4 px-3 pb-4 pt-3 md:px-4 md:pt-4">
    {cafeAccess&&(cafeAccess.remind||!cafeAccess.active)&&<p role="status" className="rounded-xl border border-amber-300 p-4 text-[17px]">
      {cafeAccess.remind ? tAccess("renewSoon",{date:cafeAccess.accessEnd??""}) : tAccess("expired")}
      {" "}<Link href="/pricing" className="underline">{tAccess("haveCode")}</Link>
    </p>}
    <SupervisorHomePanel cafeCurrency={cafeCurrency}
      chatStartPromise={chatStartPromise} boardPeriod={period}
      initialThreadId={initialThread} initialProposalId={initialExperiment}
          locale={locale}
      languageSwitch={<LanguageSwitch href="/" compact />}
      chatEnabled={chatReadiness.enabled} canUseAi={cafeAccess?.active??true}
      chatUnavailableReason={chatReadiness.reason}
          chatCopy={{
        photoRequest:tChat("photoRequest"),
        clarifyFillError:tChat("clarifyFillError"),clarifySaveError:tChat("clarifySaveError"),
        clarifyCountSummary:tChat("clarifyCountSummary"),clarifyPurchaseSummary:tChat("clarifyPurchaseSummary"),
        clarifyOther:tChat("clarifyOther"),clarifySend:tChat("clarifySend"),
        clarifyYouChose:tChat("clarifyYouChose"),clarifySkipped:tChat("clarifySkipped"),
        clarifyOtherPlaceholder:tChat("clarifyOtherPlaceholder"),
        howIGotThis:tChat("howIGotThis"),howCalculated:tChat("howCalculated"),removeEventContext:tChat("removeEventContext"),
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
