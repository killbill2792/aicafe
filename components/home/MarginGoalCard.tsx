import { Target } from "lucide-react";
import { Link } from "@/i18n/navigation";

export default function MarginGoalCard({
  currentMargin,
  targetMargin,
  targetIsDefault,
  currentMarginQuality,
  labels,
}: {
  currentMargin: number | null;
  targetMargin: number;
  targetIsDefault: boolean;
  currentMarginQuality: "actual" | "estimated" | "missing";
  labels: {
    title: string;
    current: string;
    target: string;
    unavailable: string;
    defaultLabel: string;
    currentActual: string;
    currentEstimated: string;
    edit: string;
    explanation: string;
  };
}) {
  const percent = (value: number) => `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;

  return (
    <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
      <div className="flex items-center gap-2">
        <Target aria-hidden="true" size={20} className="text-good" />
        <h2 className="text-[17px] font-bold text-ink">{labels.title}</h2>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-paper p-3">
          <span className="block text-xs font-semibold text-ink-muted">{labels.current}</span>
          <strong className="mt-1 block font-headline text-2xl text-ink">
            {currentMargin === null ? labels.unavailable : percent(currentMargin)}
          </strong>
          {currentMargin !== null && (
            <span className="mt-1 block text-[11px] font-bold text-ink-muted">
              {currentMarginQuality === "estimated" ? labels.currentEstimated : labels.currentActual}
            </span>
          )}
        </div>
        <div className="rounded-2xl bg-good-tint p-3">
          <span className="block text-xs font-semibold text-ink-muted">{labels.target}</span>
          <strong className="mt-1 block font-headline text-2xl text-good">{percent(targetMargin)}</strong>
          {targetIsDefault && <span className="mt-1 block text-[11px] font-bold text-ink-muted">{labels.defaultLabel}</span>}
        </div>
      </div>
      <p className="text-sm leading-snug text-ink-muted">{labels.explanation}</p>
      <Link href="/more/economics" className="self-start rounded-full bg-ink px-4 py-2.5 text-sm font-bold text-paper no-underline">
        {labels.edit}
      </Link>
    </section>
  );
}
