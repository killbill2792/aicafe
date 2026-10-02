import { CheckCircle2, Eye, UserRoundCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import AITeamCard from "@/components/operations/AITeamCard";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { getMenuControlCenter } from "@/lib/data/getMenuControlCenter";
import { buildOperationsTeamViewModel } from "@/lib/viewmodels/operationsTeam";
import { formatCents } from "@/lib/calc";

export const dynamic = "force-dynamic";
export default async function OperationsPage() {
  await requireOwnBusiness();
  const [snapshot, menu, t] = await Promise.all([getSnapshot(), getMenuControlCenter(), getTranslations("Operations")]);
  const team = buildOperationsTeamViewModel(snapshot, menu);
  const copy = { title: t("teamTitle"), aiLabel: t("aiLabel"), names: { alex: "Alex", olivia: "Olivia", maya: "Maya", leo: "Leo" }, roles: { alex: t("alexRole"), olivia: t("oliviaRole"), maya: t("mayaRole"), leo: t("leoRole") }, statuses: { prices: t("prices", { count: 0 }), ...Object.fromEntries(team.members.filter(m => m.statusKey === "prices").map(m => [`prices:${m.attentionCount}`, t("prices", { count: m.attentionCount })])), coverage_clear: t("coverageClear"), supplies: t("supplies"), attention: t("attention", { count: 0 }), ...Object.fromEntries(team.members.filter(m => m.statusKey === "attention").map(m => [`attention:${m.attentionCount}`, t("attention", { count: m.attentionCount })])) } };
  return <PageShell className="flex flex-col gap-3.5 px-4 pb-28 pt-6"><header><p className="text-sm font-semibold text-ink-muted">{t("eyebrow")}</p><h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1><p className="mt-1 text-[17px] text-ink-muted">{t("intro")}</p></header><AITeamCard team={team} copy={copy} />
    <InboxSection title={t("needsYou")} empty={t("needsYouEmpty")} icon={<UserRoundCheck aria-hidden="true" />} tasks={team.needsYou.map(task => task.kind === "price_review" ? { agent: "Alex", text: t("priceQuestion", { item: String(task.payload.itemName), current: formatCents(Number(task.payload.currentPriceCents)), suggested: formatCents(Number(task.payload.suggestedPriceCents)) }), detail: t("pricingEvidence") } : { agent: "Leo", text: t("missingCosts", { count: Number(task.payload.missingCostCount) }), detail: String(task.payload.firstMissingCost) })} />
    <InboxSection title={t("handled")} empty={t("handledEmpty")} icon={<CheckCircle2 aria-hidden="true" />} tasks={[]} tone="good" />
    <InboxSection title={t("watching")} empty={t("watchingEmpty")} icon={<Eye aria-hidden="true" />} tasks={team.watching.map(() => ({ agent: "Maya", text: t("mayaWatching"), detail: t("inventoryUnavailable") }))} />
    <p className="rounded-2xl bg-paper p-3 text-sm text-ink-muted">{t("transportUnavailable")}</p>
  </PageShell>;
}
function InboxSection({ title, empty, icon, tasks, tone = "plain" }: { title: string; empty: string; icon: React.ReactNode; tasks: { agent: string; text: string; detail: string }[]; tone?: "plain" | "good" }) { return <section className="rounded-card-lg bg-card p-[18px]"><h2 className={`mb-3 flex items-center gap-2 text-lg font-bold ${tone === "good" ? "text-good" : "text-ink"}`}>{icon}{title}</h2>{tasks.length === 0 ? <p className="text-[17px] text-ink-muted">{empty}</p> : <div className="flex flex-col gap-3">{tasks.map((task, i) => <article key={`${task.agent}-${i}`} className="rounded-2xl border border-line p-4"><p className="text-sm font-bold text-ink-muted">{task.agent} · AI</p><p className="mt-1 text-[17px] font-semibold text-ink">{task.text}</p><p className="mt-1 text-sm text-ink-muted">{task.detail}</p></article>)}</div>}</section>; }
