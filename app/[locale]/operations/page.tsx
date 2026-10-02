import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import AITeamCard, { AgentAvatar, agentIdentity } from "@/components/operations/AITeamCard";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { syncAndGetOperatingTasks } from "@/lib/data/operatingTasks";
import { buildOperationsTeamViewModel, projectOperatingTasks } from "@/lib/viewmodels/operationsTeam";
import { parseAgentId, type AgentId, type OperatingTask } from "@/lib/operating/tasks";
import type { ExpenseCategoryCode } from "@/lib/constants";
import PriceReviewActions from "@/components/operations/PriceReviewActions";
import { missingCostDestination } from "@/lib/expenses/expectedCosts";

export const dynamic = "force-dynamic";
type InboxStatus = "needs_you" | "handled" | "watching";
const parseStatus = (value?: string): InboxStatus => value === "handled" || value === "watching" ? value : "needs_you";

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ agent?: string; status?: string }> }) {
  await requireOwnBusiness();
  const [{ agent, status }, snapshot, menu, t, tCategories] = await Promise.all([searchParams, getSnapshot(), getMenuControlCenter(), getTranslations("Operations"), getTranslations("Categories")]);
  const derived = buildOperationsTeamViewModel(snapshot, menu);
  const persisted = await syncAndGetOperatingTasks([...derived.needsYou, ...derived.handled, ...derived.watching]);
  const team = projectOperatingTasks(persisted.tasks);
  const selectedAgent = parseAgentId(agent);
  const selectedStatus = parseStatus(status);
  const names: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const scoped = (tasks: OperatingTask[]) => selectedAgent ? tasks.filter((task) => task.agentId === selectedAgent) : tasks;
  const lists = { needs_you: scoped(team.needsYou), handled: scoped(team.handled), watching: scoped(team.watching) };
  const copy = { title: t("teamTitle"), aiLabel: t("aiLabel"), brandLabel: t("brandLabel"), names, roles: { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") }, status: (member: (typeof team.members)[number]) => member.statusKey === "prices" ? t("prices", { count: member.attentionCount }) : member.statusKey === "attention" ? t("attention", { count: member.attentionCount }) : member.statusKey === "coverage_clear" ? t("coverageClear") : t("supplies") };

  return <PageShell className="flex flex-col gap-3.5 px-4 pb-28 pt-6" wide>
    <header><p className="text-sm font-semibold text-ink-muted">{t("eyebrow")}</p><h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1><p className="mt-1 text-[17px] text-ink-muted">{selectedAgent ? t("focusedOn", { name: names[selectedAgent], role: copy.roles[selectedAgent] }) : t("intro")}</p></header>
    <nav className="grid grid-cols-3 gap-1 rounded-2xl bg-card p-1" aria-label={t("inboxStatusLabel")}>
      {(["needs_you", "handled", "watching"] as const).map((value) => <Link key={value} href={{ pathname: "/operations", query: { ...(selectedAgent ? { agent: selectedAgent } : {}), status: value } }} aria-current={selectedStatus === value ? "page" : undefined} className={`flex min-h-12 items-center justify-center rounded-xl px-2 text-center text-sm font-bold no-underline ${selectedStatus === value ? "bg-ink text-paper" : "text-ink-muted"}`}>{t(value === "needs_you" ? "needsYou" : value)} {lists[value].length}</Link>)}
    </nav>
    <Link href={{ pathname: "/operations", query: { status: selectedStatus } }} aria-current={!selectedAgent ? "page" : undefined} className={`flex min-h-12 items-center justify-center rounded-full border px-4 font-bold no-underline ${!selectedAgent ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink"}`}>{t("allTeam")}</Link>
    <AITeamCard team={team} copy={copy} selectedAgent={selectedAgent} selectedStatus={selectedStatus} />
    <TaskList tasks={lists[selectedStatus]} empty={t(selectedStatus === "needs_you" ? "needsYouEmpty" : selectedStatus === "handled" ? "handledEmpty" : "watchingEmpty")} names={names} t={t} category={(code) => tCategories(code as ExpenseCategoryCode)} />
    {(!selectedAgent || selectedAgent === "olivia") && <p className="rounded-2xl bg-paper p-3 text-sm text-ink-muted">{t("transportUnavailable")}</p>}
  </PageShell>;
}

function taskHref(task: OperatingTask): string {
  if (task.kind === "price_review" && task.entityId) return `/menu/${encodeURIComponent(task.entityId)}?tab=overview&editPrice=${encodeURIComponent(task.entityId)}`;
  if (task.kind === "staff_coverage") return "/more/manage-staff";
  if (task.kind === "data_quality") return missingCostDestination(String(task.payload.categoryCode) as ExpenseCategoryCode);
  if (task.kind === "money_update") return "/more/bills";
  return "/more/uploads/ingredients";
}

function TaskList({ tasks, empty, names, t, category }: { tasks: OperatingTask[]; empty: string; names: Record<AgentId, string>; t: Awaited<ReturnType<typeof getTranslations<"Operations">>>; category: (code: string) => string }) {
  if (tasks.length === 0) return <section className="rounded-card-lg bg-card p-[18px]"><p className="text-[17px] text-ink-muted">{empty}</p></section>;
  return <section className="grid gap-3 md:grid-cols-2">{tasks.map((task) => {
    const identity = agentIdentity[task.agentId];
    const price = task.kind === "price_review";
    const priceLow = price && Number(task.payload.suggestedPriceCents) > Number(task.payload.currentPriceCents);
    const title = price ? t(priceLow ? "priceTaskLow" : "priceTaskHigh", { item: String(task.payload.itemName) }) : task.kind === "data_quality" ? t("missingCategory", { category: category(String(task.payload.categoryCode)) }) : task.kind === "staff_coverage" ? t("staffTask") : t("mayaWatching");
    const detail = price ? t("priceTaskWhy") : task.kind === "data_quality" ? t("missingCostWhy") : task.kind === "supply_check" ? t("inventoryUnavailable") : t("transportUnavailable");
    const action = price ? t("reviewItem", { item: String(task.payload.itemName).split(" · ")[0] }) : task.kind === "staff_coverage" ? t("openStaff") : task.kind === "data_quality" ? t("addMissingCost") : t("openIngredientCosts");
    return <article key={task.id} data-entity-type={task.entityType} data-entity-id={task.entityId} className={`rounded-card-lg border-s-4 p-[18px] ${identity.border} ${identity.surface}`}>
      <div className="flex items-center gap-2"><AgentAvatar agentId={task.agentId} size="small"/><p className={`font-bold ${identity.text}`}>{names[task.agentId]} · AI</p>{task.payload.pricingIsEstimate === true && <span className="ms-auto"><EstimatePill label={t("estimate")} /></span>}</div>
      <h2 className="mt-3 text-lg font-bold text-ink">{title}</h2><p className="mt-1 text-[17px] font-semibold text-ink">{detail}</p>
      <Link href={taskHref(task)} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-ink px-4 text-center font-bold text-paper no-underline">{action}</Link>
      {price && task.status === "needs_owner" && <PriceReviewActions taskId={task.id} keepLabel={t("keepCurrent")} laterLabel={t("later")} snoozeLabels={{ seven: t("remind7"), thirty: t("remind30"), change: t("remindChange") }} cancelLabel={t("cancel")} errorLabel={t("decisionError")} />}
    </article>;
  })}</section>;
}
