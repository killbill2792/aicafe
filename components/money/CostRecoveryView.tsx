import { ChevronDown, ChevronUp } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import FillIcon from "@/components/icons/FillIcon";
import Money from "@/components/shared/Money";
import TodayAtAGlanceCard from "@/components/shared/TodayAtAGlanceCard";
import { todayGlanceCopy } from "@/components/shared/todayGlanceCopy";
import MonthCalendar from "@/components/money/MonthCalendar";
import { moveRecoveryBucket } from "@/lib/actions/recoveryOrder";
import { formatCents } from "@/lib/calc";
import type { BucketResult } from "@/lib/calc";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import type { BusinessSnapshot } from "@/lib/data/types";
import { getMonthCalendar } from "@/lib/data/getMonthCalendar";
import { RUNNING_COST_CODES } from "@/lib/data/runningCostCatalog";
import { buildCostRecoveryViewModel } from "@/lib/viewmodels/moneyViewModel";
import { buildMonthCalendarViewModel } from "@/lib/viewmodels/monthCalendar";
import { buildTodayGlanceViewModel } from "@/lib/viewmodels/todayGlance";
import { profitTone, profitToneTextClass } from "@/lib/viewmodels/profitTone";

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

export default async function CostRecoveryView({ snapshot, calMonthKey }: { snapshot: BusinessSnapshot; calMonthKey: string }) {
  const t = await getTranslations("Money");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");
  const locale = await getLocale();
  const vm = buildCostRecoveryViewModel(snapshot);
  const labelFor = (code: string) => (code === "yours" ? t("yours") : snapshot.runningCostLines.find((l) => l.categoryCode === code)?.label ?? code);

  const glance = buildTodayGlanceViewModel(snapshot);
  const glanceCopy = todayGlanceCopy(glance, t, tCommon, labelFor);

  const isCurrentMonth = calMonthKey === snapshot.monthKey;
  const monthData = await getMonthCalendar(calMonthKey, snapshot);
  const calendarVm = buildMonthCalendarViewModel({
    monthData,
    recoveryOrder: snapshot.recoveryOrder,
    todayDateStr: snapshot.todayDateStr,
    isCurrentMonth,
    projectedDays: isCurrentMonth ? vm.projectedDays : [],
  });
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(`${calMonthKey}-01T00:00:00`));
  const firstWeekday = new Date(`${calMonthKey}-01T00:00:00`).getDay();
  const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // Jan 4 1970 (UTC) is a Sunday — a stable reference week, indexed 0=Sun..6=Sat.
  const weekdayLabels = Array.from({ length: 7 }, (_, i) => weekdayFormatter.format(new Date(Date.UTC(1970, 0, 4 + i))));
  // The calendar's milestone sentence ("%BUCKET% became fully covered...") must read in the
  // viewer's own language — the English-only RUNNING_COST_LABELS catalog would otherwise leak an
  // English category name into an es/ar sentence.
  const bucketLabels = Object.fromEntries(RUNNING_COST_CODES.map((code) => [code, tCategories(code)]));

  const pace = profitTone(vm.projectedMonthEndProfitCents);
  const paceText =
    pace === "good"
      ? t("paceLeft", { amount: formatCents(vm.projectedMonthEndProfitCents) })
      : pace === "warn"
        ? t("paceShort", { amount: formatCents(Math.abs(vm.projectedMonthEndProfitCents)) })
        : t("paceBreakEven");

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

      <p className={`mx-1.5 text-base leading-snug ${vm.allCovered ? "text-ink" : profitToneTextClass(pace)}`}>
        {vm.allCovered ? (
          <>
            <b>{t("everythingYours")}</b> {t("yoursSoFar", { amount: formatCents(vm.yoursSoFarCents) })}
          </>
        ) : (
          <b>{paceText}</b>
        )}
      </p>

      <section aria-label={t("billsOrderLabel")} className="rounded-card-lg bg-card px-[18px]">
        {vm.buckets.map((bucket, i) => (
          <BucketRow key={bucket.code} bucket={bucket} label={labelFor(bucket.code)} isFirst={i === 0} isLast={i === vm.buckets.length - 1} t={t} />
        ))}
      </section>

      <MonthCalendar
        monthLabel={monthLabel}
        calMonthKey={calMonthKey}
        canGoNext={!isCurrentMonth}
        weekdayLabels={weekdayLabels}
        firstWeekday={firstWeekday}
        cells={calendarVm.cells}
        detailsByDate={calendarVm.detailsByDate}
        coverageSignal={calendarVm.coverageSignal}
        bucketLabels={bucketLabels}
        labels={{
          prevMonth: t("calendarPrevMonth"),
          nextMonth: t("calendarNextMonth"),
          legendGood: t("calendarLegendGood"),
          legendLoss: t("calendarLegendLoss"),
          legendMissing: t("calendarLegendMissing"),
          legendUpcoming: t("calendarLegendUpcoming"),
          noData: t("calendarNoData"),
          milestoneTemplate: t("calendarMilestone"),
          sales: t("sales"),
          ingredients: t("ingredientsAndCups"),
          staff: t("staff"),
          cardFees: t("cardFees"),
          rentAndBills: t("rentAndBills"),
          ownerProfit: t("ownerProfit"),
          estimatePill: t("estimateLower"),
          monthProgress: t("calendarMonthProgress"),
          daysRecorded: t("calendarDaysRecorded"),
          profitableDays: t("calendarProfitableDays"),
          billsCovered: t("calendarBillsCovered"),
          billsProjected: t("calendarBillsProjected"),
          billsNotCovered: t("calendarBillsNotCovered"),
          billsInsufficient: t("calendarBillsInsufficient"),
        }}
      />

      <TodayAtAGlanceCard
        title={t("glanceTitle")}
        stats={[
          { label: t("glanceSales"), value: formatCents(glance.salesCents) },
          { label: t("glanceOrders"), value: String(glance.ordersCount) },
          { label: t("glanceAvgOrder"), value: formatCents(glance.avgOrderValueCents) },
          { label: t("glanceMoneyLeft"), value: formatCents(glance.moneyLeftCents) },
        ]}
        secondaryStat={glance.drinksCount > 0 ? t("glanceDrinks", { count: glance.drinksCount }) : null}
        caption={glanceCopy.caption}
        icon={glanceCopy.icon}
      />

      <details className="rounded-card-lg bg-card p-[18px]">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-bold text-ink">{t("howThisWorks")}</summary>
        <p className="mt-2 text-base leading-relaxed text-ink">{t("howThisWorksBody")}</p>
      </details>
    </div>
  );
}
