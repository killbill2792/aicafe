import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { AgentAvatar, agentVisuals } from "@/components/operations/AITeamCard";
import TeamInbox, { type TeamInboxCard, type TeamInboxCopy } from "@/components/operations/TeamInbox";
import { INBOX_STATUSES, parseInboxStatus } from "@/lib/viewmodels/teamInboxSelection";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { needsYouFromAttention, projectOperatingTasks, type NeedsYouItem } from "@/lib/viewmodels/operationsTeam";
import { readInbox, type AttentionItem } from "@/lib/attention/getAttentionItems.server";
import { ageInDays, formatInboxDay, isEventReport, taskSubjectDate } from "@/lib/operating/inboxLifecycle";
import { formatCafeCurrency } from "@/lib/format/cafeCurrency";
import { topChatStartItems } from "@/components/home/chatStartAttention";
import type { Period } from "@/lib/viewmodels/period";
import { formatCents } from "@/lib/calc";
import { selectedInboxTaskId } from "@/lib/viewmodels/selectedInboxTask";
import { parseAgentId, type AgentId, type OperatingTask } from "@/lib/operating/tasks";
import type { ExpenseCategoryCode } from "@/lib/constants";
import PriceReviewActions from "@/components/operations/PriceReviewActions";
import ExperimentReportActions from "@/components/operations/ExperimentReportActions";
import OwnerWhatsAppAlerts from "@/components/operations/OwnerWhatsAppAlerts";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { priceReviewDirection, priceReviewHref } from "@/lib/viewmodels/priceReviewTask";
import {staffScheduleHref} from "@/lib/scheduling/staffScheduleLinks";

export const dynamic = "force-dynamic";
const parsePeriod = (value?: string): Period => value === "week" || value === "month" ? value : "today";
type ExpiredNeed = AttentionItem & { expired: true };
const isNeed = (row: OperatingTask | NeedsYouItem | ExpiredNeed): row is NeedsYouItem | ExpiredNeed => "displayTitle" in row;
type CardMeta = { today: string; locale: string; currency: string | null };
type OperationsT = Awaited<ReturnType<typeof getTranslations<"Operations">>>;

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ agent?: string; status?: string; task?: string; period?: string }> }) {
  await requireOwnBusiness();
  const [{ agent, status, task, period: periodParam }, t, tCategories, tRules, tExperiment, tBrief, tGoals, tStaffRules, locale, ownerCanSubscribe] = await Promise.all([
    searchParams, getTranslations("Operations"), getTranslations("Categories"),
    getTranslations("TeamRules"), getTranslations("SupervisorExperiment"), getTranslations("DailyBrief"), getTranslations("Goals"),
    getTranslations("StaffSchedule"), getLocale(), authenticatedConversationContext().then(() => true).catch(() => false)]);
  // "Needs you" is the same shared attention list Home counts, for the period Home showed.
  // The page only reads: the inbox lifecycle runs in memory and nothing is written on load.
  const period = parsePeriod(periodParam);
  const [snapshot, menu] = await Promise.all([getSnapshot(period), getMenuControlCenter()]);
  const inbox = await readInbox({ period, menu, snapshot });
  const team = projectOperatingTasks([...inbox.tasks.needsYou, ...inbox.tasks.watching, ...inbox.tasks.handled]);
  const needs = needsYouFromAttention(inbox.items, team.needsYou);
  const meta: CardMeta = { today: snapshot.todayDateStr, locale, currency: snapshot.business.currency ?? null };
  const tops = topChatStartItems(inbox.items);
  const names: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const roles: Record<AgentId, string> = { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") };
  const expiredAlerts = inbox.expiredAlerts.map((item): ExpiredNeed => ({ ...item, expired: true }));
  const rows = { needs_you: needs.rows, handled: [...team.handled, ...expiredAlerts], watching: team.watching };
  // Query IDs are in-page presentation hints, never selectors for a database read.
  const selectedAgent = parseAgentId(agent);
  const selectedStatus = parseInboxStatus(status);
  const selectedTaskId = selectedInboxTaskId(rows[selectedStatus].filter((row) => !selectedAgent || row.agentId === selectedAgent), task);
  const members = team.members.map((member) => ({ ...member, attentionCount: needs.counts[member.agentId] }));
  const byAgent = <T,>(value: (agentId: AgentId) => T) => ({ alex: value("alex"), olivia: value("olivia"), maya: value("maya"), leo: value("leo") });
  const cards: TeamInboxCard[] = INBOX_STATUSES.flatMap((value) => rows[value].map((row) => ({ id: row.id, agentId: row.agentId, status: value,
    node: <TaskCard row={row} names={names} t={t} tExperiment={tExperiment} tBrief={tBrief} tGoals={tGoals} meta={meta}
      category={(code) => tCategories(code as ExpenseCategoryCode)} selectedTaskId={selectedTaskId} /> })));
  const copy: TeamInboxCopy = {
    eyebrow: t("eyebrow"), title: t("title"), intro: t("intro"),
    focusedOn: byAgent((agentId) => t("focusedOn", { name: names[agentId], role: roles[agentId] })),
    team: { title: t("teamTitle"), aiLabel: t("aiLabel"), brandLabel: t("brandLabel"), names, roles,
      status: byAgent((agentId) => t("attention", { count: needs.counts[agentId] })),
      need: byAgent((agentId) => tops[agentId]?.displayTitle ?? null) },
    statusLabels: { needs_you: t("needsYou"), handled: t("handled"), watching: t("watching") }, navLabel: t("inboxStatusLabel"),
    empty: { needs_you: t("needsYouEmpty"), handled: t("handledEmpty"), watching: t("watchingEmpty") },
    rules: ownerCanSubscribe ? { title: tRules("title"), intro: tRules("intro"),
      heading: { ...byAgent((agentId) => tRules(agentId)), supervisor: tRules("supervisor") },
      manager: {
        agent:tRules("agent"),instruction:tRules("instruction"),instructionHint:tRules("instructionHint"),
        saveDraft:tRules("saveDraft"),addRule:tRules("addRule"),editAsDraft:tRules("editAsDraft"),
        editNotice:tRules("editNotice"),rules:tRules("rules"),audit:tRules("audit"),
        recentChanges:tRules("recentChanges"),emptyRules:tRules("emptyRules"),emptyAudit:tRules("emptyAudit"),
        approve:tRules("approve"),reject:tRules("reject"),pause:tRules("pause"),resume:tRules("resume"),
        draft:tRules("draft"),active:tRules("active"),paused:tRules("paused"),rejected:tRules("rejected"),
        warning:tRules("warning"),loading:tRules("loading"),saving:tRules("saving"),error:tRules("error"),
        conflict:tRules("conflict"),loadMore:tRules("loadMore"),by:tRules("by"),
        created:tRules("created"),to:tRules("to"),supervisor:tRules("supervisor"),
        alex:tRules("alex"),olivia:tRules("olivia"),maya:tRules("maya"),leo:tRules("leo"),
      } } : null,
    transportUnavailable: t("transportUnavailable"),
  };

  return <PageShell className="flex flex-col gap-3.5 px-4 pb-28 pt-6">
    <TeamInbox members={members} cards={cards} copy={copy}
      staffRulesLink={<div className="flex flex-wrap gap-2">
        <Link href="/operations/experiments" className="flex min-h-12 items-center self-start rounded-xl border border-ink bg-card px-4 font-bold text-ink no-underline">{t("experimentsLink")} →</Link>
        <Link href="/staff/rules" className="flex min-h-12 items-center self-start rounded-xl border border-line px-4 text-accent-text underline">{tStaffRules("rulesCard")}</Link>
      </div>}
      footer={<>
        {ownerCanSubscribe && <OwnerWhatsAppAlerts copy={{
          title: t("whatsAppAlertsTitle"), description: t("whatsAppAlertsDescription"),
          loading: t("whatsAppAlertsLoading"), saved: t("whatsAppAlertsSaved"),
          error: t("whatsAppAlertsError"), verifiedPhone: t("whatsAppAlertsPhone"),
          phoneLabel: t("whatsAppPhoneLabel"), sendCode: t("whatsAppSendCode"),
          codeLabel: t("whatsAppCodeLabel"), confirmCode: t("whatsAppConfirmCode"),
          codeSent: t("whatsAppCodeSent"), threadLabel: t("whatsAppThreadLabel"),
          connect: t("whatsAppConnect"), disconnect: t("whatsAppDisconnect"),
          consent: t("whatsAppConsent"), connected: t("whatsAppConnected"),
          noThreads: t("whatsAppNoThreads"), phoneChanged: t("whatsAppPhoneChanged"),
        }}/>}
        <Link href="/operations/suppliers"
          className="flex min-h-12 items-center justify-center self-start rounded-full border border-ink bg-card px-5 text-[17px] font-bold text-ink no-underline">
          {t("supplierSourcesLink")} →
        </Link>
      </>} />
  </PageShell>;
}

function taskHref(task: OperatingTask): string {
  if(task.kind==="price_experiment_report"){
    const threadId=task.payload.threadId,proposalId=task.payload.proposalId;
    if(typeof threadId==="string"&&typeof proposalId==="string")
      return "/?thread="+encodeURIComponent(threadId)+"&experiment="+encodeURIComponent(proposalId);
    return "/operations?agent=alex&status=needs_you&task="+encodeURIComponent(task.id);
  }
  if (task.kind === "price_review" && task.entityId) return priceReviewHref(task.entityId);
  if (task.kind === "staff_coverage") {
    const shiftDate=task.payload.shiftDate??task.payload.businessDate;
    return staffScheduleHref({employee:task.entityId,date:typeof shiftDate==="string"?shiftDate:undefined});
  }
  if (task.kind === "data_quality") return missingCostDestination(String(task.payload.categoryCode) as ExpenseCategoryCode);
  if (task.kind === "money_update") return "/more/bills";
  if ((task.kind === "daily_brief" || task.kind === "goal_report" || task.kind === "goal_checkin" || task.kind === "event_plan" || task.kind === "event_change") && typeof task.payload.threadId === "string")
    return "/?thread=" + encodeURIComponent(task.payload.threadId);
  if (task.kind === "supply_check") return "/more/uploads/ingredients";
  return "/operations";
}

/** Date, age, status and the key number: the same line on every card. */
function MetaLine({ t, meta, subjectDate, createdAt, status, expiredReason, keyNumber }: { t: OperationsT; meta: CardMeta;
  subjectDate: string | null; createdAt: string | null; status: OperatingTask["status"] | "needs_you"; expiredReason?: unknown; keyNumber?: string | null }) {
  const statusText = status === "expired"
    ? t("cardExpired", { reason: t(expiredReason === "superseded" ? "expiredSuperseded" : expiredReason === "old" ? "expiredOld" : "expiredPastDay") })
    : status === "handled" ? t("cardHandled") : status === "watching" ? t("cardWatching") : t("cardNeedsYou");
  const parts = [
    subjectDate ? t("cardSubjectDay", { day: formatInboxDay(subjectDate, meta.locale) }) : null,
    createdAt ? t("cardAge", { days: ageInDays(createdAt, meta.today) }) : null,
    statusText,
  ].filter((part): part is string => Boolean(part));
  return <div className="mt-2 flex flex-col gap-1">
    <p className="text-[17px] text-ink-muted" data-card-meta>{parts.join(" · ")}</p>
    {keyNumber && <p className="text-[17px] font-bold text-ink" data-card-number>{keyNumber}</p>}
  </div>;
}

/** The key number of a stored task, when it has one. Unknown is never shown as zero. */
function taskKeyNumber(task: OperatingTask, t: OperationsT, meta: CardMeta): string | null {
  const money = (cents: number) => formatCafeCurrency(cents, meta.locale, meta.currency).text;
  const p = task.payload;
  if (task.kind === "price_review" && typeof p.currentPriceCents === "number" && typeof p.suggestedPriceCents === "number")
    return t("priceNumbers", { current: money(p.currentPriceCents), suggested: money(p.suggestedPriceCents) });
  if (typeof p.changePercent === "number") return t("cardSalesVsUsual", { pct: p.changePercent });
  if (typeof p.impactCents === "number") return t("cardImpact", { amount: money(p.impactCents) });
  if (typeof p.estimatedAmountCents === "number") return t("cardImpact", { amount: money(p.estimatedAmountCents) });
  return null;
}

/** First plain line of a stored report text (markdown emphasis removed); never rewritten. */
function firstLine(text: unknown): string {
  return typeof text === "string" ? (text.split("\n").map((line) => line.replace(/\*\*/g, "").trim()).find(Boolean) ?? "") : "";
}

function TaskCard({ row: task, names, t, tExperiment, tBrief, tGoals, category, selectedTaskId, meta }: { row: OperatingTask | NeedsYouItem | ExpiredNeed; names: Record<AgentId, string>; t: OperationsT; tExperiment: Awaited<ReturnType<typeof getTranslations<"SupervisorExperiment">>>; tBrief: Awaited<ReturnType<typeof getTranslations<"DailyBrief">>>; tGoals: Awaited<ReturnType<typeof getTranslations<"Goals">>>; category: (code: string) => string; selectedTaskId: string|null; meta: CardMeta }) {
  const visual = agentVisuals[task.agentId];
  if (isNeed(task)) return <NeedCard item={task} name={names[task.agentId]} selected={task.id === selectedTaskId} t={t} meta={meta} />;
  const price = task.kind === "price_review";
  const experiment = task.kind === "price_experiment_report";
  const midRun = task.payload.midRun === true;
  const itemName = String(task.payload.itemName ?? "").replace(" · ", " ");
  const direction = price ? priceReviewDirection(Number(task.payload.currentPriceCents), Number(task.payload.suggestedPriceCents)) : null;
  const subjectDate = taskSubjectDate(task);
  const day = subjectDate ? formatInboxDay(subjectDate, meta.locale) : "";
  const eventReport = isEventReport(task);
  const goalTitle = String(task.payload.goalTitle ?? task.payload.itemName ?? "");
  // Each kind has its own title and reason. There is no shared fallback text.
  const copy = ((): { title: string; detail: string; action: string } => {
    switch (task.kind) {
      case "goal_checkin": return { title: tGoals("taskCheckinTitle", { question: String(task.payload.question ?? "") }), detail: goalTitle, action: tGoals("taskCheckinAction") };
      case "goal_report": return { title: tGoals(midRun ? "taskMidRunTitle" : "taskTitle", { title: goalTitle }), detail: String(task.payload.text ?? ""), action: tGoals("taskAction") };
      case "daily_brief": return { title: t("briefTaskTitle", { day }), detail: String(task.payload.text ?? ""), action: tBrief("taskAction") };
      case "price_experiment_report": return { title: tExperiment(midRun ? "midRunTask" : "reportTask", { item: itemName }), detail: tExperiment(midRun ? "midRunDetail" : "reportDetail"), action: tExperiment("reportAction") };
      case "price_review": return { title: t(direction === "low" ? "priceTaskSentenceLow" : "priceTaskSentenceHigh", { item: itemName }), detail: t("priceTaskReason"), action: t("reviewItem", { item: String(task.payload.itemName).split(" · ")[0] }) };
      case "data_quality": return { title: t("missingCategory", { category: category(String(task.payload.categoryCode)) }), detail: t("addCategoryPrompt", { category: category(String(task.payload.categoryCode)) }), action: t("openBills") };
      case "staff_coverage": return { title: t("staffTaskNamed", { issue: String(task.payload.issue ?? task.payload.requestType ?? t("staffCoverageIssue")) }), detail: t("staffTaskReason"), action: t("openStaff") };
      case "supply_check": return { title: t("mayaWatching"), detail: t("supplySignal"), action: t("openIngredientCosts") };
      case "money_update": return { title: t("homeMoneyUpdate"), detail: "", action: t("openBills") };
      case "event_change": return { title: t("eventChangeReview", { event: String(task.payload.eventName ?? "") }), detail: t("eventChangeDetail"), action: t("eventChangeReviewAction") };
      case "event_plan":
        if (midRun) return { title: t("eventNoteTitle", { day }), detail: String(task.payload.note ?? ""), action: t("openEventThread") };
        if (eventReport) return { title: t("eventReportTask", { date: day }), detail: firstLine(task.payload.text), action: t("openEventThread") };
        return { title: t("eventPlanReview", { date: day }), detail: t("eventPlanDetail"), action: t("openEventThread") };
    }
  })();
  const selected = task.id === selectedTaskId;
  return <article id={selected?"selected-task":undefined} tabIndex={selected?-1:undefined}
    data-selected-task={selected?"true":undefined} data-task-kind={task.kind} data-task-status={task.status}
    data-entity-type={task.entityType} data-entity-id={task.entityId}
    className={`scroll-mt-24 rounded-card-lg border-s-4 p-[18px] ${visual.border} ${visual.softSurface} ${selected?"ring-4 ring-ink shadow-lg":""}`}>
    <div className="flex items-center gap-2"><AgentAvatar agentId={task.agentId} size="task"/><p className={`font-bold ${visual.accent}`}>{names[task.agentId]} · AI</p>{task.payload.pricingIsEstimate === true && <span className="ms-auto"><EstimatePill label={t("estimate")} /></span>}</div>
    <h2 className="mt-3 text-lg font-bold text-ink" dir="auto">{copy.title}</h2>
    {copy.detail && <p className="mt-1 text-[17px] font-semibold text-ink" dir="auto">{copy.detail}</p>}
    <MetaLine t={t} meta={meta} subjectDate={subjectDate} createdAt={task.createdAt} status={task.status}
      expiredReason={task.payload.expiredReason} keyNumber={experiment ? null : taskKeyNumber(task, t, meta)} />
    {experiment&&<div className="mt-3 space-y-2 text-[17px]">
      <p>{tExperiment("reportRevenue",{value:typeof task.payload.observedRevenueCents==="number"?
        formatCents(task.payload.observedRevenueCents):tExperiment("notAvailable")})}</p>
      <p>{tExperiment("reportDifference",{value:typeof task.payload.realizedRevenueDifferenceCents==="number"?
        formatCents(task.payload.realizedRevenueDifferenceCents):tExperiment("notAvailable")})}</p>
      {task.payload.ordersGuardrail==="broken"&&typeof task.payload.ordersChangePct==="number"&&
        <p className="font-semibold text-ink">{tExperiment("guardrailTask",{change:Math.abs(task.payload.ordersChangePct)})}</p>}
      {!midRun&&<p className="font-semibold">{tExperiment("recommendation",{choice:tExperiment(
        task.payload.recommendation==="keep"?"keep":task.payload.recommendation==="revert"?"revert":"adjust")})}</p>}
      {!midRun&&<p className="text-ink-muted">{tExperiment(task.payload.outcomeStatus==="complete"?"reportCompletedCaveat":"reportUncertain")}</p>}
    </div>}
    <Link href={taskHref(task)} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-accent px-4 text-center font-bold text-on-accent no-underline">{copy.action}</Link>
    {price && task.status === "needs_owner" && <PriceReviewActions taskId={task.id} keepLabel={t("keepCurrent")} laterLabel={t("later")} snoozeLabels={{ seven: t("remind7"), thirty: t("remind30"), change: t("remindChange") }} cancelLabel={t("cancel")} errorLabel={t("decisionError")} />}
    {experiment && task.status === "needs_owner" && <ExperimentReportActions taskId={task.id} acknowledgeLabel={tExperiment("reportAcknowledge")} errorLabel={tExperiment("reportAcknowledgeError")} />}
  </article>;
}

/** A shared attention item that is not a stored task (missing bill, unmatched items, alert…). */
function NeedCard({ item, name, selected, t, meta }: { item: NeedsYouItem | ExpiredNeed; name: string; selected: boolean; t: OperationsT; meta: CardMeta }) {
  const visual = agentVisuals[item.agentId];
  const expired = "expired" in item;
  const action = "mt-3 flex min-h-12 items-center justify-center rounded-full bg-accent px-4 text-center font-bold text-on-accent no-underline";
  const impact = typeof item.impactCents === "number" ? t("cardImpact", { amount: formatCafeCurrency(item.impactCents, meta.locale, meta.currency).text }) : null;
  // The shared reader only returns relative links; OAuth setup needs a real navigation.
  return <article id={selected ? "selected-task" : undefined} tabIndex={selected ? -1 : undefined}
    data-selected-task={selected ? "true" : undefined} data-attention-id={item.id}
    className={`scroll-mt-24 rounded-card-lg border-s-4 p-[18px] ${visual.border} ${visual.softSurface} ${selected ? "ring-4 ring-ink shadow-lg" : ""}`}>
    <div className="flex items-center gap-2"><AgentAvatar agentId={item.agentId} size="task" /><p className={`font-bold ${visual.accent}`}>{name} · AI</p></div>
    <h2 className="mt-3 text-lg font-bold text-ink" dir="auto">{item.displayTitle}</h2>
    <MetaLine t={t} meta={meta} subjectDate={item.subjectDate ?? null}
      createdAt={item.createdAt ?? null} status={expired ? "expired" : "needs_you"}
      expiredReason="past_day" keyNumber={impact} />
    {!expired && (item.href.startsWith("/api/")
      ? <a href={item.href} className={action}>{item.actionLabel}</a>
      : <Link href={item.href} className={action}>{item.actionLabel}</Link>)}
  </article>;
}
