import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import AITeamCard, { AgentAvatar, agentVisuals } from "@/components/operations/AITeamCard";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { syncAndGetOperatingTasks } from "@/lib/data/operatingTasks";
import { buildOperationsTeamViewModel, projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import { formatCents } from "@/lib/calc";
import { selectedInboxTaskId } from "@/lib/viewmodels/selectedInboxTask";
import { parseAgentId, type AgentId, type OperatingTask } from "@/lib/operating/tasks";
import type { ExpenseCategoryCode } from "@/lib/constants";
import PriceReviewActions from "@/components/operations/PriceReviewActions";
import TeamRulesManager from "@/components/operations/TeamRulesManager";
import OwnerWhatsAppAlerts from "@/components/operations/OwnerWhatsAppAlerts";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";
import { priceReviewDirection, priceReviewHref } from "@/lib/viewmodels/priceReviewTask";

export const dynamic = "force-dynamic";
type InboxStatus = "needs_you" | "handled" | "watching";
const parseStatus = (value?: string): InboxStatus => value === "handled" || value === "watching" ? value : "needs_you";

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ agent?: string; status?: string; task?: string }> }) {
  await requireOwnBusiness();
  const [{ agent, status, task }, snapshot, menu, t, tCategories, tRules, tExperiment] = await Promise.all([searchParams, getSnapshot(), getMenuControlCenter(), getTranslations("Operations"), getTranslations("Categories"), getTranslations("TeamRules"), getTranslations("SupervisorExperiment")]);
  const derived = buildOperationsTeamViewModel(snapshot, menu);
  const persisted = await syncAndGetOperatingTasks([...derived.needsYou, ...derived.handled, ...derived.watching]);
  const team = projectOperatingTasks(persisted.tasks);
  const selectedAgent = parseAgentId(agent);
  const selectedStatus = parseStatus(status);
  const statusQuery = status === "needs_you" || status === "handled" || status === "watching" ? status : undefined;
  const ownerCanSubscribe = await authenticatedConversationContext().then(() => true).catch(() => false);
  const names: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const scoped = (tasks: OperatingTask[]) => selectedAgent ? tasks.filter((task) => task.agentId === selectedAgent) : tasks;
  const lists = { needs_you: scoped(team.needsYou), handled: scoped(team.handled), watching: scoped(team.watching) };
  // Query IDs are in-page presentation hints, never selectors for a database read.
  const selectedTaskId=selectedInboxTaskId(lists[selectedStatus],task);
  const copy = { title: t("teamTitle"), aiLabel: t("aiLabel"), brandLabel: t("brandLabel"), names, roles: { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") }, status: (member: (typeof team.members)[number]) => member.statusKey === "prices" ? t("prices", { count: member.attentionCount }) : member.statusKey === "attention" ? t("attention", { count: member.attentionCount }) : member.statusKey === "coverage_clear" ? t("coverageClear") : t("supplies") };

  return <PageShell className="flex flex-col gap-3.5 px-4 pb-28 pt-6">
    <header><p className="text-sm font-semibold text-ink-muted">{t("eyebrow")}</p><h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1><p className="mt-1 text-[17px] text-ink-muted">{selectedAgent ? t("focusedOn", { name: names[selectedAgent], role: copy.roles[selectedAgent] }) : t("intro")}</p></header>
    <AITeamCard team={team} copy={copy} selectedAgent={selectedAgent} selectedStatus={statusQuery} />

    {ownerCanSubscribe && <section id="team-rules" className="flex flex-col gap-3" aria-labelledby="selected-agent-rules">
      <div className="flex items-center gap-3 px-1">
        {selectedAgent && <AgentAvatar agentId={selectedAgent} size="task" />}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-muted">{tRules("title")}</p>
          <h2 id="selected-agent-rules" className="truncate font-headline text-2xl font-bold text-ink">
            {selectedAgent ? tRules(selectedAgent) : tRules("supervisor")}
          </h2>
          <p className="mt-1 text-[17px] text-ink-muted">{tRules("intro")}</p>
        </div>
      </div>
      <TeamRulesManager selectedAgent={selectedAgent ?? "supervisor"} copy={{
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
      }}/>
    </section>}
    <nav className="grid grid-cols-3 gap-1 rounded-2xl bg-card p-1" aria-label={t("inboxStatusLabel")}>
      {(["needs_you", "handled", "watching"] as const).map((value) => <Link key={value} href={{ pathname: "/operations", query: { ...(selectedAgent ? { agent: selectedAgent } : {}), status: value } }} aria-current={selectedStatus === value ? "page" : undefined} className={`flex min-h-12 items-center justify-center rounded-xl px-2 text-center text-sm font-bold no-underline ${selectedStatus === value ? "bg-ink text-paper" : "text-ink-muted"}`}>{t(value === "needs_you" ? "needsYou" : value)} {lists[value].length}</Link>)}
    </nav>
    <TaskList tasks={lists[selectedStatus]} empty={t(selectedStatus === "needs_you" ? "needsYouEmpty" : selectedStatus === "handled" ? "handledEmpty" : "watchingEmpty")} names={names} t={t} tExperiment={tExperiment} category={(code) => tCategories(code as ExpenseCategoryCode)} selectedTaskId={selectedTaskId} />
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
    {(!selectedAgent || selectedAgent === "olivia") && <p className="rounded-2xl bg-paper p-3 text-sm text-ink-muted">{t("transportUnavailable")}</p>}
  </PageShell>;
}

function taskHref(task: OperatingTask): string {
  if (task.kind === "price_experiment_report") return "/operations?agent=alex&status=needs_you&task="+encodeURIComponent(task.id);
  if (task.kind === "price_review" && task.entityId) return priceReviewHref(task.entityId);
  if (task.kind === "staff_coverage") {
    const query = new URLSearchParams();
    if (task.entityId) query.set("employee", task.entityId);
    if (typeof task.payload.businessDate === "string") query.set("date", task.payload.businessDate);
    return `/more/manage-staff${query.size ? `?${query}` : ""}`;
  }
  if (task.kind === "data_quality") return missingCostDestination(String(task.payload.categoryCode) as ExpenseCategoryCode);
  if (task.kind === "money_update") return "/more/bills";
  return "/more/uploads/ingredients";
}

function TaskList({ tasks, empty, names, t, tExperiment, category, selectedTaskId }: { tasks: OperatingTask[]; empty: string; names: Record<AgentId, string>; t: Awaited<ReturnType<typeof getTranslations<"Operations">>>; tExperiment: Awaited<ReturnType<typeof getTranslations<"SupervisorExperiment">>>; category: (code: string) => string; selectedTaskId: string|null }) {
  if (tasks.length === 0) return <section className="rounded-card-lg bg-card p-[18px]"><p className="text-[17px] text-ink-muted">{empty}</p></section>;
  return <section className="flex flex-col gap-3">{tasks.map((task) => {
    const visual = agentVisuals[task.agentId];
    const price = task.kind === "price_review";
    const experiment=task.kind==="price_experiment_report";
    const itemName = String(task.payload.itemName).replace(" · ", " ");
    const direction = price ? priceReviewDirection(Number(task.payload.currentPriceCents), Number(task.payload.suggestedPriceCents)) : null;
    const title = experiment ? tExperiment("reportTask",{item:String(task.payload.itemName??"")}) : price ? t(direction === "low" ? "priceTaskSentenceLow" : "priceTaskSentenceHigh", { item: itemName }) : task.kind === "data_quality" ? t("missingCategory", { category: category(String(task.payload.categoryCode)) }) : task.kind === "staff_coverage" ? t("staffTaskNamed", { issue: String(task.payload.issue ?? task.payload.requestType ?? t("staffCoverageIssue")) }) : t("mayaWatching");
    const detail = experiment ? tExperiment("reportDetail") : price ? t("priceTaskReason") : task.kind === "data_quality" ? t("addCategoryPrompt", { category: category(String(task.payload.categoryCode)) }) : task.kind === "supply_check" ? t("supplySignal") : t("staffTaskReason");
    const action = experiment ? tExperiment("reportAction") : price ? t("reviewItem", { item: String(task.payload.itemName).split(" · ")[0] }) : task.kind === "staff_coverage" ? t("openStaff") : task.kind === "data_quality" ? t("openBills") : t("openIngredientCosts");
    const selected=task.id===selectedTaskId;
    return <article key={task.id} id={selected?"selected-task":undefined} tabIndex={selected?-1:undefined}
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
        <p className="font-semibold">{tExperiment("recommendation",{choice:tExperiment(
          task.payload.recommendation==="keep"?"keep":task.payload.recommendation==="revert"?"revert":"adjust")})}</p>
        <p className="text-ink-muted">{tExperiment(task.payload.outcomeStatus==="complete"?"reportCompletedCaveat":"reportUncertain")}</p>
      </div>}
      <Link href={taskHref(task)} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-ink px-4 text-center font-bold text-paper no-underline">{action}</Link>
      {price && task.status === "needs_owner" && <PriceReviewActions taskId={task.id} keepLabel={t("keepCurrent")} laterLabel={t("later")} snoozeLabels={{ seven: t("remind7"), thirty: t("remind30"), change: t("remindChange") }} cancelLabel={t("cancel")} errorLabel={t("decisionError")} />}
    </article>;
  })}</section>;
}
