import { ChevronDown, ChevronUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import FillIcon from "@/components/icons/FillIcon";
import Money from "@/components/shared/Money";
import TodayInCupsCard from "@/components/home/TodayInCupsCard";
import MonthCalendarStrip from "@/components/money/MonthCalendarStrip";
import { moveRecoveryBucket } from "@/lib/actions/recoveryOrder";
import { computeTodayInCups, formatCents } from "@/lib/calc";
import type { BucketResult } from "@/lib/calc";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import type { BusinessSnapshot } from "@/lib/data/types";
import { dayContributionCents, recoveryBuckets } from "@/lib/viewmodels/costRecoveryShared";
import { buildCostRecoveryViewModel } from "@/lib/viewmodels/moneyViewModel";

function shortDate(iso: string) {
  const [, month, day] = iso.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1]} ${Number(day)}`;
}

function BucketRow({
  bucket,
  label,
  isFirst,
  isLast,
  t,
}: {
  bucket: BucketResult;
  label: string;
  isFirst: boolean;
  isLast: boolean;
  t: Awaited<ReturnType<typeof getTranslations<"Money">>>;
}) {
  const covered = bucket.pctCovered >= 100;
  return (
    <div className="flex items-center gap-3.5 border-b border-[#EFE7DB] py-3.5 last:border-b-0">
      <FillIcon code={bucket.code as ExpenseIconCode} pctCovered={bucket.pctCovered} covered={covered} size={52} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <span className="break-words text-[17px] font-bold text-ink">{label}</span>
          <span className="break-words text-[17px] font-bold text-ink">
            <Money cents={bucket.amountCents} />
          </span>
        </div>
        {covered ? (
          <span className="text-sm font-bold text-good">
            {bucket.coveredOn ? t("coveredOnDate", { date: shortDate(bucket.coveredOn) }) : t("covered")}
          </span>
        ) : bucket.pctCovered > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="h-2.5 rounded-full bg-[#E7DFD3]">
              <div className="h-2.5 rounded-full bg-good" style={{ width: `${bucket.pctCovered}%` }} />
            </div>
            <span className="text-[13px] font-semibold text-ink">
              {t("paidBackToGo", { pct: Math.round(bucket.pctCovered), amount: formatCents(bucket.centsToGo) })}
            </span>
          </div>
        ) : (
          <span className="text-sm font-semibold text-ink-muted">
            {bucket.projectedCoveredOn ? t("likelyDate", { date: shortDate(bucket.projectedCoveredOn) }) : t("waiting")}
            {bucket.isEstimate ? ` · ${t("estimateLower")}` : ""}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col">
        <form action={moveRecoveryBucket.bind(null, "up", bucket.code)}>
          <button
            type="submit"
            disabled={isFirst}
            aria-label={t("moveEarlier", { label })}
            className="flex h-6 w-9 items-center justify-center text-[#B7A994] disabled:opacity-30"
          >
            <ChevronUp size={18} aria-hidden="true" />
          </button>
        </form>
        <form action={moveRecoveryBucket.bind(null, "down", bucket.code)}>
          <button
            type="submit"
            disabled={isLast}
            aria-label={t("moveLater", { label })}
            className="flex h-6 w-9 items-center justify-center text-[#B7A994] disabled:opacity-30"
          >
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        </form>
      </div>
    </div>
  );
}

export default async function CostRecoveryView({ snapshot }: { snapshot: BusinessSnapshot }) {
  const t = await getTranslations("Money");
  const vm = buildCostRecoveryViewModel(snapshot);
  const labelFor = (code: string) => snapshot.runningCostLines.find((l) => l.categoryCode === code)?.label ?? code;

  const buckets = recoveryBuckets(snapshot);
  const today = snapshot.latestDay;
  const daysBeforeToday = snapshot.monthActualDays.slice(0, -1);
  const cumulativeBeforeToday = daysBeforeToday.reduce((sum, d) => sum + dayContributionCents(d), 0);
  const todayInCups = computeTodayInCups({
    cupsToday: today.drinksCount,
    contributionCentsToday: dayContributionCents(today),
    cumulativeBeforeToday,
    buckets,
  });

  const heroIcon = vm.buckets[0];
  const totalCentsToGo = vm.buckets.reduce((s, b) => s + b.centsToGo, 0);
  const totalPaidBackCents = Math.max(0, vm.totalCents - totalCentsToGo);
  const overallPctCovered = vm.totalCents === 0 ? 100 : (totalPaidBackCents / vm.totalCents) * 100;

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-wrap items-center gap-4 rounded-card-lg bg-card p-5">
        {heroIcon && <FillIcon code={heroIcon.code as ExpenseIconCode} pctCovered={overallPctCovered} size={104} covered={vm.allCovered} />}
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <span className="text-[15px] font-semibold text-ink-muted">{vm.allCovered ? t("sinceCovered") : t("thisMonthsBills")}</span>
          <span className="whitespace-nowrap font-headline text-[40px] font-bold leading-none">
            <Money cents={totalPaidBackCents} />
          </span>
          <span className="text-[15px] font-semibold">{t("paidBackOf", { amount: formatCents(vm.totalCents) })}</span>
          {!vm.allCovered && vm.buckets[vm.buckets.length - 1]?.projectedCoveredOn && (
            <span className="text-sm font-bold text-good">
              {t("allCoveredBy", { date: shortDate(vm.buckets[vm.buckets.length - 1].projectedCoveredOn!) })}
            </span>
          )}
        </div>
      </section>

      <p className="mx-1.5 text-base leading-snug text-ink">
        {vm.allCovered ? (
          <>
            <b>{t("everythingYours")}</b> {t("yoursSoFar", { amount: formatCents(vm.yoursSoFarCents) })}
          </>
        ) : (
          <>
            {t("onTrackFor")} <b><Money cents={vm.projectedMonthEndProfitCents} /></b> {t("inYourPocket")}
          </>
        )}
      </p>

      <section aria-label={t("billsOrderLabel")} className="rounded-card-lg bg-card px-[18px]">
        {vm.buckets.map((bucket, i) => (
          <BucketRow key={bucket.code} bucket={bucket} label={labelFor(bucket.code)} isFirst={i === 0} isLast={i === vm.buckets.length - 1} t={t} />
        ))}
      </section>

      <MonthCalendarStrip
        days={vm.calendarDays}
        monthKey={vm.monthKey}
        title={t("yourMonth")}
        legend={{ bills: t("paidYourBills"), likelyBills: t("likelyBills"), likelyYours: t("likelyYours") }}
      />

      <TodayInCupsCard
        title={t("todayInCupsTitle")}
        perIconLabel={t("perIcon")}
        slices={todayInCups.slices}
        legend={todayInCups.slices.map((s, i) => ({
          code: s.bucketCode,
          label: s.bucketCode === "yours" ? t("yours") : labelFor(s.bucketCode),
          color: ["#1E6B4B", "#6FA88C", "#9CC4AE"][i % 3],
        }))}
        caption={
          todayInCups.allYours
            ? t("everyCupYours")
            : t("todayInCupsCaption", {
                cups: today.drinksCount,
                amount: formatCents(todayInCups.slices.reduce((s, x) => s + x.cents, 0)),
              })
        }
      />

      <details className="rounded-card-lg bg-card p-[18px]">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-bold text-ink">{t("howThisWorks")}</summary>
        <p className="mt-2 text-base leading-relaxed text-ink">{t("howThisWorksBody")}</p>
      </details>
    </div>
  );
}
