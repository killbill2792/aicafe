import { CheckCircle2, Eye, UserRoundCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import AITeamCard from "@/components/operations/AITeamCard";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { buildOperationsTeamViewModel } from "@/lib/viewmodels/operationsTeam";
import { formatCents } from "@/lib/calc";
import { parseAgentId, type AgentId } from "@/lib/operating/tasks";
import type { ExpenseCategoryCode } from "@/lib/constants";

export const dynamic = "force-dynamic";
export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  await requireOwnBusiness();
  const [{ agent }, snapshot, menu, t, tCategories] = await Promise.all([searchParams, getSnapshot(), getMenuControlCenter(), getTranslations("Operations"), getTranslations("Categories")]);
  const team = buildOperationsTeamViewModel(snapshot, menu);
  const selectedAgent = parseAgentId(agent);
  const names: Record<AgentId, string> = { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" };
  const visibleNeedsYou = selectedAgent ? team.needsYou.filter((task) => task.agentId === selectedAgent) : team.needsYou;
  const visibleWatching = selectedAgent ? team.watching.filter((task) => task.agentId === selectedAgent) : team.watching;
  const copy = { title: t("teamTitle"), aiLabel: t("aiLabel"), names, roles: { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") }, status: (member: (typeof team.members)[number]) => member.statusKey === "prices" ? t("prices", { count: member.attentionCount }) : member.statusKey === "attention" ? t("attention", { count: member.attentionCount }) : member.statusKey === "coverage_clear" ? t("coverageClear") : t("supplies") };
  return <PageShell className="flex flex-col gap-3.5 px-4 pb-28 pt-6"><header><p className="text-sm font-semibold text-ink-muted">{t("eyebrow")}</p><h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1><p className="mt-1 text-[17px] text-ink-muted">{selectedAgent ? t("focusedOn", { name: names[selectedAgent], role: copy.roles[selectedAgent] }) : t("intro")}</p></header><AITeamCard team={team} copy={copy} />
    <InboxSection title={t("needsYou")} empty={t("needsYouEmpty")} icon={<UserRoundCheck aria-hidden="true" />} estimateLabel={t("estimate")} tasks={visibleNeedsYou.map(task => task.kind === "price_review" ? { agent: "Alex", text: t("priceQuestion", { item: String(task.payload.itemName), current: formatCents(Number(task.payload.currentPriceCents)), suggested: formatCents(Number(task.payload.suggestedPriceCents)) }), detail: task.payload.pricingIsEstimate === true ? t("benchmarkPricingEvidence") : t("businessPricingEvidence"), estimate: task.payload.pricingIsEstimate === true } : { agent: "Leo", text: t("missingCosts", { count: Number(task.payload.missingCostCount) }), detail: tCategories(String(task.payload.firstMissingCostCode) as ExpenseCategoryCode), estimate: false })} />
    <InboxSection title={t("handled")} empty={t("handledEmpty")} icon={<CheckCircle2 aria-hidden="true" />} tasks={[]} tone="good" />
    <InboxSection title={t("watching")} empty={t("watchingEmpty")} icon={<Eye aria-hidden="true" />} tasks={visibleWatching.map(() => ({ agent: "Maya", text: t("mayaWatching"), detail: t("inventoryUnavailable") }))} />
    {(!selectedAgent || selectedAgent === "olivia") && <p className="rounded-2xl bg-paper p-3 text-sm text-ink-muted">{t("transportUnavailable")}</p>}
  </PageShell>;
}
function InboxSection({ title, empty, icon, tasks, tone = "plain", estimateLabel = "" }: { title: string; empty: string; icon: React.ReactNode; tasks: { agent: string; text: string; detail: string; estimate?: boolean }[]; tone?: "plain" | "good"; estimateLabel?: string }) { return <section className="rounded-card-lg bg-card p-[18px]"><h2 className={`mb-3 flex items-center gap-2 text-lg font-bold ${tone === "good" ? "text-good" : "text-ink"}`}>{icon}{title}</h2>{tasks.length === 0 ? <p className="text-[17px] text-ink-muted">{empty}</p> : <div className="flex flex-col gap-3">{tasks.map((task, i) => <article key={`${task.agent}-${i}`} className="rounded-2xl border border-line p-4"><div className="flex items-center justify-between gap-2"><p className="text-sm font-bold text-ink-muted">{task.agent} · AI</p>{task.estimate && <EstimatePill label={estimateLabel} />}</div><p className="mt-1 text-[17px] font-semibold text-ink">{task.text}</p><p className="mt-1 text-sm text-ink-muted">{task.detail}</p></article>)}</div>}</section>; }
