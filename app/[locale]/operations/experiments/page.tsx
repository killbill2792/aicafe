import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import EstimatePill from "@/components/shared/EstimatePill";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { readSupervisorCafeIdentity } from "@/lib/ai/cafeTools.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readExperiments } from "@/lib/operating/experiments.server";
import type { ExperimentEntry, ExperimentsList } from "@/lib/operating/experiments";
import { boardHref } from "@/lib/operating/board";
import { formatCafeCurrency } from "@/lib/format/cafeCurrency";
import { formatInboxDay } from "@/lib/operating/inboxLifecycle";

export const dynamic = "force-dynamic";
type T = Awaited<ReturnType<typeof getTranslations<"Experiments">>>;
type Fmt = { money: (cents: number) => string; day: (date: string) => string; n: (value: number) => string };

export default async function ExperimentsPage() {
  const user = await requireOwnBusiness();
  const [t, locale] = await Promise.all([getTranslations("Experiments"), getLocale()]);
  let list: ExperimentsList | null = null;
  let currency: string | null = null;
  try {
    if (!user) throw new Error("signed_out");
    const businessId = await getActiveBusinessId(user.id);
    const identity = await readSupervisorCafeIdentity(businessId);
    currency = identity.currency;
    list = await readExperiments(await createServerSupabaseClient(), { businessId, ownerUserId: user.id }, identity.asOf);
  } catch {
    console.error("experiments.read_failed");
  }
  const fmt: Fmt = {
    money: (cents) => formatCafeCurrency(cents, locale, currency).text,
    day: (date) => formatInboxDay(date, locale),
    n: (value) => new Intl.NumberFormat(locale).format(value),
  };
  return <PageShell className="flex flex-col gap-4 px-4 pb-28 pt-6">
    <header>
      <Link href="/operations" className="flex min-h-12 items-center text-[17px] font-semibold text-accent-text underline">← {t("back")}</Link>
      <h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1>
      <p className="mt-1 text-[17px] text-ink-muted">{t("intro")}</p>
    </header>
    {list === null
      ? <p role="alert" className="rounded-card-lg bg-card p-[18px] text-[17px] text-ink">{t("unavailable")}</p>
      : <>
        <Section title={t("running")} empty={t("emptyRunning")} entries={list.running} t={t} fmt={fmt} />
        <Section title={t("past")} empty={t("emptyPast")} entries={list.past} t={t} fmt={fmt} />
      </>}
  </PageShell>;
}

function Section({ title, empty, entries, t, fmt }: { title: string; empty: string; entries: ExperimentEntry[]; t: T; fmt: Fmt }) {
  return <section className="flex flex-col gap-3" aria-label={title}>
    <h2 className="font-headline text-2xl font-bold text-ink">{title} {entries.length}</h2>
    {entries.length === 0
      ? <p className="rounded-card-lg bg-card p-[18px] text-[17px] text-ink-muted">{empty}</p>
      : entries.map((entry) => <ExperimentCard key={entry.proposalId} entry={entry} t={t} fmt={fmt} />)}
  </section>;
}

function stageText(e: ExperimentEntry, t: T, fmt: Fmt): string {
  const range = e.startDate && e.endDate ? t("range", { start: fmt.day(e.startDate), end: fmt.day(e.endDate) }) : "";
  if (e.stage === "waitingOnOwner") return t("stageWaiting");
  if (e.stage === "awaitingReport") return t("stageAwaitingReport", { end: e.endDate ? fmt.day(e.endDate) : "" });
  if (e.stage === "finished") return t("stageFinished", { range });
  if (e.day !== null && e.day >= 1 && e.days) return t("stageDay", { day: fmt.n(e.day), days: fmt.n(e.days), range });
  return t("stageStarts", { start: e.startDate ? fmt.day(e.startDate) : "" });
}

function ExperimentCard({ entry: e, t, fmt }: { entry: ExperimentEntry; t: T; fmt: Fmt }) {
  const price = e.kind === "price" && e.oldPriceCents !== null && e.newPriceCents !== null;
  const v = e.verdict;
  return <article id={"experiment-" + e.proposalId} data-experiment-stage={e.stage}
    className="scroll-mt-24 rounded-card-lg border border-line bg-card p-[18px]">
    <h3 className="text-lg font-bold text-ink" dir="auto">{price
      ? t("priceTitle", { item: e.title, old: fmt.money(e.oldPriceCents!), new: fmt.money(e.newPriceCents!) })
      : t("goalTitle", { title: e.title })}</h3>
    <p className="mt-1 text-[17px] font-semibold text-ink">{stageText(e, t, fmt)}</p>
    <dl className="mt-3 grid gap-2 text-[17px]">
      <div><dt className="font-semibold text-ink-muted">{t("goalLabel")}</dt>
        <dd dir="auto">{price ? t("priceGoal", { item: e.title, new: fmt.money(e.newPriceCents!) }) : e.title}</dd></div>
      {price && <div><dt className="font-semibold text-ink-muted">{t("beforeAfter")}</dt>
        <dd>{t("beforeAfterValue", { old: fmt.money(e.oldPriceCents!), new: fmt.money(e.newPriceCents!) })}</dd></div>}
      {(e.baselineUnits7Days !== null || e.estimatedRevenueCents !== null) && <div><dt className="font-semibold text-ink-muted">{t("baseline")}</dt>
        <dd className="flex flex-col gap-1">
          {e.baselineUnits7Days !== null && <span>{t("baselineUnits", { units: fmt.n(e.baselineUnits7Days) })}</span>}
          {e.estimatedRevenueCents !== null && <span className="flex flex-wrap items-center gap-2">
            {t("baselineEstimate", { amount: fmt.money(e.estimatedRevenueCents) })}<EstimatePill label={t("estimate")} /></span>}
        </dd></div>}
    </dl>
    {e.overlapsWith.length > 0 && <p role="note" className="mt-3 rounded-xl border border-amber-300 p-3 text-[17px] font-semibold text-ink">{t("overlap")}</p>}
    <h4 className="mt-4 font-bold text-ink">{t("daily")}</h4>
    {e.samples.length === 0
      ? <p className="mt-1 text-[17px] text-ink-muted">{t("noSamples")}</p>
      : <table className="mt-1 w-full text-start text-[17px]">
        <thead><tr className="text-ink-muted"><th className="text-start font-semibold">{t("colDay")}</th>
          <th className="text-start font-semibold">{t("colSold")}</th><th className="text-start font-semibold">{t("colSales")}</th></tr></thead>
        <tbody>{e.samples.map((s) => <tr key={s.date} data-sample-date={s.date}>
          <td>{fmt.day(s.date)}</td>
          <td>{s.units === null ? t("notIn") : fmt.n(s.units)}</td>
          <td>{s.netSalesCents === null ? t("notIn") : fmt.money(s.netSalesCents)}{s.coverage !== "actual" && <span className="ms-1 text-ink-muted">({t(s.coverage === "provisional" ? "provisional" : "partial")})</span>}</td>
        </tr>)}</tbody>
      </table>}
    {v && <div className="mt-4 rounded-xl bg-paper p-3 text-[17px]" data-verdict={v.recommendation ?? v.status}>
      <p className="font-bold text-ink">{v.status === "insufficient_evidence" ? t("verdictInsufficient")
        : e.kind === "goal" ? t(v.goalMet === true ? "verdictGoalMet" : v.goalMet === false ? "verdictGoalMissed" : "verdictInsufficient")
        : t(v.recommendation === "keep" ? "verdictKeep" : v.recommendation === "revert" ? "verdictRevert" : "verdictAdjust")}</p>
      {v.revenueDifferenceCents !== null && <p>{t("verdictDifference", { amount: fmt.money(v.revenueDifferenceCents) })}</p>}
      {v.coveredDays !== null && e.days && <p className="text-ink-muted">{t("verdictCoverage", { covered: fmt.n(v.coveredDays), days: fmt.n(e.days) })}</p>}
    </div>}
    <Link href={boardHref(e)} className="mt-3 flex min-h-12 items-center text-[17px] font-semibold text-accent-text underline">{t("openThread")}</Link>
  </article>;
}
