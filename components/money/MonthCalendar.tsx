"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import Money from "@/components/shared/Money";
import EstimatePill from "@/components/shared/EstimatePill";
import PlainIcon from "@/components/icons/PlainIcon";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import { profitTone, profitToneBgClass, profitToneTextClass } from "@/lib/viewmodels/profitTone";
import type { DayCell, DayDetail } from "@/lib/viewmodels/monthCalendar";

export type MonthCalendarLabels = {
  prevMonth: string;
  nextMonth: string;
  legendGood: string;
  legendLoss: string;
  legendMissing: string;
  legendUpcoming: string;
  noData: string;
  /** Contains a literal "%BUCKET%" placeholder, filled in client-side per covered bucket. */
  milestoneTemplate: string;
  sales: string;
  ingredients: string;
  staff: string;
  cardFees: string;
  rentAndBills: string;
  ownerProfit: string;
  estimatePill: string;
  monthProgress: string;
  daysRecorded: string;
  profitableDays: string;
};

export default function MonthCalendar({
  monthLabel,
  calMonthKey,
  canGoNext,
  weekdayLabels,
  firstWeekday,
  cells,
  detailsByDate,
  bucketLabels,
  labels,
}: {
  monthLabel: string;
  calMonthKey: string;
  canGoNext: boolean;
  weekdayLabels: string[];
  firstWeekday: number;
  cells: DayCell[];
  detailsByDate: Record<string, DayDetail>;
  bucketLabels: Record<string, string>;
  labels: MonthCalendarLabels;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  function goToMonth(monthKey: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("calMonth", monthKey);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    router.refresh();
    setSelectedDate(null);
  }

  function previousMonthKey(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    const prev = new Date(year, month - 2, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  }
  function nextMonthKey(monthKey: string): string {
    const [year, month] = monthKey.split("-").map(Number);
    const next = new Date(year, month, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  }

  const blanks = Array.from({ length: firstWeekday }, (_, i) => i);
  const selectedDetail = selectedDate ? detailsByDate[selectedDate] : null;
  const recordedDays = cells.filter((cell) => cell.state.kind === "actual").length;
  const profitableDays = cells.filter((cell) => cell.state.kind === "actual" && cell.state.tone === "good").length;
  const elapsedDays = cells.filter((cell) => cell.state.kind !== "projected").length;

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card py-4">
      <div className="flex items-center justify-between px-4">
        <button
          type="button"
          aria-label={labels.prevMonth}
          onClick={() => goToMonth(previousMonthKey(calMonthKey))}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink"
        >
          <ChevronLeft size={20} aria-hidden="true" className="rtl:rotate-180" />
        </button>
        <h2 className="text-lg font-bold text-ink">{monthLabel}</h2>
        <button
          type="button"
          aria-label={labels.nextMonth}
          onClick={() => canGoNext && goToMonth(nextMonthKey(calMonthKey))}
          disabled={!canGoNext}
          className="flex h-12 w-12 items-center justify-center rounded-full text-ink disabled:opacity-30"
        >
          <ChevronRight size={20} aria-hidden="true" className="rtl:rotate-180" />
        </button>
      </div>

      <div className="mx-4 grid grid-cols-2 gap-2 rounded-2xl bg-paper p-3" aria-label={labels.monthProgress}>
        <div>
          <strong className="block font-headline text-2xl text-ink">{recordedDays}/{elapsedDays}</strong>
          <span className="text-sm text-ink-muted">{labels.daysRecorded}</span>
        </div>
        <div className="border-s border-line ps-3">
          <strong className="block font-headline text-2xl text-good">{profitableDays}</strong>
          <span className="text-sm text-ink-muted">{labels.profitableDays}</span>
        </div>
      </div>

      <div className="grid w-full max-w-[420px] self-center grid-cols-7 gap-px text-center text-xs font-bold text-ink-muted">
        {weekdayLabels.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>

      <div className="grid w-full max-w-[420px] self-center grid-cols-7 gap-px">
        {blanks.map((b) => (
          <span key={`blank-${b}`} />
        ))}
        {cells.map((cell) => {
          const milestoneCode = cell.milestoneBucketCodes[0];
          const isSelected = cell.date === selectedDate;
          const clickable = cell.state.kind !== "projected";
          const base = "relative flex aspect-square min-h-12 flex-col items-center justify-center rounded-[10px] text-[13px] font-bold";
          const stateClass =
            cell.state.kind === "actual"
              ? `${profitToneBgClass(cell.state.tone)} text-white`
              : cell.state.kind === "missing"
                ? "border-2 border-dotted border-[#C9BBA6] text-ink-muted"
                : "border-2 border-dashed border-line text-ink-muted opacity-70";
          return (
            <button
              key={cell.date}
              type="button"
              disabled={!clickable}
              aria-pressed={isSelected}
              onClick={() => setSelectedDate(isSelected ? null : cell.date)}
              className={`${base} ${stateClass} ${isSelected ? "ring-2 ring-ink ring-offset-1" : ""}`}
            >
              {cell.day}
              {milestoneCode && (
                <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-card bg-good">
                  <PlainIcon code={milestoneCode as ExpenseIconCode} size={12} color="#fff" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3.5 px-4 text-[13px] font-semibold text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] bg-good" />
          {labels.legendGood}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] bg-warn" />
          {labels.legendLoss}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-dotted border-[#C9BBA6]" />
          {labels.legendMissing}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-dashed border-line" />
          {labels.legendUpcoming}
        </span>
      </div>

      {selectedDetail && (
        <div className="mx-4 flex flex-col gap-2 rounded-2xl bg-[#F7F1E8] p-3.5">
          <span className="text-base font-bold text-ink">
            {new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(new Date(`${selectedDetail.date}T00:00:00`))}
          </span>
          {!selectedDetail.hasData ? (
            <span className="text-sm text-ink-muted">{labels.noData}</span>
          ) : (
            <>
              <DetailRow label={labels.sales} cents={selectedDetail.salesCents} />
              <DetailRow label={labels.ingredients} cents={-selectedDetail.ingredientsCents} />
              <DetailRow label={labels.staff} cents={-selectedDetail.staffCents} />
              <DetailRow label={labels.cardFees} cents={-selectedDetail.cardFeesCents} />
              <DetailRow label={labels.rentAndBills} cents={-selectedDetail.runningCostShareCents} />
              <div className="mt-1 flex items-center justify-between border-t border-line pt-2">
                <span className="flex items-center gap-1.5 text-base font-bold text-ink">
                  {labels.ownerProfit}
                  {selectedDetail.runningCostShareIsEstimate && <EstimatePill label={labels.estimatePill} />}
                </span>
                <span className={`text-lg font-bold ${profitToneTextClass(profitTone(selectedDetail.ownerProfitCents))}`}>
                  <Money cents={selectedDetail.ownerProfitCents} />
                </span>
              </div>
              {selectedDetail.milestoneBucketCodes.map((code) => (
                <p key={code} className="m-0 text-sm font-semibold text-good">
                  {labels.milestoneTemplate.replace("%BUCKET%", bucketLabels[code] ?? code)}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function DetailRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="font-semibold text-ink">
        <Money cents={cents} />
      </span>
    </div>
  );
}
