import "server-only";
import { z } from "zod";
import { getLocale, getTranslations } from "next-intl/server";
import { createTranslator } from "next-intl";
import type { SupabaseClient } from "@supabase/supabase-js";
import enMessages from "@/messages/en.json";
import esMessages from "@/messages/es.json";
import arMessages from "@/messages/ar.json";
import { getBusinessSnapshotFromDb } from "@/lib/data/snapshot.server";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import type { BusinessSnapshot } from "@/lib/data/types";
import { buildHomeViewModel } from "@/lib/viewmodels/homeViewModel";
import { daysForPeriod, type Period } from "@/lib/viewmodels/period";
import { getPosConnectionStatus } from "@/lib/data/getPosConnectionStatus";
import { isSquareConfigured } from "@/lib/pos/square/oauth";
import { getOpenAlerts } from "@/lib/data/getAlerts";
import { describeAlert } from "@/components/alerts/alertContent";
import { getCatalogMatchReview } from "@/lib/data/getCatalogMatchReview";
import { timeReader } from "@/lib/perf/timeReader.server";
import { gettingStartedAttention } from "@/components/home/GettingStartedCard";
import { homeAttentionHref, homeShiftHref, showAlertInHome, type HomeAttentionItem } from "@/components/home/homeAttention";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { buildOperationsTeamViewModel, projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import {readPersistedOperatingTasks} from "@/lib/data/operatingTasks";
import {isSupabaseConfigured} from "@/lib/supabase/client";
import { priceReviewDirection, priceReviewHref } from "@/lib/viewmodels/priceReviewTask";
import { EXPENSE_CATEGORY_CODES, RUNNING_COST_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import type { AgentId, OperatingTask } from "@/lib/operating/tasks";
import { formatInboxDay, isEventReport, isStaleShiftAlert, settleInboxTasks, taskSubjectDate } from "@/lib/operating/inboxLifecycle";
type HomeTaskPreviewItem={id:string;agentId:AgentId;agentName:string;title:string;href:string;subjectDate:string|null;createdAt:string};
type DatedAttentionItem=HomeAttentionItem&{subjectDate?:string|null;createdAt?:string|null};
const alertDay=(payload:Record<string,unknown>)=>{
  const day=payload.date??payload.shiftDate??payload.businessDate;
  return typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)?day:null;
};

const agentSchema=z.enum(["alex","leo","maya","olivia"]);
export const attentionItemSchema=z.strictObject({
  id:z.string().min(1).max(220),kind:z.string().min(1).max(80),
  agentId:agentSchema,source:z.string().min(1).max(80),
  title:z.strictObject({key:z.string().min(1).max(130),params:z.record(z.string(),z.union([z.string(),z.number()]))}),
  displayTitle:z.string().min(1).max(350),
  actionLabel:z.string().min(1).max(160),href:z.string().min(1).max(1000).regex(/^\/(?!\/)[^\\]*$/),
  impactCents:z.number().int().safe().nullable(),
  /** The day the item is about (shift, brief, event), café-local; null when it has none. */
  subjectDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** When the item was raised (ISO time); null for items computed on read. */
  createdAt:z.string().nullable(),
});
export type AttentionItem=z.infer<typeof attentionItemSchema>;
/** A server-verified café scope for callers without a browser session (morning brief and
 * WhatsApp crons, the verified WhatsApp owner chat). Same reader, same rules; never a model input. */
export type InboxScope={client:SupabaseClient;businessId:string};
export type AttentionArgs={period?:Period;locale?:"en"|"es"|"ar";snapshot?:BusinessSnapshot;
  menu?:Awaited<ReturnType<typeof getMenuControlCenter>>;scope?:InboxScope};
const CATALOGS={en:enMessages,es:esMessages,ar:arMessages};
/** next-intl translators built from the message files, for requests that have no next-intl context. */
function scopedTranslations(locale:"en"|"es"|"ar"){
  const tr=<N extends "Home"|"Operations"|"Categories"|"SupervisorExperiment"|"Alerts"|"Reconnect"|"DailyBrief"|"Goals">(namespace:N)=>
    createTranslator({locale,messages:CATALOGS[locale],namespace}) as unknown as Awaited<ReturnType<typeof getTranslations<N>>>;
  return Promise.resolve([tr("Home"),tr("Operations"),tr("Categories"),tr("SupervisorExperiment"),tr("Alerts"),
    tr("Reconnect"),tr("DailyBrief"),tr("Goals")] as const);
}
/** Home and chat must call this same owner-scoped source. A failed optional read is
 * reported as its own action, never silently replaced with no work. */
function operatingTaskHref(task: OperatingTask): string {
  if((task.kind==="commitment"||task.kind==="event_plan"||task.kind==="event_change") && typeof task.payload.threadId==="string")
    return "/?thread="+encodeURIComponent(task.payload.threadId);
  if(task.kind==="price_experiment_report"){
    const thread=task.payload.threadId,proposal=task.payload.proposalId;
    if(typeof thread==="string"&&typeof proposal==="string")
      return "/?thread="+encodeURIComponent(thread)+"&experiment="+encodeURIComponent(proposal);
    return "/operations?agent=alex&status=needs_you&task="+encodeURIComponent(task.id);
  }
  if (task.kind === "price_review" && task.entityId) return priceReviewHref(task.entityId);
  if (task.kind === "staff_coverage") {
    const shiftDate = task.payload.shiftDate ?? task.payload.businessDate;
    return homeShiftHref(task.entityId, typeof shiftDate === "string" ? shiftDate : null);
  }
  if (task.kind === "data_quality") return missingCostDestination(String(task.payload.categoryCode) as ExpenseCategoryCode);
  if (task.kind === "money_update") return "/more/bills";
  if ((task.kind === "daily_brief" || task.kind === "goal_report" || task.kind === "goal_checkin") && typeof task.payload.threadId === "string")
    return "/?thread=" + encodeURIComponent(task.payload.threadId);
  // Supply questions need the existing Team inbox; an ingredient-cost upload is not a
  // response to a staff/member stock check, and this UI must never imply it is.
  if (task.kind === "supply_check") {
    const status = task.status === "handled" ? "handled" : task.status === "watching" ? "watching" : "needs_you";
    return `/operations?status=${status}&agent=maya`;
  }
  return "/operations";
}


/** Home's Needs-you list. The count on Home, in chat and on every Operations tab is this list. */
export async function getAttentionItems(args:AttentionArgs={}):Promise<AttentionItem[]>{
  return (await readInbox(args)).items;
}
export type Inbox={
  /** Needs you: the one shared attention list. */
  items:AttentionItem[];
  /** Stored inbox tasks after the read-only lifecycle (no writes). */
  tasks:{needsYou:OperatingTask[];watching:OperatingTask[];handled:OperatingTask[]};
  /** Past-shift alerts that can no longer be fixed; shown under Handled as expired. */
  expiredAlerts:AttentionItem[];
};

/** The one inbox reader. Strictly read-only: it never writes operating_tasks. */
export async function readInbox(args:AttentionArgs={}):Promise<Inbox>{
  const period=args.period??"today";
  const scope=args.scope;
  const requestedLocale=args.locale??(scope?"en":await getLocale());
  const locale=requestedLocale==="es"||requestedLocale==="ar"?requestedLocale:"en";
  const [snapshot,menu]=await Promise.all([
    args.snapshot??(scope?getBusinessSnapshotFromDb(scope.client,scope.businessId,period):getSnapshot(period)),
    args.menu??(scope?getMenuControlCenter({},scope):getMenuControlCenter())]);
  if(scope&&snapshot.business.id!==scope.businessId)throw new Error("Inbox café scope mismatch");
  const vm=buildHomeViewModel(snapshot,period);
  // Weekly usage variance scans thousands of order lines. Pantry already reads
  // that report on demand; Home/chat must not await it to show attention items.
  // Independent secondary signals start together, with timings limited to names/ms.
  const [[t,tOperations,tCategories,tExperiment,tAlerts,tReconnect,tBrief,tGoals],
    posStatus,stored,alerts,unmatched]=await Promise.all([
    timeReader("Home","getAttentionTranslations",()=>scope?scopedTranslations(locale):Promise.all([
      getTranslations("Home"),getTranslations("Operations"),getTranslations("Categories"),
      getTranslations("SupervisorExperiment"),getTranslations("Alerts"),getTranslations("Reconnect"),
      getTranslations("DailyBrief"),getTranslations("Goals"),
    ])),
    timeReader("Home","getPosConnectionStatus",scope?()=>getPosConnectionStatus(scope):getPosConnectionStatus),
    isSupabaseConfigured()
      ?timeReader("Home","readPersistedOperatingTasks",()=>scope
        ?readPersistedOperatingTasks(scope.businessId,scope):readPersistedOperatingTasks(snapshot.business.id))
      :Promise.resolve([]),
    // Optional failures should remain visible as an unavailable alert/match item.
    timeReader("Home","getOpenAlerts",scope?()=>getOpenAlerts(scope):getOpenAlerts).catch(()=>null),
    timeReader("Home","getCatalogMatchReview",scope?()=>getCatalogMatchReview(undefined,scope):getCatalogMatchReview).catch(()=>null),
  ]);
  const squareReconnectReady=isSquareConfigured()&&Boolean(process.env.SQUARE_REDIRECT_URI);
  const derivedTeam=buildOperationsTeamViewModel(snapshot,menu);
  // Page loads are strictly READ-ONLY. Persisted task lifecycle is authoritative;
  // ephemeral derived actions remain visible until a dedicated task-refresh job
  // is wired (outside Prompt B's allowed files).
  const derived=[...derivedTeam.needsYou,...derivedTeam.handled,...derivedTeam.watching];
  const today=snapshot.todayDateStr;
  // Same plan the old page-load sync wrote, applied in memory, plus collapse/expiry rules.
  const team=projectOperatingTasks(settleInboxTasks(stored,derived,new Date(),today));
  const agentNames: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const taskPreview = (task: OperatingTask): HomeTaskPreviewItem => {
    const itemName = String(task.payload.itemName ?? "").replace(" · ", " ");
    let title: string;

    if(task.kind==="commitment"){
      title=String(task.payload.title??"");
    }else if(task.kind==="price_experiment_report"){
      title=tExperiment("reportTask",{item:itemName});
    }else if(task.kind==="daily_brief"){
      title=tBrief("taskTitle");
    }else if(task.kind==="goal_checkin"){
      title=tGoals("taskCheckinTitle",{question:String(task.payload.question??"")});
    }else if(task.kind==="goal_report"){
      title=tGoals(task.payload.midRun===true?"taskMidRunTitle":"taskTitle",{title:String(task.payload.goalTitle??"")});
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
    } else if (task.kind === "event_change") {
      title = tOperations("eventChangeReview", {event:String(task.payload.eventName ?? "")});
    } else if (task.kind === "event_plan" && isEventReport(task)) {
      title = tOperations("eventReportTask", {date:formatInboxDay(taskSubjectDate(task) ?? "",locale)});
    } else if (task.kind === "event_plan") {
      title = tOperations("eventPlanReview", {date:formatInboxDay(taskSubjectDate(task) ?? "",locale)});
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

    return { id: task.id, agentId: task.agentId, agentName: agentNames[task.agentId], title, href: operatingTaskHref(task),
      subjectDate: taskSubjectDate(task), createdAt: task.createdAt };
  };

  const alertItems: DatedAttentionItem[] = (alerts ?? []).filter(alert => showAlertInHome(alert.kind)).map(alert => {
    const description = describeAlert(alert, tAlerts, code => tCategories(code as ExpenseCategoryCode));
    // The legacy manage-staff redirect opens Team, not Schedule. Link directly
    // to Schedule so the meal-break fix is reachable before Step 13 merges.
    const href = alert.kind === "meal_break"
      ? homeShiftHref(String(alert.payload.employeeId ?? ""), String(alert.payload.date ?? ""))
      : description.actionHref;
    return { id: "alert:" + alert.id, title: description.title, actionLabel: description.actionLabel,
      href: homeAttentionHref({ kind: "alert", href }), impactCents: alert.impactCents,
      subjectDate: alertDay(alert.payload), createdAt: alert.createdAt };
  });
  // Alerts for a missing bill and unmatched catalog items describe the same work.
  const coveredBills = new Set((alerts ?? []).filter(a => a.kind === "missing_bill").map(a => String(a.payload.categoryCode ?? "")));
  const missingFeeDays = daysForPeriod(snapshot, period).filter(day => day.netSalesCents > 0 && day.cardFeesStatus === "missing").length;
  const staleAlertIds=new Set((alerts??[]).filter(alert=>isStaleShiftAlert(alert,today)).map(alert=>"alert:"+alert.id));
  const items: DatedAttentionItem[] = [
    ...(alerts === null ? [{
      id:"alerts-unavailable",title:t("attentionAlertsUnavailable"),actionLabel:t("attentionCheckAlerts"),
      href:"/more/alerts",impactCents:null
    }] : []),
    ...(posStatus && posStatus.status!=="active" ? [{
      id:"reconnect",
      title:posStatus.provider==="square" && !squareReconnectReady ? t("attentionRegisterSetupUnavailable") : tReconnect("banner"),
      actionLabel:posStatus.provider==="toast" || posStatus.provider==="square" && squareReconnectReady
        ? tReconnect("action") : t("attentionUploadSales"),
      href:homeAttentionHref({kind:"reconnect" as const,provider:posStatus.provider,
        locale, squareConfigured:squareReconnectReady}),impactCents:null
    }]:[]),
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
    ...(!vm.isGettingStarted && vm.coverage.actualDays < vm.coverage.expectedDays ? [{
      id:"missing-sales", title:t("attentionSalesMissing",{count:vm.coverage.expectedDays-vm.coverage.actualDays}),
      actionLabel:posStatus?.provider==="toast" && posStatus.status==="active" ? t("attentionSyncToast") : t("attentionUploadSales"),
      href:homeAttentionHref({kind:"missing_sales" as const,toastConnected:posStatus?.provider==="toast" && posStatus.status==="active"}),impactCents:null
    }] : []),
    ...(unmatched === null ? [{
      id:"match-unavailable",title:t("attentionMatchUnavailable"),actionLabel:t("attentionMatch"),
      href:homeAttentionHref({kind:"unmatched" as const}),impactCents:null
    }] : unmatched.length>0 ? [{
      id:"unmatched",title:t("attentionUnmatched",{count:unmatched.length}),actionLabel:t("attentionMatch"),
      href:homeAttentionHref({kind:"unmatched" as const}),impactCents:null
    }]:[]),
    ...alertItems,
    ...team.needsYou.filter(task=>!(task.kind==="data_quality" && coveredBills.has(String(task.payload.categoryCode))) &&
      !(task.kind==="data_quality" && vm.missingCategories.some(line=>line.categoryCode===task.payload.categoryCode)))
      .map(task=>({...taskPreview(task),actionLabel:task.kind==="commitment"?tOperations("openEventThread"):
         task.kind==="event_change"?tOperations("eventChangeReviewAction"):t("attentionFix"),impactCents:
        typeof task.payload.impactCents==="number" ? task.payload.impactCents :
        typeof task.payload.estimatedAmountCents==="number" ? task.payload.estimatedAmountCents : null})),
  ];

  const taskMap=new Map(team.needsYou.map(task=>[task.id,task]));
  const alertMap=new Map((alerts??[]).map(alert=>["alert:"+alert.id,alert]));
  const parsed=z.array(attentionItemSchema).parse(items.map(item=>{
    const task=taskMap.get(item.id),alert=alertMap.get(item.id);
    const kind=task?.kind??alert?.kind??(item.id.startsWith("bill:")?"bill":item.id);
    const source=task?"operating_tasks":alert?"alerts":item.id==="unmatched"?"pos_catalog_matches":
      item.id.startsWith("bill:")?"missing_costs":"home";
    const agentId:AgentId=task?.agentId??(kind==="staff_coverage"||kind==="meal_break"||
      kind==="early_clockin"||kind==="overstaffed"||kind==="getting-started-staff"?"olivia":
      kind==="unmatched"||kind==="match-unavailable"||kind==="supply_check"?"maya":
      kind==="bill"||kind==="fees"||kind==="data_quality"||kind==="money_update"||
      kind==="missing_bill"||kind==="getting-started-bills"?"leo":"alex");
    // Preserve the actual next-intl key and interpolation arguments as provenance.
    // displayTitle is the already-localized string shown on Home and in chat.
    let key:string="Home.attentionEmpty";
    let params:Record<string,string|number>={};
    if(task){
      const itemName=String(task.payload.itemName??"").replace(" · "," ");
      if(task.kind==="commitment"){
        // Owner-authored task text is the provenance, not a stock translation.
        key="operating_tasks.title";params={title:String(task.payload.title??"")};
      }else if(task.kind==="price_experiment_report"){key=task.payload.midRun===true?"SupervisorExperiment.midRunTask":
        "SupervisorExperiment.reportTask";params={item:itemName};}
      else if(task.kind==="daily_brief"){key="DailyBrief.taskTitle";}
      else if(task.kind==="goal_checkin"){key="Goals.taskCheckinTitle";params={question:String(task.payload.question??"")};}
      else if(task.kind==="goal_report"){key=task.payload.midRun===true?"Goals.taskMidRunTitle":"Goals.taskTitle";
        params={title:String(task.payload.goalTitle??"")};}
      else if(task.kind==="event_plan"){key=isEventReport(task)?"Operations.eventReportTask":"Operations.eventPlanReview";
        params={date:formatInboxDay(taskSubjectDate(task)??"",locale)};}
      else if(task.status==="handled" && task.kind==="price_review"){
        key=task.payload.priceAppliedToPos===true?"Operations.homeVerifiedPriceApplied":
          task.payload.ownerChoice==="keep_price"?"Operations.homeHandledPrice":"Operations.homePriceReviewClosed";
        params={item:itemName};
      }else if(task.status==="handled" && task.kind==="staff_coverage"){
        key=task.payload.scheduleApplied===true?"Operations.homeHandledCoverage":"Operations.homeCoverageReviewed";
      }else if(task.status==="handled"){
        key="Operations.homeTaskHandled";
      }else if(task.kind==="price_review" && task.status==="watching" && task.payload.awaitingPriceApplication===true){
        key="Operations.homePriceAwaitingVerification";params={item:itemName};
      }else if(task.kind==="price_review" && task.status==="watching" && typeof task.payload.snoozeMode==="string"){
        key="Operations.homePriceReviewLater";params={item:itemName};
      }else if(task.kind==="event_change"){
        key="Operations.eventChangeReview";params={event:String(task.payload.eventName??"")};
      }else if(task.kind==="price_review"){
        const direction=priceReviewDirection(Number(task.payload.currentPriceCents),Number(task.payload.suggestedPriceCents));
        key=direction==="low"?"Operations.priceTaskSentenceLow":"Operations.priceTaskSentenceHigh";
        params={item:itemName};
      }else if(task.kind==="data_quality"){
        key="Operations.missingCategory";params={category:tCategories(String(task.payload.categoryCode) as ExpenseCategoryCode)};
      }else if(task.kind==="staff_coverage"){
        key="Operations.staffTaskNamed";params={issue:String(task.payload.issue??task.payload.requestType??tOperations("staffCoverageIssue"))};
      }else if(task.kind==="money_update")key="Operations.homeMoneyUpdate";
      else if(task.kind==="supply_check" && task.status==="needs_response"){
        key="Operations.homeSupplyNeedsResponse";params={item:String(task.payload.itemName??tOperations("homeSupplies"))};
      }else key="Operations.mayaWatching";
    }else if(alert){
      if(alert.kind==="missing_bill" &&
        RUNNING_COST_CODES.includes(String(alert.payload.categoryCode??"") as typeof RUNNING_COST_CODES[number])){
        key="Alerts.missingBillTitle";
        params={category:tCategories(String(alert.payload.categoryCode) as ExpenseCategoryCode)};
      }else if(alert.kind==="voids")key="Alerts.voidsTitle";
      else if(alert.kind==="meal_break"){
        key="Alerts.mealBreakTitle";
        params={name:String(alert.payload.employeeName??tAlerts("someone"))};
      }else key="Alerts.unknownTitle";
    }else if(item.id==="unmatched"){key="Home.attentionUnmatched";params={count:unmatched?.length??0};}
    else if(item.id==="match-unavailable")key="Home.attentionMatchUnavailable";
    else if(item.id==="alerts-unavailable")key="Home.attentionAlertsUnavailable";
    else if(item.id==="fees"){key="Home.attentionFeesMissing";params={count:missingFeeDays};}
    else if(item.id.startsWith("bill:")){
      key="Home.missingCostBannerText";
      params={category:tCategories(item.id.slice(5) as ExpenseCategoryCode)};
    }else if(item.id==="missing-sales"){
      key="Home.attentionSalesMissing";params={count:vm.coverage.expectedDays-vm.coverage.actualDays};
    }else if(item.id==="reconnect")key=posStatus?.provider==="square"&&!squareReconnectReady?
      "Home.attentionRegisterSetupUnavailable":"Reconnect.banner";
    else if(item.id==="getting-started-connect")key="Home.gettingStartedConnectRegister";
    else if(item.id==="getting-started-sales")key="Home.gettingStartedUploadSales";
    else if(item.id==="getting-started-bills")key="Home.gettingStartedAddBills";
    else if(item.id==="getting-started-staff")key="Home.gettingStartedAddStaff";
    return {id:item.id,kind,source,agentId,title:{key,params},
      displayTitle:item.title,actionLabel:item.actionLabel,href:item.href,
      impactCents:Number.isSafeInteger(item.impactCents)?item.impactCents:null,
      subjectDate:item.subjectDate??null,createdAt:item.createdAt??null};
  }));
  return {items:parsed.filter(item=>!staleAlertIds.has(item.id)),
    expiredAlerts:parsed.filter(item=>staleAlertIds.has(item.id)),
    tasks:{needsYou:team.needsYou,watching:team.watching,handled:team.handled}};
}

/** What the crons need from the inbox: the Needs-you count and the newest stored or
 * computed task in it. Derived from readInbox only, so it always equals Home's count. */
export function needsYouSummary(inbox:Inbox):{count:number;newestTask:OperatingTask|null}{
  const ids=new Set(inbox.items.map(item=>item.id));
  const tasks=inbox.tasks.needsYou.filter(task=>ids.has(task.id))
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return {count:inbox.items.length,newestTask:tasks[0]??null};
}
/** The inbox for a server-verified café (morning brief, WhatsApp alerts). Read-only. */
export async function readCafeNeedsYou(scope:InboxScope,locale:"en"|"es"|"ar"="en"){
  return needsYouSummary(await readInbox({scope,locale}));
}
