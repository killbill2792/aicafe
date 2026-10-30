import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { AgentAvatar, agentVisuals } from "@/components/operations/AITeamCard";
import TeamInbox, { type TeamInboxCard, type TeamInboxCopy } from "@/components/operations/TeamInbox";
import { INBOX_STATUSES, parseInboxStatus } from "@/lib/viewmodels/teamInboxSelection";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { readPersistedOperatingTasks, syncAndGetOperatingTasks } from "@/lib/data/operatingTasks";
import { buildOperationsTeamViewModel, needsYouFromAttention, projectOperatingTasks, type NeedsYouItem } from "@/lib/viewmodels/operationsTeam";
import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
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
const isNeed = (row: OperatingTask | NeedsYouItem): row is NeedsYouItem => "displayTitle" in row;

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ agent?: string; status?: string; task?: string; period?: string }> }) {
  await requireOwnBusiness();
  const [{ agent, status, task, period: periodParam }, snapshot, menu, t, tCategories, tRules, tExperiment, tBrief, tGoals, tStaffRules, ownerCanSubscribe] = await Promise.all([
    searchParams, getSnapshot(), getMenuControlCenter(), getTranslations("Operations"), getTranslations("Categories"),
    getTranslations("TeamRules"), getTranslations("SupervisorExperiment"), getTranslations("DailyBrief"), getTranslations("Goals"),
    getTranslations("StaffSchedule"), authenticatedConversationContext().then(() => true).catch(() => false)]);
  const derived = buildOperationsTeamViewModel(snapshot, menu);
  const derivedTasks = [...derived.needsYou, ...derived.handled, ...derived.watching];
  // "Needs you" is the same shared attention list Home counts, for the period Home showed.
  const period = parsePeriod(periodParam);
  const [tasks, attention] = await Promise.all([
    syncAndGetOperatingTasks(derivedTasks).then((result) => result.tasks).catch(async () => {
      // Saving refreshed tasks is housekeeping; a failed save must not take the inbox down.
      console.error("operations.task_sync_failed");
      const stored = await readPersistedOperatingTasks(snapshot.business.id);
      const storedIds = new Set(stored.map((row) => row.id));
      return [...stored, ...derivedTasks.filter((row) => !storedIds.has(row.id))];
    }),
    getAttentionItems({ period, menu }),
  ]);
  const team = projectOperatingTasks(tasks);
  const needs = needsYouFromAttention(attention, team.needsYou);
  const tops = topChatStartItems(attention);
  const names: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const roles: Record<AgentId, string> = { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") };
  const rows = { needs_you: needs.rows, handled: team.handled, watching: team.watching };
  // Query IDs are in-page presentation hints, never selectors for a database read.
  const selectedAgent = parseAgentId(agent);
  const selectedStatus = parseInboxStatus(status);
  const selectedTaskId = selectedInboxTaskId(rows[selectedStatus].filter((row) => !selectedAgent || row.agentId === selectedAgent), task);
  const members = team.members.map((member) => ({ ...member, attentionCount: needs.counts[member.agentId] }));
  const byAgent = <T,>(value: (agentId: AgentId) => T) => ({ alex: value("alex"), olivia: value("olivia"), maya: value("maya"), leo: value("leo") });
  const cards: TeamInboxCard[] = INBOX_STATUSES.flatMap((value) => rows[value].map((row) => ({ id: row.id, agentId: row.agentId, status: value,
    node: <TaskCard row={row} names={names} t={t} tExperiment={tExperiment} tBrief={tBrief} tGoals={tGoals}
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
      staffRulesLink={<Link href="/staff/rules" className="flex min-h-12 items-center self-start rounded-xl border border-line px-4 text-accent-text underline">{tStaffRules("rulesCard")}</Link>}
      footer={<>
        {ownerCanSubscribe && <OwnerWhatsAppAlerts copy={{
          title: t("whatsAppAlertsTitle"), description: t("whatsAppAlertsDescription"),
          enable: t("whatsAppAlertsEnable"), disable: t("whatsAppAlertsDisable"),
          loading: t("whatsAppAlertsLoading"), saved: t("whatsAppAlertsSaved"),
          error: t("whatsAppAlertsError"), verifiedPhone: t("whatsAppAlertsPhone"),
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
  if ((task.kind === "daily_brief" || task.kind === "goal_report" || task.kind === "goal_checkin") && typeof task.payload.threadId === "string")
    return "/?thread=" + encodeURIComponent(task.payload.threadId);
  return "/more/uploads/ingredients";
}

function TaskCard({ row: task, names, t, tExperiment, tBrief, tGoals, category, selectedTaskId }: { row: OperatingTask | NeedsYouItem; names: Record<AgentId, string>; t: Awaited<ReturnType<typeof getTranslations<"Operations">>>; tExperiment: Awaited<ReturnType<typeof getTranslations<"SupervisorExperiment">>>; tBrief: Awaited<ReturnType<typeof getTranslations<"DailyBrief">>>; tGoals: Awaited<ReturnType<typeof getTranslations<"Goals">>>; category: (code: string) => string; selectedTaskId: string|null }) {
  {
    const visual = agentVisuals[task.agentId];
    if (isNeed(task)) return <NeedCard item={task} name={names[task.agentId]} selected={task.id === selectedTaskId} />;
    const price = task.kind === "price_review";
    const experiment=task.kind==="price_experiment_report";
    const midRun=experiment&&task.payload.midRun===true;
    const itemName = String(task.payload.itemName).replace(" · ", " ");
    const direction = price ? priceReviewDirection(Number(task.payload.currentPriceCents), Number(task.payload.suggestedPriceCents)) : null;
    const brief = task.kind === "daily_brief";
    const goalReport = task.kind === "goal_report";
    const goalCheckin = task.kind === "goal_checkin";
    const goalTitle = String(task.payload.goalTitle ?? task.payload.itemName ?? "");
    const title = goalCheckin ? tGoals("taskCheckinTitle", { question: String(task.payload.question ?? "") }) : goalReport ? tGoals(task.payload.midRun === true ? "taskMidRunTitle" : "taskTitle", { title: goalTitle }) : brief ? tBrief("taskTitle") : experiment ? tExperiment(midRun?"midRunTask":"reportTask",{item:String(task.payload.itemName??"")}) : price ? t(direction === "low" ? "priceTaskSentenceLow" : "priceTaskSentenceHigh", { item: itemName }) : task.kind === "data_quality" ? t("missingCategory", { category: category(String(task.payload.categoryCode)) }) : task.kind === "staff_coverage" ? t("staffTaskNamed", { issue: String(task.payload.issue ?? task.payload.requestType ?? t("staffCoverageIssue")) }) : t("mayaWatching");
    const detail = goalCheckin ? goalTitle : goalReport || brief ? String(task.payload.text ?? "") : experiment ? tExperiment(midRun?"midRunDetail":"reportDetail") : price ? t("priceTaskReason") : task.kind === "data_quality" ? t("addCategoryPrompt", { category: category(String(task.payload.categoryCode)) }) : task.kind === "supply_check" ? t("supplySignal") : t("staffTaskReason");
    const action = goalCheckin ? tGoals("taskCheckinAction") : goalReport ? tGoals("taskAction") : brief ? tBrief("taskAction") : experiment ? tExperiment("reportAction") : price ? t("reviewItem", { item: String(task.payload.itemName).split(" · ")[0] }) : task.kind === "staff_coverage" ? t("openStaff") : task.kind === "data_quality" ? t("openBills") : t("openIngredientCosts");
    const selected=task.id===selectedTaskId;
    return <article id={selected?"selected-task":undefined} tabIndex={selected?-1:undefined}
      data-selected-task={selected?"true":undefined}
      data-entity-type={task.entityType} data-entity-id={task.entityId}
      className={`scroll-mt-24 rounded-card-lg border-s-4 p-[18px] ${visual.border} ${visual.softSurface} ${selected?"ring-4 ring-ink shadow-lg":""}`}>
      <div className="flex items-center gap-2"><AgentAvatar agentId={task.agentId} size="task"/><p className={`font-bold ${visual.accent}`}>{names[task.agentId]} · AI</p>{task.payload.pricingIsEstimate === true && <span className="ms-auto"><EstimatePill label={t("estimate")} /></span>}</div>
      <h2 className="mt-3 text-lg font-bold text-ink">{title}</h2><p className="mt-1 text-[17px] font-semibold text-ink">{detail}</p>{price && <p className="mt-1 text-sm text-ink-muted">{t("priceNumbers", { current: formatCents(Number(task.payload.currentPriceCents)), suggested: formatCents(Number(task.payload.suggestedPriceCents)) })}</p>}
      {task.kind==="price_experiment_report"&&<div className="mt-3 space-y-2 text-[17px]">
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
      <Link href={taskHref(task)} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-accent px-4 text-center font-bold text-on-accent no-underline">{action}</Link>
      {price && task.status === "needs_owner" && <PriceReviewActions taskId={task.id} keepLabel={t("keepCurrent")} laterLabel={t("later")} snoozeLabels={{ seven: t("remind7"), thirty: t("remind30"), change: t("remindChange") }} cancelLabel={t("cancel")} errorLabel={t("decisionError")} />}
      {experiment && task.status === "needs_owner" && <ExperimentReportActions taskId={task.id} acknowledgeLabel={tExperiment("reportAcknowledge")} errorLabel={tExperiment("reportAcknowledgeError")} />}
    </article>;
  }
}

/** A shared attention item that is not a stored task (missing bill, unmatched items, alert…). */
function NeedCard({ item, name, selected }: { item: NeedsYouItem; name: string; selected: boolean }) {
  const visual = agentVisuals[item.agentId];
  const action = "mt-3 flex min-h-12 items-center justify-center rounded-full bg-accent px-4 text-center font-bold text-on-accent no-underline";
  // The shared reader only returns relative links; OAuth setup needs a real navigation.
  return <article id={selected ? "selected-task" : undefined} tabIndex={selected ? -1 : undefined}
    data-selected-task={selected ? "true" : undefined} data-attention-id={item.id}
    className={`scroll-mt-24 rounded-card-lg border-s-4 p-[18px] ${visual.border} ${visual.softSurface} ${selected ? "ring-4 ring-ink shadow-lg" : ""}`}>
    <div className="flex items-center gap-2"><AgentAvatar agentId={item.agentId} size="task" /><p className={`font-bold ${visual.accent}`}>{name} · AI</p></div>
    <h2 className="mt-3 text-lg font-bold text-ink" dir="auto">{item.displayTitle}</h2>
    {item.href.startsWith("/api/")
      ? <a href={item.href} className={action}>{item.actionLabel}</a>
      : <Link href={item.href} className={action}>{item.actionLabel}</Link>}
  </article>;
}
