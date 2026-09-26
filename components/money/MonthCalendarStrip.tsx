import { getLocale } from "next-intl/server";

type CalendarDay = {
  date: string;
  day: number;
  projected: boolean;
  isYours: boolean;
  coveredBucketCodes: string[];
};

export default async function MonthCalendarStrip({
  days,
  monthKey,
  title,
  legend,
}: {
  days: CalendarDay[];
  monthKey: string;
  title: string;
  legend: { bills: string; likelyBills: string; likelyYours: string };
}) {
  const [year, month] = monthKey.split("-").map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const blanks = Array.from({ length: firstWeekday }, (_, i) => i);
  const locale = await getLocale();
  const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // Jan 4 1970 (UTC) is a Sunday — a stable reference week, indexed 0=Sun..6=Sat.
  const weekdayLabels = Array.from({ length: 7 }, (_, i) => weekdayFormatter.format(new Date(Date.UTC(1970, 0, 4 + i))));

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-bold text-ink-muted">
        {weekdayLabels.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {blanks.map((b) => (
          <span key={`blank-${b}`} />
        ))}
        {days.map((d) => {
          const covered = d.coveredBucketCodes[0];
          const base = "flex aspect-square flex-col items-center justify-center rounded-[10px] text-[13px] font-bold";
          if (!d.projected) {
            return (
              <div key={d.date} className={`${base} bg-good text-white`}>
                {d.day}
                {covered && (
                  <svg viewBox="0 0 48 48" className="mt-0.5 h-4 w-4">
                    <use href={`#ic-${covered}`} fill="#fff" style={{ "--detail": "#1E6B4B" } as React.CSSProperties} />
                  </svg>
                )}
              </div>
            );
          }
          if (!d.isYours) {
            return (
              <div key={d.date} className={`${base} border-2 border-dashed border-good text-good`}>
                {d.day}
                {covered && (
                  <svg viewBox="0 0 48 48" className="mt-0.5 h-4 w-4">
                    <use href={`#ic-${covered}`} fill="#1E6B4B" style={{ "--sil": "#1E6B4B" } as React.CSSProperties} />
                  </svg>
                )}
              </div>
            );
          }
          return (
            <div key={d.date} className={`${base} border-2 border-dashed border-[#C9BBA6] text-ink-muted`}>
              {d.day}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3.5 text-[13px] font-semibold text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] bg-good" />
          {legend.bills}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-dashed border-good" />
          {legend.likelyBills}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-dashed border-[#C9BBA6]" />
          {legend.likelyYours}
        </span>
      </div>
    </section>
  );
}

export type { CalendarDay };
