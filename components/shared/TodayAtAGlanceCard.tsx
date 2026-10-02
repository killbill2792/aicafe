import FillIcon from "@/components/icons/FillIcon";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

export default function TodayAtAGlanceCard({
  title,
  stats,
  secondaryStat,
  caption,
  icon,
}: {
  title: string;
  stats: { label: string; value: string }[];
  /** `drinksCount`, café-specific — shown small and last, never the headline (docs ask: works for
   * cafés, bakeries and restaurants alike, so no stat here can assume a "cup" unit). */
  secondaryStat?: string | null;
  caption: string;
  /** The one meaningful visual for the whole card — omitted entirely rather than shown empty when
   * there's no single current bill to point at (everything's covered, or no bills are set up yet). */
  icon?: { code: ExpenseIconCode; pctCovered: number } | null;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-0.5 rounded-2xl bg-[#F7F1E8] p-3">
            <span className="text-[13px] font-semibold text-ink-muted">{s.label}</span>
            <span className="break-words text-lg font-extrabold text-ink">{s.value}</span>
          </div>
        ))}
        {secondaryStat && <div className="col-span-2 px-1 text-[13px] font-semibold text-ink-muted">{secondaryStat}</div>}
      </div>
      <div className="flex items-center gap-3.5">
        {icon && <FillIcon code={icon.code} pctCovered={icon.pctCovered} size={64} />}
        <p className="m-0 flex-1 text-[16px] leading-snug text-ink">{caption}</p>
      </div>
    </section>
  );
}
