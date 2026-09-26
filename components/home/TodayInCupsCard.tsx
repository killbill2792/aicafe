import type { TodayCupsSlice } from "@/lib/calc";

const SLICE_COLORS = ["#1E6B4B", "#6FA88C", "#9CC4AE", "#C3DED0"];

/** 1 cup icon ≈ 20 cups sold, colored by which bucket (or "yours") that money paid for. */
export default function TodayInCupsCard({
  slices,
  caption,
  legend,
  title,
  perIconLabel,
}: {
  slices: TodayCupsSlice[];
  caption: string;
  legend: { code: string; label: string; color: string }[];
  title: string;
  perIconLabel: string;
}) {
  const cupIcons: { color: string }[] = [];
  slices.forEach((slice, i) => {
    const color = legend.find((l) => l.code === slice.bucketCode)?.color ?? SLICE_COLORS[i % SLICE_COLORS.length];
    const count = Math.max(1, Math.round(slice.cups / 20));
    for (let n = 0; n < count; n++) cupIcons.push({ color });
  });

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      <div className="grid grid-cols-12 gap-1" aria-hidden="true">
        {cupIcons.map((c, i) => (
          <svg key={i} viewBox="0 0 24 24" className="h-auto w-full">
            <use href="#ic-cup" fill={c.color} style={{ "--sil": c.color } as React.CSSProperties} />
          </svg>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[13px] font-semibold text-ink-muted">
        {legend.map((l) => (
          <span key={l.code} className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-[3px]" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span>{perIconLabel}</span>
      </div>
      <p className="m-0 text-[16px] leading-snug text-ink">{caption}</p>
    </section>
  );
}
