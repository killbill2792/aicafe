export function shortWeekday(dateStr: string, locale: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: "short" });
}

export default function StaffCostBars({
  days,
  healthyCents,
  locale,
  todayLabel,
}: {
  days: { date: string; cents: number }[];
  healthyCents: number;
  locale: string;
  todayLabel: string;
}) {
  const maxCents = Math.max(healthyCents, ...days.map((d) => d.cents), 1);
  const healthyPct = Math.min(100, (healthyCents / maxCents) * 100);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative flex h-[150px] items-end gap-2 pt-2.5">
        <div className="absolute inset-x-0 border-t-2 border-dashed border-ink" style={{ bottom: `${healthyPct}%` }} />
        {days.map((d) => {
          const barPct = Math.min(100, (d.cents / maxCents) * 100);
          const high = d.cents > healthyCents;
          return (
            <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className={`whitespace-nowrap text-xs font-bold ${high ? "text-warn" : "text-ink"}`}>{Math.round(d.cents)}¢</span>
              <div className={`w-full rounded-t-md rounded-b-sm ${high ? "bg-warn" : "bg-staff"}`} style={{ height: `${barPct}%` }} />
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 text-center text-xs text-ink-muted">
        {days.map((d, i) => (
          <span key={d.date} className={`min-w-0 flex-1 truncate ${i === days.length - 1 ? "font-bold text-ink" : ""}`}>
            {i === days.length - 1 ? todayLabel : shortWeekday(d.date, locale)}
          </span>
        ))}
      </div>
    </div>
  );
}
